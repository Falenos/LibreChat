"""Phase 2 — downstream RAG quality.

For each strategy's extracted text we: chunk -> embed (Azure OpenAI) -> cosine-retrieve
top-k per question -> answer with the judge LLM -> score the answer.

Scoring backend is pluggable (config `rag.backend`):
  - lite  : built-in LLM-judge (faithfulness / answer_correctness / context_relevance), no extra deps.
  - ragas : the RAGAS library (faithfulness, answer_correctness, context_precision/recall).
  - auto  : use ragas if importable, else lite (default).

On any RAGAS error we fall back to lite for that strategy and record it in `rag_backend`.
Gated behind run.py --phase2 + corpus/qa/<stem>.yaml. Dependency-light by default.
"""
from __future__ import annotations

import json
import os


def _chunk(text: str, size: int, overlap: int) -> list[str]:
    text = text or ""
    if len(text) <= size:
        return [text] if text.strip() else []
    out, i = [], 0
    while i < len(text):
        out.append(text[i : i + size])
        i += max(1, size - overlap)
    return [c for c in out if c.strip()]


def _embed(client, deployment: str, texts: list[str]):
    import numpy as np

    vecs = []
    for i in range(0, len(texts), 64):
        resp = client.embeddings.create(model=deployment, input=texts[i : i + 64])
        vecs.extend(d.embedding for d in resp.data)
    arr = np.array(vecs, dtype="float32")
    arr /= np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
    return arr


def _select_backend(cfg: dict) -> str:
    backend = ((cfg or {}).get("rag", {}) or {}).get("backend", "auto")
    if backend == "auto":
        try:
            import ragas  # noqa: F401

            return "ragas"
        except Exception:  # noqa: BLE001
            return "lite"
    return backend


def evaluate(strategy_texts: dict, qa_items: list[dict], cfg: dict, judge) -> dict:
    """strategy_texts: {strategy: concatenated_markdown}; qa_items: [{question, answer}].
    Returns {strategy: {rag_*: mean, rag_backend: ...}}."""
    if not judge.available:
        return {s: {"rag_error": "judge unavailable"} for s in strategy_texts}
    try:
        import numpy  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return {s: {"rag_error": f"numpy required: {e}"} for s in strategy_texts}

    rcfg = (cfg or {}).get("rag", {}) or {}
    emb_dep = (
        rcfg.get("embeddings_deployment")
        or os.getenv("EMBEDDINGS_MODEL")
        or "text-embedding-3-small"
    )
    k = int(rcfg.get("top_k", 4))
    size, overlap = int(rcfg.get("chunk_size", 1000)), int(rcfg.get("chunk_overlap", 200))
    backend = _select_backend(cfg)

    results = {}
    for strat, text in strategy_texts.items():
        try:
            records = _retrieve_and_answer(judge, emb_dep, k, size, overlap, text, qa_items)
        except Exception as e:  # noqa: BLE001
            results[strat] = {"rag_error": f"retrieve/answer failed: {e}"}
            continue
        if not records:
            results[strat] = {"rag_error": "no text to index"}
            continue
        if backend == "ragas":
            try:
                scores = _score_ragas(records, judge, emb_dep)
                scores["rag_backend"] = "ragas"
            except Exception as e:  # noqa: BLE001 — degrade, don't fail the run
                scores = _score_lite(judge, records)
                scores["rag_backend"] = f"lite (ragas failed: {type(e).__name__}: {e})"
        else:
            scores = _score_lite(judge, records)
            scores["rag_backend"] = "lite"
        results[strat] = scores
    return results


def _retrieve_and_answer(judge, emb_dep, k, size, overlap, text, qa_items) -> list[dict]:
    import numpy as np

    chunks = _chunk(text, size, overlap)
    if not chunks:
        return []
    cvecs = _embed(judge._client, emb_dep, chunks)
    records = []
    for qa in qa_items:
        q = qa["question"]
        qv = _embed(judge._client, emb_dep, [q])[0]
        top = np.argsort(-(cvecs @ qv))[:k]
        contexts = [chunks[i] for i in top]
        answer = _answer(judge, q, "\n---\n".join(contexts))
        records.append(
            {"question": q, "contexts": contexts, "answer": answer,
             "reference": qa.get("answer", "")}
        )
    return records


# -- lite backend -----------------------------------------------------------
_SCORE_SYS = (
    "Score a RAG answer. Given the QUESTION, the REFERENCE answer, the RETRIEVED CONTEXT, "
    "and the MODEL ANSWER, reply STRICT JSON: "
    '{"faithfulness":0-1,"answer_correctness":0-1,"context_relevance":0-1}. '
    "faithfulness=answer supported by context; answer_correctness=matches reference; "
    "context_relevance=retrieved context is on-topic for the question."
)


def _score_lite(judge, records: list[dict]) -> dict:
    axes = {"faithfulness": [], "answer_correctness": [], "context_relevance": []}
    for r in records:
        v = _score_one(judge, r["question"], r["reference"], "\n---\n".join(r["contexts"]), r["answer"])
        for key in axes:
            if key in v:
                axes[key].append(float(v[key]))
    return {f"rag_{key}": round(sum(v) / len(v), 3) for key, v in axes.items() if v}


def _answer(judge, question: str, context: str) -> str:
    resp = judge._client.chat.completions.create(
        model=judge.deployment,
        messages=[
            {"role": "system", "content": "Answer ONLY from the provided context. "
             "If the context lacks the answer, say you don't know."},
            {"role": "user", "content": f"CONTEXT:\n{context[:12000]}\n\nQUESTION: {question}"},
        ],
        temperature=0,
    )
    return resp.choices[0].message.content


def _score_one(judge, question, reference, context, answer) -> dict:
    resp = judge._client.chat.completions.create(
        model=judge.deployment,
        messages=[
            {"role": "system", "content": _SCORE_SYS},
            {"role": "user", "content": json.dumps({
                "question": question, "reference": reference,
                "context": context[:12000], "answer": answer,
            })},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    try:
        return json.loads(resp.choices[0].message.content)
    except Exception:  # noqa: BLE001
        return {}


# -- ragas backend (opt-in) -------------------------------------------------
def _score_ragas(records: list[dict], judge, emb_dep: str) -> dict:
    """Run RAGAS over the (question, contexts, answer, reference) records using Azure OpenAI.
    Written for ragas 0.2.x; isolated so version churn can't break the default (lite) path."""
    from langchain_openai import AzureChatOpenAI, AzureOpenAIEmbeddings
    from ragas import EvaluationDataset
    from ragas import evaluate as ragas_evaluate
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper
    from ragas.metrics import (
        answer_correctness,
        context_precision,
        context_recall,
        faithfulness,
    )

    endpoint = getattr(judge, "endpoint", "") or os.getenv("AZURE_OPENAI_API_ENDPOINT", "")
    key = os.getenv("AZURE_OPENAI_API_KEY", "")
    llm = LangchainLLMWrapper(
        AzureChatOpenAI(azure_endpoint=endpoint, api_key=key, api_version=judge.api_version,
                        azure_deployment=judge.deployment, temperature=0)
    )
    emb = LangchainEmbeddingsWrapper(
        AzureOpenAIEmbeddings(azure_endpoint=endpoint, api_key=key,
                              api_version=judge.api_version, azure_deployment=emb_dep)
    )
    ds = EvaluationDataset.from_list([
        {"user_input": r["question"], "retrieved_contexts": r["contexts"],
         "response": r["answer"], "reference": r["reference"]}
        for r in records
    ])
    res = ragas_evaluate(
        ds,
        metrics=[faithfulness, answer_correctness, context_precision, context_recall],
        llm=llm,
        embeddings=emb,
    )
    df = res.to_pandas()
    out = {}
    for col in ["faithfulness", "answer_correctness", "context_precision", "context_recall"]:
        if col in df.columns:
            out[f"rag_{col}"] = round(float(df[col].mean()), 3)
    return out

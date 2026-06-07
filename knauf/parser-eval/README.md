# Parser-eval — compare document parsing strategies

Benchmarks document parsers for KARL's RAG file-search pipeline: **Azure Document
Intelligence** (current), the **current upstream loaders** (PyPDF / Docx2txt / Unstructured*),
and **liteparse**. It runs each strategy over a categorized corpus, **stores every raw
output**, and scores them with industry-standard metrics.

Modeled on [OmniDocBench](https://github.com/opendatalab/OmniDocBench) (categorized corpus),
with **CER/WER + TEDS** classic metrics and an **LLM-as-judge** (the highest human-correlation
method per [SCORE-Bench](https://unstructured.io/blog/introducing-score-bench-an-open-benchmark-for-document-parsing)),
plus a Phase-2 **RAG-quality** layer.

## What it measures

| Layer | Metric | Needs |
|---|---|---|
| Operational | seconds/page, $/page, failure rate | — |
| Extraction (reference-free) | LLM-as-judge rubric (completeness, table fidelity, reading order, cleanliness) + pairwise A/B | `AZURE_OPENAI_API_KEY` |
| Extraction (vs ground truth) | CER, WER, normalized edit similarity, **TEDS** (tables) | `corpus/ground_truth/<stem>.md` |
| Phase 2 — RAG quality | faithfulness, answer_correctness, context_relevance | `--phase2` + `corpus/qa/<stem>.yaml` |

## Metrics explained

| Metric | Range / dir | What it is | Needs |
|---|---|---|---|
| **CER** / **WER** | 0+, ↓ better | Character / Word Error Rate vs the ground-truth markdown (jiwer; whitespace-normalized) — edit distance ÷ reference length. | `ground_truth/<stem>.md` |
| **norm_edit_sim** | 0–1, ↑ better | Normalized Levenshtein similarity to ground truth (rapidfuzz). | `ground_truth/<stem>.md` |
| **TEDS** | 0–1, ↑ better | Tree-Edit-Distance Similarity on tables — the PubTabNet/OmniDocBench standard for **table-structure fidelity**. `None` = neither side had a table. | `ground_truth/<stem>.md` with tables |
| **judge_completeness / table_fidelity / reading_order / cleanliness / overall** | 1–5, ↑ better | Vision LLM-as-judge: the model sees the source **page image** + the extracted text and rates faithfulness. Highest correlation with human judgement (SCORE-Bench, r≈0.93). `table_fidelity`=3 when the doc has no tables. | `AZURE_OPENAI_API_KEY` |
| **pairwise win-rate** | 0–1, ↑ better | Fraction of head-to-head A/B comparisons (same judge, same page) a strategy wins. | `AZURE_OPENAI_API_KEY` |
| **Phase-2 RAG** (`rag_*`) | 0–1, ↑ better | Does the parser's text answer questions well? **faithfulness** (answer supported by context), **answer_correctness** (matches reference), **context_relevance / precision / recall**. Backend: lite or RAGAS. | `--phase2` + `corpus/qa/<stem>.yaml` |
| **sec/page · $/page · failures** | ↓ better | Operational: latency, estimated Azure cost, hard errors. | — |

> **Reading the numbers:** for structured output, trust **TEDS + judge** over CER/WER. A parser that emits rich markdown tables (e.g. DI) can show a *higher* CER than one that flattens everything to prose — CER penalizes the extra markup against a plain-text reference even though the structured output is better. A real run here showed exactly that: DI **TEDS 1.0 / judge 5** but **CER 0.77**, vs PyPDF's CER 0.25 with **TEDS 0** (table destroyed).

## Layout

```
adapters/   azure_di.py  upstream.py  liteparse_adapter.py  (+ base.py)
metrics/    text.py  tables.py  llm_judge.py  rag.py
run.py      report.py  common.py  config.yaml  requirements.txt  Dockerfile.eval
corpus/     digital_pdf/ scanned_pdf/ tables/ multicol/ office/   ground_truth/  qa/
runs/       <timestamp>/<strategy>/<doc>.md  +  results.csv  +  report.md   (gitignored)
```

## Corpus

Drop representative documents into the category folders (OmniDocBench-style):
`digital_pdf/`, `scanned_pdf/`, `tables/`, `multicol/`, `office/` (docx/xlsx/pptx).
Optional, per document `<name>.pdf`:
- `corpus/ground_truth/<name>.md` — reference markdown → unlocks CER/WER/TEDS.
- `corpus/qa/<name>.yaml` — `qa: [{question: ..., answer: ...}]` → unlocks Phase 2.

Corpus files are gitignored (may be proprietary/large); only the folder structure is tracked.

## Run

**Docker (recommended — bundles liteparse + LibreOffice/Tesseract):**
```bash
# from repo root
docker build -f knauf/parser-eval/Dockerfile.eval -t knauf/parser-eval knauf/parser-eval
docker run --rm --env-file .env \
  -v "$PWD/knauf/parser-eval/corpus:/eval/corpus" \
  -v "$PWD/knauf/parser-eval/runs:/eval/runs" \
  knauf/parser-eval --strategies azure_di,upstream,liteparse
```

**Local (no liteparse / no LibreOffice):**
```bash
cd knauf/parser-eval
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python run.py --strategies azure_di,upstream      # liteparse needs the Docker image
python run.py --phase2                            # RAG layer (needs corpus/qa/*.yaml)
```

Credentials come from the repo `.env` (`RAG_AZURE_DI_ENDPOINT`/`RAG_AZURE_DI_KEY`,
`AZURE_OPENAI_API_KEY`, `RAG_OPENAI_BASEURL`). `--no-judge` skips the LLM judge.

## Reading the report

`runs/<ts>/report.md` has: per-strategy summary (judge score, CER/TEDS, sec/page, cost,
failures), mean judge score by category, pairwise win-rates, and a failures table. Raw
extracted text per (strategy, doc) is under `runs/<ts>/<strategy>/` for eyeballing/diffing.

## Notes / caveats

- **liteparse** emits plain text (no markdown tables) → it will score lower on `table_fidelity`
  by construction; that's expected, not a bug. The CLI command is configurable in
  `config.yaml` (`liteparse.command`) — adjust to your install's flags. Its OCR needs English
  tessdata, which `Dockerfile.eval` installs (`tesseract-ocr-eng` → `/root/.tesseract-rs/tessdata`,
  `TESSDATA_PREFIX`) — required, or liteparse fails on scanned pages with "Failed to load language 'eng'".
- **Phase-2 RAG backend:** defaults to a built-in lightweight LLM-judge (no extra deps). For
  **RAGAS** (faithfulness / answer_correctness / context_precision / recall): uncomment `ragas` +
  `langchain-openai` in `requirements.txt`, rebuild, and set `rag.backend: auto` (or `ragas`). On any
  RAGAS error the harness auto-falls back to lite (recorded in `rag_backend`).
- **Judge cost/variance:** vision judging uses tokens; verdicts are cached in `.judge_cache/`
  keyed by content hash, and the model is pinned in `config.yaml` for run-to-run comparability.
- **Fairness (Phase 2):** identical chunking/embedding/k across strategies — only the parser varies.
- **Adding a strategy** (Docling/MinerU/Marker/…): add `adapters/<name>.py` implementing
  `_extract()`, register it in `adapters/__init__.py`, add it to `strategies`. No harness changes.
- **DI cost** in `config.yaml` (`cost_per_page_usd`) is an estimate — verify current Azure pricing.

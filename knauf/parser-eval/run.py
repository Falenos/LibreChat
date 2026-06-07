#!/usr/bin/env python3
"""Parser-eval orchestrator: run strategies × corpus, store outputs, score, report.

    cd knauf/parser-eval
    python run.py --strategies azure_di,upstream,liteparse        # Phase 1
    python run.py --phase2                                         # + RAG quality (needs corpus/qa/*.yaml)

Reads RAG_AZURE_DI_* / AZURE_OPENAI_* from the repo .env. Outputs to runs/<timestamp>/.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import report  # noqa: E402
from adapters import build_adapter  # noqa: E402
from common import (  # noqa: E402
    guess_mime,
    ground_truth_path,
    iter_corpus,
    qa_path,
    slugify,
)


def _load_env_and_config(config_path: str) -> dict:
    # Load the repo .env when running from the source tree (<repo>/knauf/parser-eval);
    # harmless if absent (e.g. in the eval container, vars come from the environment).
    try:
        from dotenv import load_dotenv

        if len(HERE.parents) >= 2:
            load_dotenv(HERE.parents[1] / ".env")
        load_dotenv()  # also pick up a local .env if present
    except Exception:  # noqa: BLE001
        pass
    import yaml

    with open(config_path) as fh:
        return yaml.safe_load(fh) or {}


def _short_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(HERE / "corpus"))
    ap.add_argument("--config", default=str(HERE / "config.yaml"))
    ap.add_argument("--strategies", default="", help="csv override of config.strategies")
    ap.add_argument("--out", default=str(HERE / "runs"))
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--phase2", action="store_true", help="also run RAG-quality eval")
    args = ap.parse_args()

    import logging

    logging.getLogger("azure").setLevel(logging.WARNING)  # silence per-request HTTP dumps
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = _load_env_and_config(args.config)
    strategies = (
        [s.strip() for s in args.strategies.split(",") if s.strip()]
        if args.strategies
        else cfg.get("strategies", ["azure_di", "upstream", "liteparse"])
    )
    if args.no_judge:
        cfg.setdefault("judge", {})["enabled"] = False

    run_dir = Path(args.out) / datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"[run] strategies={strategies}  corpus={args.corpus}  out={run_dir}")

    adapters = {s: build_adapter(s, cfg) for s in strategies}
    docs = list(iter_corpus(args.corpus))
    if not docs:
        print(f"[run] no documents under {args.corpus}/<category>/ — add some and re-run.")
        return 1

    # ---- 1) parse: strategy × doc -> raw output + ParseResult ----------------
    results: dict[tuple, object] = {}
    md_by_doc_strat: dict[tuple, str] = {}
    for category, path in docs:
        doc = Path(path).name
        mime = guess_mime(path)
        for strat, adapter in adapters.items():
            res = adapter.parse(path, mime, category=category)
            results[(doc, strat)] = res
            md_by_doc_strat[(doc, strat)] = res.markdown
            out_md = run_dir / strat / f"{category}__{slugify(doc)}.md"
            out_md.parent.mkdir(parents=True, exist_ok=True)
            out_md.write_text(res.markdown or "")
            flag = "OK " if res.ok else ("ERR" if res.error else "EMPTY")
            print(f"  [{flag}] {strat:10s} {category}/{doc}  "
                  f"{res.seconds}s  pages={res.n_pages}  chars={len(res.markdown)}"
                  + (f"  ({res.error})" if res.error else ""))

    rows = [results[k].row() for k in results]

    # ---- 2) classic metrics (only where ground_truth exists) -----------------
    from metrics.tables import teds
    from metrics.text import text_metrics

    by_doc = {}
    for (doc, strat) in results:
        by_doc.setdefault(doc, set()).add(strat)
    gt_cache = {}
    for (doc, strat), res in results.items():
        gt = ground_truth_path(args.corpus, doc)
        if not gt or not res.ok:
            continue
        ref = gt_cache.setdefault(gt, Path(gt).read_text(errors="replace"))
        m = text_metrics(res.markdown, ref)
        t = teds(res.markdown, ref)
        row = next(r for r in rows if r["doc"] == doc and r["strategy"] == strat)
        row.update(m)
        if t is not None:
            row["teds"] = t

    # ---- 3) LLM-as-judge (rubric + pairwise) ---------------------------------
    pairwise_rows = []
    from metrics.llm_judge import JudgeClient, render_pages

    judge = JudgeClient(cfg)
    if not judge.available:
        print(f"[judge] disabled: {judge.reason_unavailable}")
    else:
        for category, path in docs:
            doc = Path(path).name
            images = render_pages(path, judge.max_pages)
            for strat in strategies:
                res = results[(doc, strat)]
                if not res.ok:
                    continue
                ck = f"{doc}|{strat}|{_short_hash(res.markdown)}"
                scores = judge.rubric(images, res.markdown, ck)
                row = next(r for r in rows if r["doc"] == doc and r["strategy"] == strat)
                row.update(scores)
            if cfg.get("judge", {}).get("pairwise", True) and images:
                for a, b in itertools.combinations(strategies, 2):
                    ra, rb = results[(doc, a)], results[(doc, b)]
                    if not (ra.ok and rb.ok):
                        continue
                    ck = f"{doc}|{a}|{b}|{_short_hash(ra.markdown + rb.markdown)}"
                    v = judge.pairwise(images, ra.markdown, rb.markdown, ck)
                    win = {"A": a, "B": b}.get(v.get("winner"), "tie")
                    pairwise_rows.append({"doc": doc, "a": a, "b": b,
                                          "winner": win, "reason": v.get("reason", "")})

    # ---- 4) write results -----------------------------------------------------
    import pandas as pd

    pd.DataFrame(rows).to_csv(run_dir / "results.csv", index=False)
    (run_dir / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    if pairwise_rows:
        pd.DataFrame(pairwise_rows).to_csv(run_dir / "pairwise.csv", index=False)

    # ---- 5) Phase 2: RAG quality ---------------------------------------------
    if args.phase2:
        _run_phase2(args, cfg, docs, md_by_doc_strat, strategies, judge, run_dir)

    # ---- 6) report ------------------------------------------------------------
    report_path = report.generate(str(run_dir))
    print(f"\n[done] outputs in {run_dir}\n[done] report: {report_path}")
    print((run_dir / "report.md").read_text())
    return 0


def _run_phase2(args, cfg, docs, md_by_doc_strat, strategies, judge, run_dir):
    import yaml

    from metrics import rag

    qa_items = []
    for _, path in docs:
        qp = qa_path(args.corpus, Path(path).name)
        if qp:
            data = yaml.safe_load(Path(qp).read_text()) or []
            qa_items.extend(data.get("qa", data) if isinstance(data, dict) else data)
    if not qa_items:
        print("[phase2] no corpus/qa/*.yaml found — skipping RAG eval.")
        return
    # Concatenate each strategy's text across all docs into one corpus per strategy.
    strategy_texts = {
        s: "\n\n".join(md_by_doc_strat[(Path(p).name, s)] for _, p in docs)
        for s in strategies
    }
    print(f"[phase2] scoring RAG over {len(qa_items)} Q&A items...")
    rag_scores = rag.evaluate(strategy_texts, qa_items, cfg, judge)
    (run_dir / "rag.json").write_text(json.dumps(rag_scores, indent=2))
    print("[phase2] rag scores:", json.dumps(rag_scores, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())

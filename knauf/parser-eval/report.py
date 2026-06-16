"""Aggregate a run directory's results.csv (+ pairwise.csv) into report.md.

Usage: python report.py runs/<timestamp>
Also called automatically at the end of run.py.
"""
from __future__ import annotations

import sys
from pathlib import Path


def _fmt(df, **kw):
    from tabulate import tabulate

    return tabulate(df, headers="keys", tablefmt="github", showindex=False, **kw)


def generate(run_dir: str) -> str:
    import pandas as pd

    run = Path(run_dir)
    df = pd.read_csv(run / "results.csv")
    lines = [f"# Parser eval — {run.name}", ""]
    lines.append(f"- documents: **{df['doc'].nunique()}**, strategies: "
                 f"**{', '.join(sorted(df['strategy'].unique()))}**")
    lines.append("")

    # ---- per-strategy summary -------------------------------------------------
    agg = {
        "docs": ("doc", "count"),
        "failures": ("error", lambda s: s.notna().sum()),
        "sec/page": ("sec_per_page", "mean"),
        "cost_usd": ("cost_usd", "sum"),
    }
    for col, label in [
        ("judge_overall", "judge_overall(1-5)"),
        ("cer", "cer"),
        ("wer", "wer"),
        ("teds", "teds"),
    ]:
        if col in df.columns:
            agg[label] = (col, "mean")
    summary = df.groupby("strategy").agg(**agg).reset_index()
    for c in summary.columns:
        if summary[c].dtype.kind == "f":
            summary[c] = summary[c].round(3)
    lines += ["## Per-strategy summary", "", _fmt(summary), ""]

    # ---- per-category judge score --------------------------------------------
    if "judge_overall" in df.columns:
        piv = (
            df.pivot_table(index="category", columns="strategy",
                           values="judge_overall", aggfunc="mean")
            .round(2)
            .reset_index()
        )
        lines += ["## Mean judge_overall by category", "", _fmt(piv), ""]

    # ---- pairwise win-rates ---------------------------------------------------
    pw = run / "pairwise.csv"
    if pw.exists():
        pwd = pd.read_csv(pw)
        wins: dict[str, int] = {}
        games: dict[str, int] = {}
        for _, r in pwd.iterrows():
            a, b, w = r["a"], r["b"], r["winner"]
            for s in (a, b):
                games[s] = games.get(s, 0) + 1
            if w in (a, b):
                wins[w] = wins.get(w, 0) + 1
        rows = [
            {"strategy": s, "wins": wins.get(s, 0), "games": games.get(s, 0),
             "win_rate": round(wins.get(s, 0) / games.get(s, 1), 2)}
            for s in sorted(games)
        ]
        lines += ["## Pairwise win-rate (LLM judge)", "", _fmt(__import__("pandas").DataFrame(rows)), ""]

    # ---- phase 2: RAG quality -------------------------------------------------
    rj = run / "rag.json"
    if rj.exists():
        import json as _json

        data = _json.loads(rj.read_text())
        rrows = [{"strategy": s, **m} for s, m in data.items()]
        lines += ["## Phase 2 — RAG quality (0-1, higher = better)", "",
                  _fmt(pd.DataFrame(rrows)), ""]

    # ---- failures -------------------------------------------------------------
    fails = df[df["error"].notna()][["strategy", "doc", "error"]]
    if len(fails):
        lines += ["## Failures", "", _fmt(fails), ""]

    out = run / "report.md"
    out.write_text("\n".join(lines))
    return str(out)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python report.py runs/<timestamp>")
        raise SystemExit(2)
    print("wrote", generate(sys.argv[1]))

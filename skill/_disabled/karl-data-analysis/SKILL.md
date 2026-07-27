---
name: karl-data-analysis
# 245 chars. The model-visible catalog truncates at 250 — see skill/README.md
# rule 3. Everything this skill *covers* belongs in the body below, not here;
# the description buys trigger words only.
description: >-
  KARL's code-interpreter sandbox for data analysis and file generation. Use
  when running code on attached files, analyzing CSV/Excel/JSON/log data,
  computing statistics, plotting with matplotlib, converting files, or building
  downloadable output.
argument-hint: "[analysis task or file]"
user-invocable: true
version: "1.0.0"
---

# KARL Data Analysis: working the sandbox effectively

Code runs in an isolated sandbox via `bash_tool`. Its description already
covers the basics (stateless calls, no network, `/mnt/data` persistence, files
auto-delivered). This skill adds the environment facts it omits and the
workflow that avoids wasted calls.

## Environment facts

- Runtimes: Python 3.14 (numpy, pandas, matplotlib preinstalled), Node 24, Bun, and standard GNU/bash tools. Nothing else is guaranteed — there is no `pip`/`npm install` and no network egress to fetch anything.
- stdout is capped at roughly 64 KB per call; longer output is truncated.
- Generated files up to ~150 MB each are delivered to the user automatically — never fabricate download links.
- Each call is a fresh process: variables, imports, and env vars do **not** carry over. Only files under `/mnt/data` persist between calls.
- Everything runs as bash. Run Python with a **quoted** heredoc — never bare `python`:

      python3 << 'EOF'
      import pandas as pd
      df = pd.read_csv('/mnt/data/sales.csv')
      print(df.shape)
      EOF

  The quoted `'EOF'` stops bash from mangling `$`, quotes, and backticks inside your Python. (If your deployment exposes a multi-language `execute_code` tool instead of `bash_tool`, the same rules apply with `lang: "py"`.)

## Standard workflow

1. **Locate and inspect before analyzing.** First call: `ls -la /mnt/data` (attachments and prior outputs live there), then for each input print shape, dtypes, `head()`, and null counts, and probe any optional import you plan to rely on (`import openpyxl` for `.xlsx`) inside try/except. Never assume column names, encodings, or delimiters.
2. **Analyze in self-contained steps** — one logical step per call (clean, aggregate, model, chart). Each call re-imports and re-reads its inputs from `/mnt/data`. Pass intermediates between calls as files (parquet/csv), not by assuming state.
3. **Persist deliverables to `/mnt/data`** with real extensions: `.csv` for tables, `.png` for charts, `.xlsx` only when requested, `.json` for structured output, `.md`/`.txt` for reports. Use descriptive names (`revenue_by_region.csv`, not `output1.csv`).
4. **Summarize in chat** — the key numbers, what they mean, and what you produced. Do not paste file contents back into the conversation; delivery is automatic.

## Output discipline (the ~64 KB cap)

- Print summaries, not data: `df.head(10)`, `df.describe()`, value counts, aggregates. Never print a whole DataFrame or file.
- If a result is bigger than a screenful, it is a **file**, not stdout: write it to `/mnt/data` and print only its path plus a 3–5 line preview.
- Silence reads as failure — a call that prints nothing returns empty stdout. Always print at least a confirmation of what was done and written.

## Charts

- The backend is headless: `plt.show()` does nothing. Always `plt.savefig('/mnt/data/<name>.png', dpi=150, bbox_inches='tight')` then `plt.close()`.
- One chart per file, titled and axis-labeled; print one line per chart saved. The PNG renders inline in chat automatically.
- Prefer saving prepared data to `/mnt/data` first so a plotting tweak doesn't recompute everything.

## Failure and rerun rules

- A failed call registers **no** files — even ones written before the error. Fix the error and rerun the entire step; never assume partial outputs exist.
- Write steps to be idempotent (safe to rerun: overwrite outputs, don't blindly append).
- `/tmp` and odd extensions are same-call scratch only; anything a later call needs goes to `/mnt/data` with a standard extension.
- Missing library (seaborn, scipy, sklearn, openpyxl, …)? Do not attempt installation — it will fail. Say what's missing and solve it with pandas/numpy/stdlib (matplotlib instead of seaborn; `csv` instead of `xlsx` when openpyxl is absent).

## Tool choice

- `bash_tool` + python heredoc → all analysis, transforms, plotting.
- `bash_tool` plain bash → file discovery and cheap inspection (`ls`, `head`, `wc -l`, `file`, `unzip -l`) and text munging where sed/awk beats pandas.
- `read_file` → re-read a known text file (exact path from earlier output or `/mnt/data`) without burning an execution; it also renders images/PDFs so you can visually check a chart you generated, and reads skill references via `skills/{skillName}/…` paths. It needs exact paths — don't use it to "explore".

## Scope

Use the sandbox for computation on real data. Don't use it to echo prose, to "verify" trivial arithmetic, or to produce content that belongs directly in chat or in an artifact. For interactive visual deliverables, aggregate the data here, then embed the aggregate in a react artifact.

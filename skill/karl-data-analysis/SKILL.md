---
name: karl-data-analysis
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# only; everything this skill *covers* is in the body. Spreadsheets have their
# own skill (karl-xlsx); this is the general "run code on data" umbrella.
description: >-
  KARL's code sandbox for analyzing data and generating files: run code on
  CSV/JSON/log/Parquet data, compute statistics, clean or transform data, plot
  with matplotlib, build downloadable output. For spreadsheets use karl-xlsx.
argument-hint: "[analysis task or file]"
user-invocable: true
allowed-tools:
  - execute_code
version: "2.0.0"
---

# KARL data analysis: working the sandbox effectively

Code runs in an isolated, Microsoft-managed sandbox via `bash_tool`. Its
description already covers the basics (stateless calls, no network,
`/mnt/data` persistence, files auto-delivered). This skill adds the environment
facts it omits and the workflow that avoids wasted calls. For spreadsheet
reading/authoring specifics, read `karl-xlsx`.

## Environment facts (verified)

- **Python 3.12** with a full data stack preinstalled: `pandas`, `numpy`,
  `scipy`, `scikit-learn`, `matplotlib`, `openpyxl`, `xlsxwriter`, `xlrd`,
  `pyxlsb`, `Pillow`, `lxml`, `beautifulsoup4`, `tabulate`, `chardet`. Also on
  `PATH`: `bash` and standard GNU tools, `libreoffice`/`soffice`, `markitdown`,
  `pandoc`.
- **No network egress and no installs.** There is no `pip`/`npm install`; a
  package that isn't in the list above (e.g. `seaborn`, `plotly`) is
  unavailable — solve it with what's present (matplotlib instead of seaborn).
- **Each call is a fresh process.** Variables, imports, and in-memory state do
  **not** carry over between calls. Only files under `/mnt/data` persist.
- **Each call must finish within ~220 seconds** (hard platform limit). Split
  long work into steps that each persist their intermediate results to
  `/mnt/data`.
- **stdout is capped at ~64 KB per call**; longer output is truncated. Large
  results are files, not stdout (see Output discipline).
- **Generated files are delivered to the user automatically** — never fabricate
  download links or paste file contents back.
- Everything runs as bash. Run Python with a **quoted** heredoc — never bare
  `python`:

      python3 << 'PY'
      import pandas as pd
      df = pd.read_csv('/mnt/data/sales.csv')
      print(df.shape)
      PY

  The quoted `'PY'` stops bash from mangling `$`, quotes, and backticks inside
  your Python.

## Standard workflow

1. **Locate and inspect before analyzing.** First call: `ls -la /mnt/data`
   (attachments and prior outputs live there), then for each input print shape,
   dtypes, `head()`, and null counts. Never assume column names, encodings, or
   delimiters — detect them (`chardet` is available for unknown encodings).
2. **Analyze in self-contained steps** — one logical step per call (clean,
   aggregate, model, chart). Each call re-imports and re-reads its inputs from
   `/mnt/data`. Pass intermediates between calls as files (Parquet/CSV), not by
   assuming state survives.
3. **Persist deliverables to `/mnt/data`** with real extensions: `.csv` for
   tables, `.png` for charts, `.xlsx` only when requested, `.json` for
   structured output, `.md`/`.txt` for reports. Use descriptive names
   (`revenue_by_region.csv`, not `output1.csv`).
4. **Summarize in chat** — the key numbers, what they mean, and what you
   produced. Delivery is automatic; don't paste file contents.

## Output discipline (the ~64 KB cap)

- Print summaries, not data: `df.head(10)`, `df.describe()`, value counts,
  aggregates. Never print a whole DataFrame or file.
- If a result is bigger than a screenful, it is a **file**: write it to
  `/mnt/data` and print only its path plus a 3–5 line preview.
- Silence reads as failure — a call that prints nothing returns empty stdout.
  Always print at least a confirmation of what was done and written.

## Charts

- The backend is headless: `plt.show()` does nothing. Always
  `plt.savefig('/mnt/data/<name>.png', dpi=150, bbox_inches='tight')` then
  `plt.close()`. The PNG renders inline in chat automatically.
- One chart per file, titled and axis-labeled; print one line per chart saved.
- For branded/interactive visual deliverables, aggregate the data here, then
  embed the aggregate in a React artifact (see `karl-artifacts`).

## Failure and rerun rules

- A failed call registers **no** files — even ones written before the error.
  Fix the error and rerun the entire step; never assume partial outputs exist.
- Write steps to be idempotent (safe to rerun: overwrite outputs, don't blindly
  append).
- `/tmp` is same-call scratch only; anything a later call needs goes to
  `/mnt/data` with a standard extension.
- Missing a package that isn't preinstalled? Do **not** attempt installation —
  it will fail (no egress). Say what's missing and solve it with the available
  stack.

## Tool choice

- `bash_tool` + python heredoc → all analysis, transforms, plotting, modelling.
- `bash_tool` plain bash → file discovery and cheap inspection (`ls`, `head`,
  `wc -l`, `file`, `unzip -l`), format conversion (`soffice --headless
  --convert-to`, `pandoc`), and text munging where `sed`/`awk` beats pandas.
- `read_file` → re-read a known text file (exact path from earlier output or
  `/mnt/data`) without spending an execution; it also renders images/PDFs so you
  can visually check a chart you generated, and reads skill references via
  `skills/<name>/…` paths. It needs exact paths — don't use it to "explore".

## Scope

Use the sandbox for computation on real data. Don't use it to echo prose, to
"verify" trivial arithmetic, or to produce content that belongs directly in chat
or an artifact.

---
name: karl-xlsx
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# only; depth lives in the body + references/.
description: >-
  Spreadsheets in KARL's code sandbox: read, analyze, clean, edit, or create
  .xlsx/.xlsm/.xls/.xlsb/csv files — multi-sheet workbooks, formulas,
  formatting, charts, pivots, conversion. Use whenever a spreadsheet is the
  main input or output.
argument-hint: "[spreadsheet task or file]"
user-invocable: true
version: "1.0.0"
---

# KARL spreadsheets (xlsx)

Spreadsheets run in the same code sandbox as everything else — the sandbox
mechanics (stateless calls, `/mnt/data` persistence, the ~220 s and ~64 KB
caps, headless matplotlib, no network) are in `karl-data-analysis`; read it for
those. This skill is the spreadsheet-specific layer: which library to reach for,
how to read messy real-world workbooks, and how to author correct, formatted
output — including live formulas.

## The environment has a full office stack (verified)

`pandas`, `openpyxl` (read/write `.xlsx`/`.xlsm`), `xlsxwriter` (write with rich
formatting + charts), `xlrd` (legacy `.xls`), `pyxlsb` (`.xlsb`), plus
`libreoffice`/`soffice`, `markitdown`, and `pandoc`. **`.ods` is not
supported** (no `odfpy`) — convert it first with `soffice --headless
--convert-to xlsx`. There is no network, so nothing else can be installed.

## Pick the tool for the job

| Task | Reach for |
|---|---|
| Load tabular data for analysis | `pandas.read_excel` (+ `sheet_name`) |
| Quick human-readable preview of an unknown workbook | `markitdown file.xlsx` |
| Read **both** formulas and their computed values | two `openpyxl.load_workbook` passes (see references/reading.md) |
| Write data out fast (values only) | `pandas.to_excel` or `xlsxwriter` |
| Author formatting, multiple sheets, charts | `xlsxwriter` (new files) / `openpyxl` (edit existing) |
| Output must contain **live formulas** | `openpyxl` to write them, then **recalc with LibreOffice** |
| Convert `.xls`/`.xlsb`/`.ods` → `.xlsx` | `soffice --headless --convert-to xlsx --outdir …` |

## Golden rules

- **Inspect before trusting.** Real workbooks have multiple sheets, multi-row
  headers, merged cells, blank spacer rows, and totals rows mixed into the data.
  List sheets and preview each before parsing. Details: `references/reading.md`.
- **openpyxl reads formulas *or* values, not both at once** — a formula cell is
  `None` under `data_only=True` unless the file was last saved by an app that
  cached the result. Use the two-pass technique in `references/reading.md`.
- **A formula written by openpyxl has no cached value until something
  recalculates it.** If the deliverable must show computed results (not blanks
  in some viewers), run the LibreOffice recalc step in
  `references/authoring.md`. If the deliverable just needs the numbers, compute
  in pandas and write values — simpler and always correct.
- **Prefer live formulas over hardcoded results only when the user wants an
  interactive model.** For a report of *answers*, computed values are better.
- **Match an existing file's conventions when editing it** — sheet names,
  headers, number formats, and which cells are inputs vs formulas. Don't
  reformat what you weren't asked to change.

## References (read on demand)

- `references/reading.md` — reading & analyzing: multi-sheet loading, the
  formula/value two-pass, `.xls`/`.xlsb` engines, cleaning messy layouts,
  encodings and dtype pitfalls, previewing with markitdown.
- `references/authoring.md` — creating & editing: pandas vs xlsxwriter vs
  openpyxl, formatting and number formats, charts, **live formulas + the
  verified LibreOffice recalc workflow**, formula-compatibility limits, and
  templates.

Persist every output to `/mnt/data` with a real extension; it is delivered to
the user automatically. Summarize the result in chat rather than pasting cells.

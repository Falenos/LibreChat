---
name: karl-xlsx
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# only; depth lives in the body + references/.
description: >-
  Spreadsheets in KARL's code sandbox: read, analyze, clean, edit or create
  .xlsx/.xlsm/.xls/.xlsb/csv — multi-sheet workbooks, live formulas,
  formatting, charts, pivots, conversion. Use when a spreadsheet is the main
  input or output; not translation.
argument-hint: "[spreadsheet task or file]"
user-invocable: true
allowed-tools:
  - execute_code
version: "1.1.0"
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
| Output must contain **live formulas** | `openpyxl`/`xlsxwriter` to write them, then **`karl_xlsx.py recalc`** |
| Knauf-styled header, numbers, charts | `brand_formats` / `brand_chart` / `style_header` in `karl_xlsx.py` (invoke `karl-brand` first) |
| Before editing a user's workbook | `karl_xlsx.py inspect` (what an openpyxl save would lose) |
| Convert `.xls`/`.xlsb`/`.ods` → `.xlsx` | `soffice --headless --convert-to xlsx --outdir /tmp/out …`, then copy the result to `/mnt/data` |

## Golden rules

- **Inspect before trusting.** Real workbooks have multiple sheets, multi-row
  headers, merged cells, blank spacer rows, and totals rows mixed into the data.
  List sheets and preview each before parsing. Details: `references/reading.md`.
- **openpyxl reads formulas *or* values, not both at once** — a formula cell is
  `None` under `data_only=True` unless the file was last saved by an app that
  cached the result. Use the two-pass technique in `references/reading.md`.
- **A formula written by openpyxl or xlsxwriter has no correct cached value**
  (openpyxl stores none, xlsxwriter stores 0), so previews and some viewers show
  blanks or zeros. Every workbook with formulas goes through
  `python3 -B /mnt/data/karl-xlsx/scripts/karl_xlsx.py recalc FILE` before
  delivery: it computes every formula, stores the results in the file itself and
  exits 1 on any `#REF!`, `#DIV/0!`, `#NAME?` or other error. **Deliver only
  with zero formula errors.** If the deliverable just needs the numbers, compute
  in pandas and write values — simpler and always correct.
- **Prefer live formulas over hardcoded results only when the user wants an
  interactive model.** For a report of *answers*, computed values are better.
- **Match an existing file's conventions when editing it** — sheet names,
  headers, number formats, and which cells are inputs vs formulas. Don't
  reformat what you weren't asked to change.

## The helper

`/mnt/data/karl-xlsx/scripts/karl_xlsx.py` is mounted read-only with this skill;
run it as `python3 -B`. `recalc FILE [--out OUT]` (above), `inspect FILE` (sheets,
formulas, merged cells, charts, macros and what an openpyxl re-save would drop) and
`qa FILE`, which renders the workbook to contact sheets under
`/mnt/data/_karl_qa/` for a visual check with `read_file` (overflowing `###`
cells, unreadable charts). `_karl_qa/` is never shown to the user.
The file card under the tool call is the download: never write a link to the file
(no `sandbox:` or `/mnt/data` links); name the file instead.

A workbook cannot embed fonts, so Knauf spreadsheets use Arial with the brand
colours; `brand_formats` applies both. Translating a workbook belongs to
`karl-file-translation`.

## References (read on demand)

- `references/reading.md` — reading & analyzing: multi-sheet loading, the
  formula/value two-pass, `.xls`/`.xlsb` engines, cleaning messy layouts,
  encodings and dtype pitfalls, previewing with markitdown.
- `references/authoring.md` — creating & editing: pandas vs xlsxwriter vs
  openpyxl, Knauf formatting and number formats, charts, **live formulas and
  the `recalc` check**, formula-compatibility limits, and templates.

Persist every output to `/mnt/data` with a real extension; it is delivered to
the user automatically. Summarize the result in chat rather than pasting cells.

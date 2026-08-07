# Creating & editing spreadsheets

Depth for the `karl-xlsx` skill. Examples run in the sandbox via a quoted
`python3 << 'PY' … PY` heredoc.

## Which writer

- **`pandas.to_excel`** — fastest way to write one or more DataFrames as values.
  Multiple sheets via an `ExcelWriter`:

      python3 << 'PY'
      import pandas as pd
      with pd.ExcelWriter('/mnt/data/report.xlsx', engine='xlsxwriter') as xl:
          summary.to_excel(xl, sheet_name='Summary', index=False)
          detail.to_excel(xl, sheet_name='Detail', index=False)
      print('wrote /mnt/data/report.xlsx')
      PY

- **`xlsxwriter`** — new files that need formatting, number formats, conditional
  formatting, freeze panes, or native charts. Write-only (can't edit an existing
  file). It can also write formulas, but their cached values are computed by the
  reader app, so pair with the recalc step below if a viewer must show results.
- **`openpyxl`** — the only option to **edit an existing** workbook in place
  (add a column, tweak cells) while preserving other sheets, and to write
  formulas with styles. Load, modify, save.

## Values vs live formulas — decide deliberately

- **Report of answers** (the common case): compute in pandas and write the
  numbers. Always correct, opens cleanly everywhere, no recalc needed.
- **Interactive model** the user will edit: write real formulas so their inputs
  drive the outputs. openpyxl writes the formula *string* with no cached result,
  so you must recalculate before delivery or some viewers show blanks.

## The recalc workflow (verified on this sandbox)

LibreOffice headless recomputes and caches formula results. Write with openpyxl,
then convert-through-LibreOffice to force a recalc:

      python3 << 'PY'
      import subprocess, glob, os
      from openpyxl import load_workbook
      # ... after writing /mnt/data/model.xlsx with formulas via openpyxl ...
      os.makedirs('/mnt/data/rc', exist_ok=True)
      r = subprocess.run(
          ['soffice','--headless','--calc','--convert-to','xlsx',
           '--outdir','/mnt/data/rc','/mnt/data/model.xlsx'],
          capture_output=True, text=True, timeout=120)
      out = glob.glob('/mnt/data/rc/*.xlsx')[0]
      # sanity-check a known cell now has a cached value
      print('recalc rc', r.returncode, '->', out)
      print('sample:', load_workbook(out, data_only=True).active['C2'].value)
      PY

Deliver the recalculated file from `/mnt/data/rc/`. A clean recalc proves the
formulas **evaluate**, not that they are **right** — verify one or two sample
cells against a hand calculation before trusting the whole sheet.

## Formula compatibility (LibreOffice recalc can't do everything)

The recalc engine is LibreOffice Calc, which understands classic Excel functions
but not the newest dynamic-array ones:

- **Safe:** `SUM`, `SUMIFS`, `AVERAGEIFS`, `COUNTIFS`, `INDEX`/`MATCH`,
  `VLOOKUP`, `IF`, `IFERROR`, `SUMPRODUCT`, `ROUND`.
- **Won't evaluate** (avoid, or precompute in pandas): `XLOOKUP`, `XMATCH`,
  `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `LAMBDA` and other dynamic-array
  functions.
- Some post-2007 functions need an `_xlfn.` prefix when written via openpyxl so
  Excel recognizes them: e.g. `_xlfn.TEXTJOIN`, `_xlfn.IFS`, `_xlfn.SWITCH`,
  `_xlfn.MAXIFS`, `_xlfn.MINIFS`.
- Quote sheet names that contain spaces in references: `='Assumptions Inputs'!$B$5`.

## Formatting that reads as professional

- Set a readable default font (e.g. Calibri/Arial), bold the header row, freeze
  the header (`worksheet.freeze_panes(1,0)` in xlsxwriter), and set sensible
  column widths.
- Use **number formats**, not pre-rounded strings, so the underlying value stays
  numeric: currency `#,##0` (unit in the header), percentages `0.0%` stored as
  fractions, thousands `#,##0`, dates `yyyy-mm-dd`.
- For financial models, the common convention is blue text for hardcoded inputs,
  black for formulas, and a light fill on the cells a user is meant to edit —
  apply it consistently if the user works that way.
- One concept per sheet; name sheets and headers exactly as the user asked.

## Charts

- Native Excel charts: `xlsxwriter`'s `workbook.add_chart(...)` +
  `worksheet.insert_chart(...)` — the chart stays editable in Excel and is tied
  to the sheet's data.
- A static image chart (matplotlib `savefig` a `.png`) is better when the user
  wants a picture to drop into a report, or for the inline preview in chat.

## Editing an existing workbook

- Load with openpyxl, change only what's asked, save. Match the file's existing
  headers, number formats, and input-vs-formula split.
- Write only the **top-left** cell of a merged range; the others must stay
  empty.
- `.xlsm` (macros): `load_workbook(path, keep_vba=True)` or the macros are
  dropped on save.
- External-workbook links and some cached values are lost on re-save — recompute
  or re-establish them if they matter.

## Templates

When asked for a reusable template: include a short legend naming the editable
cells, one realistic example row, and formulas already wired to the input cells
(then recalc so the example shows results). Keep instructions in the sheet, not
only in chat.

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

## Recalculate and check before delivery

Every workbook that contains formulas goes through the helper, in the same call
that wrote it:

      python3 -B /mnt/data/karl-xlsx/scripts/karl_xlsx.py recalc /mnt/data/model.xlsx

It works on a copy in `/tmp`: LibreOffice computes every formula (with
"always recalculate" forced, since LibreOffice otherwise trusts the zeros
xlsxwriter caches), and the results are written back into **the original file**
as its cached values. Formatting, charts and defined names are untouched, and
there is only ever one workbook. `--out OTHER.xlsx` writes a copy instead. Dates
follow the workbook's own date system (1900 or 1904).

The file is replaced only when the check is clean. It prints JSON and exits 1
when anything needs fixing, and then **leaves the workbook exactly as it was**
(`"written": false`): fix the formulas and run `recalc` again.

- `errors` — cells showing `#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, `#N/A`…, by
  type, with sheet and cell. **Deliver only with zero errors**: fix the formula
  (guard divisions with `IF(B2=0,"",A2/B2)`, check ranges and sheet names) and
  re-run.
- `unsupported` — dynamic-array functions the sandbox cannot compute (below).
- `prefixed` — cells where an Excel 2010+ function was missing its `_xlfn.`
  prefix; the helper added it, since Excel otherwise shows `#NAME?`.
- `empty_results` — formulas that computed to nothing; usually fine (an
  `IF` returning `""`), worth a look when unexpected.

A clean run proves the formulas **evaluate**, not that they are **right**:
check one or two results by hand (a total, a growth rate) before trusting the
sheet, and say in the reply which cells are inputs.

## Formula compatibility (LibreOffice recalc can't do everything)

The recalc engine is LibreOffice Calc, which understands classic Excel functions
but not the newest dynamic-array ones:

- **Safe:** `SUM`, `SUMIFS`, `AVERAGEIFS`, `COUNTIFS`, `INDEX`/`MATCH`,
  `VLOOKUP`, `IF`, `IFERROR`, `SUMPRODUCT`, `ROUND`.
- **Won't evaluate** (avoid, or precompute in pandas): `XLOOKUP`, `XMATCH`,
  `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`, `LAMBDA` and other dynamic-array
  functions.
- Excel 2010+ functions (`TEXTJOIN`, `IFS`, `SWITCH`, `MAXIFS`, `MINIFS`,
  `CONCAT`, `IFNA`, `STDEV.S`, …) are stored with an `_xlfn.` prefix. Write them
  plainly; `recalc` adds the prefix. xlsxwriter adds it itself when the workbook
  is created with `{'use_future_functions': True}`.
- Quote sheet names that contain spaces in references: `='Assumptions Inputs'!$B$5`.

## Formatting that reads as professional

Knauf styles come from the helper once `karl-brand` has been invoked (it needs
the brand tokens). Spreadsheets cannot embed fonts, so the brand uses Arial
here, with the Knauf colours:

      import sys; sys.path.insert(0, '/mnt/data/karl-xlsx/scripts')
      import karl_xlsx, xlsxwriter
      wb = xlsxwriter.Workbook('/mnt/data/plan.xlsx')
      f = karl_xlsx.brand_formats(wb)   # header, text, int, decimal, percent, date, input, total, title
      ws = wb.add_worksheet('Plan')
      ws.write_row(0, 0, ['Region', 'Units', 'Price (EUR)'], f['header'])
      ws.write(1, 1, 1240, f['input'])  # an editable input cell

With openpyxl (editing a workbook), `karl_xlsx.style_header(ws, row=1)` styles
the header row, freezes it and adds a filter.

- Bold the header row, freeze it (`worksheet.freeze_panes(1, 0)` in
  xlsxwriter), and set column widths so no value shows as `###`.
- Use **number formats**, not pre-rounded strings, so the underlying value stays
  numeric: currency `#,##0` (unit in the header), percentages `0.0%` stored as
  fractions, thousands `#,##0`, dates `yyyy-mm-dd`.
- For financial models, inputs look different from formulas: the `input` format
  (heading-blue text on a light fill) marks every hardcoded assumption, and
  formulas stay in the default ink. Apply it consistently.
- One concept per sheet; name sheets and headers exactly as the user asked.

## Charts

- Native Excel charts: `xlsxwriter`'s `workbook.add_chart(...)` +
  `worksheet.insert_chart(...)` — the chart stays editable in Excel and is tied
  to the sheet's data. Brand them with `**karl_xlsx.series_style(i)` in each
  `add_series` call (Knauf categorical order) and `karl_xlsx.brand_chart(chart)`
  (fonts, gridlines, legend at the bottom, no chart title — put it in a cell).
- A static image chart (matplotlib `savefig` a `.png`) is better when the user
  wants a picture to drop into a report, or for the inline preview in chat.

## Editing an existing workbook

- Run `karl_xlsx.py inspect FILE` first. **openpyxl drops charts** when it saves
  a workbook it loaded (and loses some other features); `inspect` warns when the
  file has any. Then rebuild the charts after editing, or tell the user.
- Load with openpyxl, change only what's asked, save. Match the file's existing
  headers, number formats, and input-vs-formula split. Then `recalc`.
- Write only the **top-left** cell of a merged range; the others must stay
  empty.
- `.xlsm` (macros): `load_workbook(path, keep_vba=True)` or the macros are
  dropped on save.
- External-workbook links and some cached values are lost on re-save — recompute
  or re-establish them if they matter.

## Templates

When asked for a reusable template: include a short legend naming the editable
cells, one realistic example row, and formulas already wired to the input cells
(then `recalc` so the example shows results). Keep instructions in the sheet,
not only in chat.

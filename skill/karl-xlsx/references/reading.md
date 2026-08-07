# Reading & analyzing spreadsheets

Depth for the `karl-xlsx` skill. All examples run in the sandbox via a quoted
`python3 << 'PY' … PY` heredoc (see `karl-data-analysis`).

## First contact: preview before parsing

Never assume a workbook's shape. Two cheap ways to look first:

- `markitdown /mnt/data/book.xlsx` — renders every sheet to markdown tables;
  the fastest way to see layout, header rows, and which sheets matter.
- List sheets and dimensions with pandas/openpyxl:

      python3 << 'PY'
      import pandas as pd
      xls = pd.ExcelFile('/mnt/data/book.xlsx')     # engine auto-selected
      print("sheets:", xls.sheet_names)
      for s in xls.sheet_names:
          df = xls.parse(s, header=None, nrows=8)   # raw, no header assumption
          print(f"\n== {s} == shape~{df.shape}")
          print(df.head(8).to_string())
      PY

## Loading a sheet correctly

`pandas.read_excel` picks the engine from the extension (`openpyxl` for
`.xlsx/.xlsm`, `xlrd` for `.xls`, `pyxlsb` for `.xlsb`). Common arguments that
matter on real files:

- `sheet_name=` — name or index; `sheet_name=None` returns a dict of **all**
  sheets.
- `header=` — the 0-based header row; `header=[0,1]` for two-row headers
  (produces a MultiIndex you usually then flatten).
- `skiprows=` / `nrows=` / `usecols="B:F"` — skip banners/notes above the table;
  bound the read.
- `dtype=` — force types (e.g. `dtype={'zip':str}`) so IDs and zip codes don't
  become floats.

      python3 << 'PY'
      import pandas as pd
      df = pd.read_excel('/mnt/data/book.xlsx', sheet_name='Data',
                         header=1, dtype={'account_id': str})
      print(df.shape); print(df.dtypes); print(df.head())
      print("nulls:\n", df.isna().sum())
      PY

## Reading formulas AND their values (the two-pass)

openpyxl exposes either the formula string or the last cached value, not both:

      python3 << 'PY'
      from openpyxl import load_workbook
      vals = load_workbook('/mnt/data/model.xlsx', data_only=True)   # cached results
      frms = load_workbook('/mnt/data/model.xlsx', data_only=False)  # formula strings
      ws_v, ws_f = vals['Sheet1'], frms['Sheet1']
      print("formula:", ws_f['C2'].value, "-> value:", ws_v['C2'].value)
      PY

Caveat: `data_only=True` returns `None` for a formula cell if the file was never
opened/recalculated by a spreadsheet app (e.g. it was produced by openpyxl
without a recalc step). If you need the numbers and they're missing, either
recalc the file first (see `authoring.md`) or recompute in pandas. **Never save
a workbook you loaded with `data_only=True`** — it permanently replaces formulas
with literals.

## Legacy and binary formats

- `.xls` → `read_excel(..., engine='xlrd')` (auto). Read-only; write `.xlsx`.
- `.xlsb` → `read_excel(..., engine='pyxlsb')`. Values only; formulas aren't
  exposed.
- `.ods` → not supported directly. Convert first:
  `soffice --headless --convert-to xlsx --outdir /mnt/data/conv /mnt/data/x.ods`,
  then read the result.

## Cleaning messy real-world layouts

Business workbooks rarely load clean. Watch for:

- **Merged cells** read as the value in the top-left anchor and `NaN` in the
  rest — forward-fill after loading (`df['region'] = df['region'].ffill()`).
- **Multi-row headers** — `header=[0,1]`, then flatten:
  `df.columns = [' '.join(str(c) for c in col if 'Unnamed' not in str(c)).strip() for col in df.columns]`.
- **Totals/subtotal rows** interleaved with data — filter them out before
  aggregating (e.g. drop rows where a key column is null or equals "Total").
- **Numbers stored as text** (leading apostrophes, thousands separators,
  currency symbols) — `pd.to_numeric(s.str.replace(r'[^0-9.-]','',regex=True), errors='coerce')`.
- **Excel serial dates** in a column read as integers — `pd.to_datetime(col,
  unit='D', origin='1899-12-30')`.
- **Trailing empty columns/rows** — `df.dropna(how='all')` and
  `df.dropna(axis=1, how='all')`.

## Analysis

Once loaded, it's ordinary pandas/numpy/scipy/scikit-learn (all preinstalled).
Keep to the output discipline from `karl-data-analysis`: print `describe()`,
`value_counts()`, and aggregates — not whole frames — and write big results to
`/mnt/data` as `.csv`/`.parquet`. For a chart, `savefig` a `.png` (headless
matplotlib). For a multi-sheet or formatted deliverable, see `authoring.md`.

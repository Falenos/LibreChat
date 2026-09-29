---
name: karl-pdf
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# first; depth lives in references/.
description: >-
  PDF files via KARL's code sandbox: create branded PDFs; merge, split, rotate,
  watermark, encrypt; fill forms; extract text and tables to Excel. Only when
  PDF is named or attached for changing; not for answering questions about a
  PDF or translation.
argument-hint: "[PDF task or file]"
user-invocable: true
allowed-tools:
  - execute_code
version: "1.0.0"
---

# KARL PDF files

Code is for making or changing PDFs. **Questions about a PDF need no code**: an
attached PDF is already searchable, including scanned ones. Translating one belongs to
`karl-file-translation`. An artifact that already exists in the chat becomes a PDF from
its own **Download → PDF document** menu, with no code.

## Before the first call

1. For a new branded PDF, **invoke `karl-brand` with the skill tool** (not
   `read_file`) so its fonts, tokens and wordmark are mounted at
   `/mnt/data/karl-brand/`. Changing an existing PDF does not need it.
2. This skill's helper is mounted read-only at `/mnt/data/karl-pdf/scripts/karl_pdf.py`.
   Run it as `python3 -B`.

## Which route

| The user wants | Route |
|---|---|
| A report, brief or letter as PDF only | `html_to_pdf` — write HTML, the Knauf stylesheet does the rest (`skills/karl-pdf/references/create.md`) |
| The same document as Word **and** PDF | Build it with `karl-docx`, then its `to-pdf` |
| A precise layout: certificate, label, form | reportlab with the Knauf fonts (`create.md`) |
| Merge, split, pages, rotate, watermark, password | the commands below |
| A form filled in | `fields`, then `fill` |
| Tables out of a PDF into Excel | `tables FILE --out /mnt/data/tables.xlsx` |

```python
import sys; sys.path.insert(0, '/mnt/data/karl-pdf/scripts')
from karl_pdf import html_to_pdf
html_to_pdf('<h1>Site visit, Iphofen</h1><p class="muted">12 October 2026</p>'
            '<h2>Findings</h2><p>…</p>', '/mnt/data/site-visit-iphofen.pdf')
```

## Changing an existing PDF

Code sees a PDF only when the user attached it with **Upload files to edit**. With plain
**Upload files** it is searchable but not in `/mnt/data`; say which option to use.
`python3 -B /mnt/data/karl-pdf/scripts/karl_pdf.py …`:

| Task | Command |
|---|---|
| What is in it | `info FILE` (pages, size, fonts, forms, encryption, text layer) |
| Text | `text FILE [--pages 1-3] [--layout]` |
| Join files | `merge --out OUT A.pdf B.pdf …` |
| Split into parts | `split FILE --ranges 1-3,4-9 [--outdir DIR]` |
| Keep some pages | `extract-pages FILE --pages 2,5-7 --out OUT` |
| Rotate pages | `rotate FILE --pages 1,3 --degrees 90 --out OUT` |
| Stamp "DRAFT" | `watermark FILE --text DRAFT --out OUT` |
| Password on / off | `encrypt` / `decrypt FILE --password P --out OUT` |
| Form fields | `fields FILE`, then `fill FILE --data values.json --out OUT [--flatten]` |
| Smaller file (lossless) | `compress FILE --out OUT` |

Details, including what cannot be done (editing text inside a PDF, OCR), are in
`skills/karl-pdf/references/manipulate.md`.

## Check, then deliver

Every new or changed PDF ends, in the same call, with
`python3 -B /mnt/data/karl-pdf/scripts/karl_pdf.py qa OUT`. It prints JSON (`problems`,
`pages`, `fonts` with whether each is embedded, leftover placeholder text) and writes
contact sheets under `/mnt/data/_karl_qa/`. Read the sheets with `read_file`, fix and
re-run; `python3 -B /mnt/data/karl-pdf/scripts/office_qa.py page OUT N` renders one
page at full width.
If `read_file` cannot open a sheet, rely on the JSON and `text`. Exit code 1 means a
problem: do not deliver until it is 0.

- The deliverable is `/mnt/data/<descriptive-name>.pdf`; a revision overwrites the
  same name. `_karl_qa/` is never shown to the user.
- `encrypt` uses the password the user gives; ask for one rather than inventing it.
- Never copy font files or anything from `/mnt/data/karl-brand/` into an output.

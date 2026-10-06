---
name: karl-docx
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# first; depth lives in references/.
description: >-
  Word files (.docx) via KARL's code sandbox: create branded reports, memos,
  letters; edit an uploaded .docx, tracked changes, comments, Word→PDF. Only
  when Word/.docx is named or attached; not for translation or answering
  questions about a file.
argument-hint: "[Word document task or file]"
user-invocable: true
allowed-tools:
  - execute_code
version: "1.0.0"
---

# KARL Word documents (.docx)

A `.docx` is the right output when the user asks for Word or a `.docx`, or attaches
one to change. An unqualified "report" or "summary" is better as an artifact
(`karl-artifacts`), which previews in chat. Translating a document belongs to
`karl-file-translation`; answering questions about an attached document needs no
code at all.

**When the user names the format, build the file in that reply.** Choose sensible defaults
for anything left open (length, content, layout, branding) and mention them in one line
afterwards. Do not ask first, and do not point the user to other tools or websites.

## Before the first call

1. **Invoke `karl-brand` with the skill tool**, not `read_file`. Invoking it is what
   mounts its fonts, colour tokens and wordmark at `/mnt/data/karl-brand/`; the
   builder stops with a clear error when they are missing.
2. This skill's helper is mounted read-only at
   `/mnt/data/karl-docx/scripts/karl_docx.py`. Run Python as `python3 -B` so nothing
   is written next to it.

## Create

```python
import sys; sys.path.insert(0, '/mnt/data/karl-docx/scripts')
from karl_docx import KnaufDocument
doc = KnaufDocument('Plant audit 2026', subtitle='Findings and actions',
                    author='Operations', confidentiality='Internal')
doc.heading('Summary', 1)
doc.paragraph('Three of five lines met the OEE target.')
doc.bullets(['L1 and L3 above 82%', 'L4 blocked by tooling'])
doc.table([['Line', 'OEE'], ['L1', '84%'], ['L4', '71%']], widths_cm=[8, 4])
doc.callout('Replace the L4 die set before Q1.', title='Next step')
doc.save('/mnt/data/plant-audit-2026.docx')
```

The builder applies the brand: A4, Knauf Screen body and Knauf Screen Head headings,
brand inks, wordmark header, "Page X of Y" footer, styled tables. Headings are real
Word headings, so the navigation pane and `doc.toc()` work. Everything else it can do
(figures, landscape, page breaks, table options, python-docx underneath) is in
`skills/karl-docx/references/create.md`.

## Edit an uploaded .docx

Code sees a file only when the user attached it with **Upload files to edit**. A file
attached with plain **Upload files** is searchable but not in `/mnt/data`; say so and
ask for the other option rather than guessing. Commands, all
`python3 -B /mnt/data/karl-docx/scripts/karl_docx.py …`:

| Task | Command |
|---|---|
| Read it | `text FILE` |
| Change wording, visibly to the author | `replace FILE --find … --replace … --track -o OUT` |
| Change wording silently | `replace FILE --find … --replace … -o OUT` |
| Leave a margin comment | `comment FILE --find … --text … -o OUT` |
| Accept every tracked change | `accept FILE -o OUT` |

Write edits to a new name (`contract-redlined.docx`) so the original stays available.
Structural edits (moving sections, restyling) and how tracked changes are built are in
`skills/karl-docx/references/edit.md`.

## Check, then deliver

Every build or edit ends, in the same call, with:

```
python3 -B /mnt/data/karl-docx/scripts/karl_docx.py qa /mnt/data/plant-audit-2026.docx
```

It validates the package, renders it with LibreOffice, and prints JSON: `problems`,
`pages`, `fonts`, leftover placeholder text, and contact sheets under
`/mnt/data/_karl_qa/`. Read each sheet with `read_file` and look for overflow, clipped
tables, wrong fonts and orphan headings; fix and re-run.
`python3 -B /mnt/data/karl-docx/scripts/office_qa.py page FILE N` renders one page at
full width. If `read_file` cannot open a sheet, rely on the JSON
and `text`. Exit code 1 means a problem: do not deliver until it is 0.

- The deliverable is `/mnt/data/<descriptive-name>.docx`; a revision overwrites the
  same name. `_karl_qa/` is never shown to the user.
- The file card under the tool call is the download. Never write a link to the file
  (no `sandbox:` or `/mnt/data` links); name the file instead.
- Summarise what the document contains in one or two sentences; do not paste it.
- A PDF as well: `to-pdf FILE` (fonts embedded, exact layout).
- Never copy font files or anything from `/mnt/data/karl-brand/` into an output.

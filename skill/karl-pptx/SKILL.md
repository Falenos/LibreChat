---
name: karl-pptx
# Kept under the 250-char catalog cap (skill/README.md rule 3) — trigger words
# first; depth lives in references/.
description: >-
  PowerPoint (.pptx) via KARL's code sandbox: branded decks with native
  charts and speaker notes; edit, reorder or reuse slides of an uploaded .pptx.
  Only when PowerPoint/.pptx is named or attached; a plain "deck" is an
  artifact. Not translation.
argument-hint: "[PowerPoint task or file]"
user-invocable: true
allowed-tools:
  - execute_code
version: "1.0.0"
---

# KARL PowerPoint decks (.pptx)

A `.pptx` is the right output when the user asks for PowerPoint or a `.pptx`, or
attaches one to change. "A presentation" or "slides" without a format is the slides
artifact (`karl-artifacts`), which previews and presents in chat, and it is not
converted into a file unasked. Translating a deck belongs to `karl-file-translation`.

**When the user names the format, build the file in that reply.** Choose sensible defaults
for anything left open (length, content, layout, branding) and mention them in one line
afterwards. Do not ask first, and do not point the user to other tools or websites.

## Before the first call

1. **Invoke `karl-brand` with the skill tool**, not `read_file`. That mounts its fonts,
   colour tokens and wordmark at `/mnt/data/karl-brand/`; the builder needs them.
2. This skill's helper is mounted read-only at
   `/mnt/data/karl-pptx/scripts/karl_pptx.py`. Run Python as `python3 -B`.

## Create

```python
import sys; sys.path.insert(0, '/mnt/data/karl-pptx/scripts')
from karl_pptx import KnaufDeck
deck = KnaufDeck('Q3 operations review', footer_label='Plant network · Internal')
deck.title_slide('Q3 operations review', 'Plant network · October 2026')
deck.kpi_slide('Q3 at a glance', [('84%', 'OEE'), ('-0.6 pt', 'Scrap'), ('3', 'Lines on target')])
deck.chart_slide('OEE by line', ['L1', 'L2', 'L3'], {'Q2': [80, 76, 82], 'Q3': [84, 79, 85]},
                 notes='L2 is still behind: tooling.')
deck.bullets_slide('Next steps', ['Replace the L2 die set', 'Repeat the audit in Q1'])
deck.closing_slide()
deck.save('/mnt/data/q3-operations-review.pptx')
```

The builder is the Knauf slide grammar: blue title and section fields with the white
wordmark, white content slides with a heading, footer label, live slide number and
small wordmark, Knauf Screen and Knauf Screen Head. Charts are native and editable in
PowerPoint. Slide types, sizes and chart options are in
`skills/karl-pptx/references/create.md`.

- **One idea per slide**, a heading that states it ("OEE rose 4 points", not
  "OEE"), at most six bullets of one line each. Put the detail in `notes=`.
- Every number on a slide needs its unit and period.

## Edit an uploaded .pptx

Code sees a deck only when the user attached it with **Upload files to edit**; with
plain **Upload files** it is searchable, not editable, so say which option to use.
`python3 -B /mnt/data/karl-pptx/scripts/karl_pptx.py …`:

| Task | Command |
|---|---|
| Read it, slide by slide | `text FILE` |
| Copy slide N to the end | `duplicate FILE --slide N -o OUT` |
| Remove slides | `delete FILE --slides 2,5 -o OUT` |
| Change the order | `reorder FILE --order 3,1,2,4 -o OUT` (every slide once) |

Text changes keep the deck's own formatting when made run by run with python-pptx;
how, and how to add a slide in the deck's own layout, is in
`skills/karl-pptx/references/edit.md`. A user's deck keeps its look: do not rebrand
it unasked.

## Check, then deliver

Every build or edit ends, in the same call, with:

```
python3 -B /mnt/data/karl-pptx/scripts/karl_pptx.py qa /mnt/data/q3-operations-review.pptx
```

It validates the package, lints every slide (shapes off the edge, text that will not
fit its box, empty placeholders), renders contact sheets under `/mnt/data/_karl_qa/`
and prints JSON. Read each sheet with `read_file`, fix what you see (overflow,
overlap, low contrast, cramped charts) and re-run.
`python3 -B /mnt/data/karl-pptx/scripts/office_qa.py page FILE N` shows one slide at
full width. If `read_file` cannot open a sheet, rely on the JSON and `text`. Exit
code 1 means a problem: do not deliver until it is 0.

- The deliverable is `/mnt/data/<descriptive-name>.pptx`; a revision overwrites the
  same name. `_karl_qa/` is never shown to the user.
- The file card under the tool call is the download. Never write a link to the file
  (no `sandbox:` or `/mnt/data` links); name the file instead.
- Say how many slides and what they cover; do not paste the slide text.
- A PDF as well: `to-pdf FILE`, which embeds the fonts. The `.pptx` itself names
  Knauf Screen but cannot carry it, so a recipient without the font sees a substitute.
- Never copy font files or anything from `/mnt/data/karl-brand/` into an output.

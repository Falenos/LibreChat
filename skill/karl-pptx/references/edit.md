# Editing a deck

Depth for `karl-pptx`. The user's deck is at `/mnt/data/<its name>` when it was
attached with **Upload files to edit**. A legacy `.ppt` converts first with
`office_qa.soffice('/mnt/data/old.ppt', 'pptx')` (returns a path in `/tmp`).

## Look before changing

`python3 -B /mnt/data/karl-pptx/scripts/karl_pptx.py text FILE` prints every slide's
text with its number, speaker notes included. For layout, render it with
`qa FILE` and read the contact sheets. For structure:

```python
from pptx import Presentation
prs = Presentation('/mnt/data/deck.pptx')
for n, slide in enumerate(prs.slides, 1):
    print(n, slide.slide_layout.name, [(s.shape_type, s.name, s.has_text_frame and s.text_frame.text[:40]) for s in slide.shapes])
```

**A user's deck keeps its own look.** Do not apply the Knauf builder, fonts or colours
to it unless asked. New content follows the deck's own layouts and styles.

## Changing text without losing formatting

Setting `shape.text_frame.text = …` wipes the fonts, sizes and colours of that box.
Change the text of the runs instead:

```python
def replace_in_deck(prs, find, replacement):
    count = 0
    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    if find in run.text:
                        run.text = run.text.replace(find, replacement)
                        count += 1
    return count
```

A phrase split across runs (a bold word inside it) does not match run by run; edit
the runs one at a time in that case, or put the new text in the first run and empty
the others. Tables: `shape.has_table`, then `shape.table.cell(r, c).text_frame`. Speaker
notes: `slide.notes_slide.notes_text_frame`.

## Slide operations

`python3 -B /mnt/data/karl-pptx/scripts/karl_pptx.py …`, each writing to `-o OUT`:

- `duplicate FILE --slide N` appends a copy of slide N. Pictures and charts in the copy
  still point at the original's parts, so changing a chart's data in the copy changes
  both: rebuild a chart rather than edit a duplicated one.
- `delete FILE --slides 2,5`
- `reorder FILE --order 3,1,2,4` lists every slide exactly once, in the new order.

Slide numbers added by `karl_pptx` are live fields and follow a reorder; typed numbers
in a user's deck do not, so check them after moving slides.

## Adding a slide in the deck's own style

Pick the deck's layout by name and fill its placeholders instead of drawing text boxes:

```python
layout = next(l for l in prs.slide_layouts if l.name == 'Title and Content')
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = 'Next steps'
body = next(p for p in slide.placeholders if p.placeholder_format.idx == 1)
body.text_frame.text = 'First point'
body.text_frame.add_paragraph().text = 'Second point'
```

Then move it into place with `reorder`. Delete placeholders you did not fill: `lint`
reports empty ones, and they show "Click to add text" in PowerPoint.

## Prove the edit

In the same call: `qa OUT` must exit 0, `text OUT` must differ from the original only
where intended, and the contact sheets must show the edited slides intact. Tell the
user which slides changed.

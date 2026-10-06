# Editing a Word document

Depth for `karl-docx`. The user's file is at `/mnt/data/<its name>` when it was
attached with **Upload files to edit**. Legacy `.doc` files convert first (see
`create.md`, "Converting other formats").

## Look before changing

- `python3 -B /mnt/data/karl-docx/scripts/karl_docx.py text FILE` prints the text,
  headings included.
- For structure (styles, tables, sections), open it with python-docx:

```python
import docx
d = docx.Document('/mnt/data/contract.docx')
for i, p in enumerate(d.paragraphs[:40]):
    print(i, p.style.name, repr(p.text[:80]))
print(len(d.tables), 'tables;', len(d.sections), 'sections')
```

**A user's document keeps its own look.** Do not apply the Knauf builder or brand
styles to it unless asked. Match its styles, numbering and spelling conventions in
whatever you add.

## Wording changes: `replace`

`replace FILE --find TEXT --replace TEXT [--track] [--count N] -o OUT`

- The match is exact and case-sensitive, and it is found inside one paragraph even
  when Word has split the text into many runs. Formatting of the matched text is
  kept.
- It changes every occurrence unless `--count` limits it, and exits 1 when nothing
  matched. Check the count it prints against what you expected.
- A match that runs through a field, a hyperlink or an image is left alone. Edit a
  shorter, plain part of the text instead.
- `--find` must be unique enough: "3" matches every 3 in the document. Use a phrase.

### Tracked changes (`--track`)

This is what "redline", "suggest changes" or "so I can review" mean. Each change is a
real Word revision (`w:ins`/`w:del`) by `--author` (default "KARL"), which the reader
accepts or rejects in Word's Review tab. Only the differing part is marked:
"80 percent" → "85 percent" shows "0" deleted and "5" inserted, as a person editing
would. Several replacements can be made one after another on the same output file.

`accept FILE -o OUT` accepts every revision, for a clean copy.

## Comments

`comment FILE --find TEXT --text NOTE [--author NAME] -o OUT` attaches a margin
comment to the first occurrence of `TEXT`. Use comments for questions and review
notes that should not change the text.

## Structural changes (python-docx)

For anything beyond wording, work on `docx.Document`, then save to a new name:

| Task | How |
|---|---|
| Insert a paragraph before another | `p.insert_paragraph_before('text', style=p.style)` |
| Delete a paragraph | `p._element.getparent().remove(p._element)` |
| Edit a table cell | `d.tables[0].cell(row, col).text = '…'` (clears its formatting; for kept formatting set `cell.paragraphs[0].runs[0].text`) |
| Add a table row | `row = table.add_row()`, then fill `row.cells` |
| Header or footer text | `d.sections[0].header.paragraphs[0]` |

python-docx keeps everything it does not understand (charts, comments, content
controls) as it was. Never recreate a user's document from its text: the result
loses all of that.

## Prove the edit

After editing, in the same call:

1. `qa OUT` must exit 0.
2. Compare `text` of the original and the output: only the intended passages may
   differ. With tracked changes, the text dump shows the new wording.
3. Tell the user what changed, how many places, and whether the changes are tracked.

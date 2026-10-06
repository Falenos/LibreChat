# Creating a Word document

Depth for `karl-docx`. Every example runs inside one `execute_code` call that
starts with:

```python
import sys; sys.path.insert(0, '/mnt/data/karl-docx/scripts')
from karl_docx import KnaufDocument
```

## The builder

`KnaufDocument(title, subtitle=None, author='', confidentiality='', landscape=False, cover=True)`

- `cover=True` opens the document with the title, subtitle and an
  `author · date` line in muted ink. Use `cover=False` for a letter or a memo that
  starts with its own heading.
- `confidentiality` ("Internal", "Confidential") goes into the footer next to the
  title and the page numbers.
- The title, author and subtitle also become the file's document properties.

| Method | What it adds |
|---|---|
| `heading(text, level)` | Heading 1–3 in Knauf Screen Head and heading ink; kept with the next paragraph |
| `paragraph(text, bold_lead=None, muted=False, style=None)` | Body text. `bold_lead='Risk.'` starts it with a bold label |
| `bullets(items, numbered=False)` | A real Word list, not typed dots |
| `table(rows, header=True, widths_cm=None, align_numbers=True, zebra=True)` | Grey header row, light borders, zebra rows; number columns align right |
| `figure(path, width_cm=16, caption=None)` | An image (PNG/JPEG) with an optional caption |
| `callout(text, title=None)` | A shaded box for the key message or next step |
| `page_break()` | A hard page break |
| `toc(levels='1-3')` | A table of contents; Word fills it in when the file opens |
| `save(path)` | Writes the file |

`doc.doc` is the underlying python-docx `Document`, for anything the builder does not
cover. Styles are already branded, so prefer style names (`'Quote'`,
`'Intense Quote'`, `'Caption'`) over direct formatting.

## Layout rules that keep Word happy

- **Text width is 16.6 cm** on portrait A4 (25.3 cm landscape). Table
  `widths_cm` should add up to that or less. Without widths the columns are split
  evenly, which suits short tables only.
- **Keep tables under about 7 columns** in portrait. Wider data goes into a
  landscape document or an attached `.xlsx`.
- **Charts are images.** Draw them with matplotlib using the brand palette from
  `knauf_brand` (see `skills/karl-brand/references/charts.md`), save a PNG at
  200 dpi into `/tmp`, then `figure()` it. Label axes with ink tokens, never with a
  series colour.
- **Never skip a heading level**, and never fake a heading with bold body text:
  Word's navigation pane and the table of contents only see real headings.
- **Numbers**: format them before they go into a table (`f'{value:,.0f}'`), keep the
  unit in the header ("Revenue (EUR k)"), and round consistently within a column.

## Letters and memos

Build with `cover=False`, then a `paragraph()` block for the sender and date, a
bold subject line (`paragraph(subject, bold_lead='Subject:')`), and the body. Keep
the footer's confidentiality label; drop the table of contents.

## Fonts

The body and headings use Knauf Screen and Knauf Screen Head when karl-brand's fonts
are installed. A `.docx` built this way names the fonts but does not carry them, so a
reader without them installed sees Arial instead (the font table says so). When the
exact look matters for someone outside Knauf, deliver the PDF as well (`to-pdf`), which
embeds them.

## Converting other formats

- Markdown or HTML the user already has → Word: `pandoc in.md -o /tmp/draft.docx`,
  then open it with python-docx and apply the brand by rebuilding the content in
  `KnaufDocument`. A raw pandoc file is not branded.
- `.doc` (legacy Word) → `.docx`: use LibreOffice through the shared helper, e.g.
  `office_qa.soffice('/mnt/data/old.doc', 'docx')`, which returns a path in `/tmp`;
  copy that to `/mnt/data`.

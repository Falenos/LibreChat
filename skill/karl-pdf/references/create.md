# Creating a PDF

Depth for `karl-pdf`. `karl-brand` must have been invoked in the conversation so its
fonts and wordmark are in the sandbox.

## HTML to PDF (the default route)

```python
import sys; sys.path.insert(0, '/mnt/data/karl-pdf/scripts')
from karl_pdf import html_to_pdf
html_to_pdf(html, '/mnt/data/<name>.pdf', css=None, with_wordmark=True, title=None)
```

WeasyPrint renders the HTML with a Knauf base stylesheet: A4 with 20–22 mm margins,
Knauf Screen body and Knauf Screen Head headings in brand inks, the wordmark top right,
and a footer with the document title and "Page X of Y". Fonts are embedded, so the PDF
looks the same everywhere.

Write plain semantic HTML; the stylesheet styles it:

| Write | Result |
|---|---|
| `<h1>` once | Document title; it also becomes the footer title and the PDF's title |
| `<h2>`, `<h3>` | Section headings |
| `<p class="muted">` | Secondary text (dates, sources) |
| `<table>` with `<th>` in the first row | Grey header, light borders, zebra rows |
| `<td class="num">`, `<th class="num">` | Right-aligned, tabular figures |
| `<div class="callout"><strong>Next step.</strong> …</div>` | Shaded key-message box |
| `<figure><img src="file:///tmp/chart.png"><figcaption>…</figcaption></figure>` | A figure with a caption |

- **Page breaks**: `<h2 style="break-before: page">`; keep a table together with
  `<table style="break-inside: avoid">`.
- **Landscape**: `css='@page { size: A4 landscape; }'`.
- **Extra styling** goes in `css=`, using karl-brand tokens
  (`knauf_brand.token('ink.heading')`); never type a colour value.
- **Images** are absolute `file://` paths. Save charts from matplotlib into `/tmp` at
  200 dpi, branded per `skills/karl-brand/references/charts.md`, so the PNGs do not
  become deliverables themselves.
- No JavaScript, no web fonts, no network: everything must be in the sandbox.
- A letter or memo without the wordmark header: `with_wordmark=False`.

From a file: `python3 -B /mnt/data/karl-pdf/scripts/karl_pdf.py from-html /tmp/report.html --out /mnt/data/report.pdf`.

## Word and PDF together

When the user wants both, build the `.docx` with `karl-docx` and convert it with
`python3 -B /mnt/data/karl-docx/scripts/karl_docx.py to-pdf FILE`. The PDF then matches
the Word file page for page.

## Exact layout with reportlab

For certificates, labels, badges and anything positioned to the millimetre:

```python
import sys; sys.path.insert(0, '/mnt/data/karl-brand/scripts')
import knauf_brand as kb
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

fonts = kb.install_fonts()
body = heading = 'Helvetica'
if fonts['installed']:
    pdfmetrics.registerFont(TTFont('Knauf', fonts['files'][fonts['body']]['Regular']))
    pdfmetrics.registerFont(TTFont('KnaufHead', fonts['files'][fonts['heading']]['Bold']))
    body, heading = 'Knauf', 'KnaufHead'

c = canvas.Canvas('/mnt/data/certificate.pdf', pagesize=A4, initialFontName=body)
c.setTitle('Training certificate')
width, height = A4
c.drawImage(kb.wordmark_png('logo', 300), width - 20 * mm - 40 * mm, height - 30 * mm,
            width=40 * mm, height=40 * mm / kb.WORDMARK_ASPECT, mask='auto')
c.setFillColorRGB(*[v / 255 for v in kb.rgb('ink.heading')])
c.setFont(heading, 28)
c.drawString(20 * mm, height - 70 * mm, 'Certificate of completion')
c.setFillColorRGB(*[v / 255 for v in kb.rgb('ink.primary')])
c.setFont(body, 12)
c.drawString(20 * mm, height - 85 * mm, 'Awarded to …')
c.showPage(); c.save()
```

reportlab embeds a subset of each registered TrueType font. Keep 15 mm clear of every
page edge for printers, and wrap long text with `reportlab.platypus.Paragraph` rather
than `drawString`, which never wraps.

## Metadata

`html_to_pdf` sets the title from `<h1>` (or `title=`). With reportlab, call
`c.setTitle`, `c.setAuthor` and `c.setSubject`. A PDF without a title shows its file
name in viewer tabs and screen readers.

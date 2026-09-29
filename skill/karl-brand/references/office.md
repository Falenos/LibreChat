# Brand in Word, PowerPoint, Excel and PDF files

How the tokens in `skills/karl-brand/SKILL.md` map onto files built in the code
sandbox by `karl-docx`, `karl-pptx`, `karl-xlsx` and `karl-pdf`. Their builders apply
all of this; this page is for work outside the builders and for checking a result.

## What invoking this skill puts in the sandbox

Invoking `karl-brand` with the skill tool mounts its files read-only under
`/mnt/data/karl-brand/`:

| Path | What it is |
|---|---|
| `scripts/knauf_brand.py` | The tokens as Python (`hex('ink.heading')` → `'003778'`, `rgb(…)`, `token(…)`), `install_fonts()`, `wordmark_png(fill, height_px)` |
| `assets/knauf-wordmark.svg` | The official single-path wordmark |
| `sandbox/knauf-fonts.zip` | The licensed Knauf Screen and Knauf Screen Head font files, when shipped |

```python
import sys; sys.path.insert(0, '/mnt/data/karl-brand/scripts')
import knauf_brand as kb
fonts = kb.install_fonts()   # {'body': 'Knauf Screen', 'heading': 'Knauf Screen Head', 'installed': True, 'files': {…}}
```

`install_fonts()` unpacks the fonts into `/tmp` and makes them visible to LibreOffice,
WeasyPrint and fontconfig for the rest of that call. Without the archive it returns
Arial for both, which the brand accepts as the fallback. `wordmark_png('logo')` is the
cyan mark for white backgrounds and `wordmark_png('white')` the white mark for a brand
field; no other fill exists. Size it by height and keep `kb.WORDMARK_ASPECT`.

**The font files are licensed for embedding in documents only.** They never become a
deliverable: not copied to `/mnt/data`, not zipped, not converted, not attached,
whoever asks. A generated PDF or document that uses them is fine.

## Fonts by format

| Format | What the file carries | What a reader sees |
|---|---|---|
| PDF (any route) | Knauf Screen and Knauf Screen Head, embedded as subsets | Exactly the brand |
| `.docx` | Font names, with Arial as the declared substitute | The brand where the fonts are installed, Arial elsewhere |
| `.pptx` | Font names | The brand where installed, the system's substitute elsewhere |
| `.xlsx` | Arial | Arial: a workbook cannot embed fonts, so the brand rule is Arial |

When a Word or PowerPoint file must look exact for someone outside Knauf, deliver its
PDF as well.

## Word

- A4 portrait, 2.2 cm side margins; Normal 10.5 pt `ink.primary`, line spacing 1.15.
- Title 26 pt, Heading 1/2/3 at 18/14/12 pt: Knauf Screen Head, bold, `ink.heading`.
  Subtitle 13 pt `ink.secondary`, not italic.
- Header: the cyan wordmark, right-aligned, 0.9 cm high. Footer: title ·
  confidentiality · "Page X of Y" in 8.5 pt `ink.muted`.
- Tables: header row filled `surface.neutral` with bold `ink.primary` text, borders
  `surface.border`, zebra rows `surface.page`, figures right-aligned.
- Callouts: a `surface.page` box with the title in `ink.heading`.

## PowerPoint

- 16:9. Title, section and closing slides: a `brand.accessibleBlue` field, the white
  wordmark, titles in `ink.onDark`, subtitles and kickers in `ink.accentOnBrand`.
- Content slides: white, heading 28 pt Knauf Screen Head in `ink.heading`, body 20 pt
  `ink.primary`, bullet marks in `brand.cyanBlue`, footer label and slide number
  10 pt `ink.muted`, the cyan wordmark small at bottom right.
- KPI cards: `surface.page` fill, `surface.border` outline, value in `ink.heading`,
  label in `ink.muted`.
- Charts: series in `categorical` order, data labels `ink.primary`, axis labels
  `ink.muted`, gridlines `surface.neutral`, no chart title (the slide heading is it).

## Excel

- Arial throughout. Header row: `surface.neutral` fill, bold `ink.primary`, frozen,
  with a filter. Cell borders `surface.border`.
- Input cells: `ink.heading` text on `surface.page`. Totals: bold with an
  `ink.heading` rule above.
- Charts: series in `categorical` order, axis text `ink.secondary`, gridlines
  `surface.border`, legend at the bottom.
- Conditional formatting uses `status` colours beside an icon or a text column, never
  colour alone; no `lightGreen`, `yellow` or `orange` fill behind text that must be read.

## PDF

- The HTML route (`karl-pdf`) applies the Word rules above in CSS: A4, the wordmark top
  right, headings in `ink.heading`, tables as in Word, footer with title and page
  numbers.
- Every PDF has a title in its metadata (the `<h1>`, or `setTitle` with reportlab).

## Checking a result

The `qa` command of each format skill lists the fonts in the rendered PDF with whether
each is embedded. "Knauf Screen" there means the fonts were installed; "Arial" or
"Liberation Sans" means `karl-brand` was not invoked or shipped no fonts.

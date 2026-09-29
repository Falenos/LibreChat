# Changing and reading existing PDFs

Depth for `karl-pdf`. All commands are
`python3 -B /mnt/data/karl-pdf/scripts/karl_pdf.py <command> …`. Pages are 1-based;
ranges look like `1-3,7`. Every command that writes takes `--out` and leaves the input
unchanged.

## Start with `info`

`info FILE` prints the page count and size, metadata, form-field count, fonts, whether
it is encrypted, and how much text page 1 has. **No text on page 1 usually means a
scan.** The sandbox has no OCR, so a scan's text cannot be extracted here. The chat's
own file reading handles scans: ask the user to attach it with plain **Upload files**
and answer from that.

## Pages

| Command | Notes |
|---|---|
| `merge --out OUT A.pdf B.pdf …` | In the order given; bookmarks and form fields come along |
| `split FILE --ranges 1-3,4-9 [--outdir /mnt/data]` | One file per range, named `<name>_<range>.pdf` |
| `extract-pages FILE --pages 2,5-7 --out OUT` | The listed pages, in that order |
| `rotate FILE --pages 1,3 --degrees 90 --out OUT` | Clockwise, multiples of 90; all pages when `--pages` is omitted |

Reordering is `extract-pages` with the full new order (`--pages 3,1,2,4-9`).

## Stamps and protection

- `watermark FILE --text DRAFT --out OUT` puts a large, light diagonal label on every
  page, over the content, in the brand's muted ink.
- `encrypt FILE --password P --out OUT` uses AES-256; the same password opens and owns
  the file. `decrypt FILE --password P --out OUT` removes it. Every other command
  refuses an encrypted input, so decrypt first.
- `compress FILE --out OUT` is lossless: it recompresses page streams and merges
  duplicate objects. Big scans stay big, because images are not downsampled.

## Forms

1. `fields FILE` lists each field with its type (`Tx` text, `Btn` checkbox or radio,
   `Ch` choice), current value, and the allowed states or options.
2. Write the values as JSON, keyed by the exact field names:
   `{"name": "Ana Costa", "plant": "Neuss", "safe": true}`. Checkboxes take
   `true`/`false`; choice fields take one of the listed options.
3. `fill FILE --data /tmp/values.json --out OUT` keeps the form fillable.
   `--flatten` bakes the values into the page and removes the fields, for a copy that
   can no longer be changed.

Unknown field names stop the command with the list to fix. Check the result with `qa`:
the contact sheet shows the filled values.

## Reading

- `text FILE [--pages 1-3]` is the PDF's own text layer, page by page. `--layout` keeps
  columns side by side, which suits forms and statements.
- `tables FILE [--pages 2-4] --out /mnt/data/tables.xlsx` finds ruled tables with
  pdfplumber and writes one sheet per table, named `p<page>_t<n>`; `--out x.csv`
  writes them one after another. Values come out as text, so convert numbers
  (`1,240` → 1240) before calculating, and check a table against the page render:
  tables without lines, or that span pages, are often missed or split.
- For deeper work: `pdfplumber` (words with positions, `page.crop(bbox)`), `pypdf`
  (outline, annotations, attachments), `pypdfium2` (rendering). `pdfimages -list` shows
  embedded images.

## What does not work

- **Editing the text of a PDF in place.** PDFs do not reflow. Rebuild the document
  (from its text, or from the Word original if the user has it) instead.
- **OCR**: none in the sandbox (see `info` above).
- **Digital signatures** are broken by any change; say so before changing a signed
  PDF (`info` metadata and `pypdf` `reader.get_fields()` show signature fields).
- **Redaction**: drawing black boxes leaves the text underneath. True redaction means
  rebuilding the page without the text, and needs the user's explicit request.

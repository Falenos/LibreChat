"""KARL PDF helper: inspect, extract, transform, fill and create PDFs in the code sandbox.

Commands (`python3 -B /mnt/data/karl-pdf/scripts/karl_pdf.py <command> …`):

    qa FILE [--pages 1-6]                   render contact sheets, report fonts and problems
    info FILE                               pages, size, metadata, encryption, forms, fonts
    text FILE [--pages 1-3] [--layout]      text (the PDF's own text layer; no OCR here)
    tables FILE [--pages 1-3] --out OUT     tables via pdfplumber → .xlsx (a sheet each) or .csv
    merge --out OUT FILE FILE …             concatenate
    split FILE --ranges 1-3,4-9 [--outdir DIR]
    extract-pages FILE --pages 2,5-7 --out OUT
    rotate FILE --pages 1,3 --degrees 90 --out OUT
    watermark FILE --text DRAFT --out OUT   diagonal, light, on every page
    encrypt FILE --password P --out OUT     AES-256
    decrypt FILE --password P --out OUT
    fields FILE                             list the form fields
    fill FILE --data values.json --out OUT [--flatten]
    compress FILE --out OUT                 lossless: dedupe objects, recompress streams
    from-html FILE.html --out OUT.pdf       WeasyPrint, with Knauf fonts when installed

Use `html_to_pdf()` from Python for a branded report built from HTML/CSS. For a document
that should also exist as Word, build it with karl-docx and run its `to-pdf` instead.
"""
import argparse
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import office_qa  # noqa: E402  (shared QA helpers, identical in every office skill)

BRAND_SCRIPTS = os.environ.get('KARL_BRAND_SCRIPTS', '/mnt/data/karl-brand/scripts')


def _brand(required=True):
    if BRAND_SCRIPTS not in sys.path:
        sys.path.insert(0, BRAND_SCRIPTS)
    try:
        import knauf_brand
    except ImportError as exc:
        if not required:
            return None
        raise RuntimeError(
            'The Knauf brand helper is not in the sandbox. Invoke the karl-brand skill with '
            'the skill tool (its files carry the tokens, fonts and wordmark), then retry.'
        ) from exc
    return knauf_brand


def _reader(path, password=None):
    from pypdf import PdfReader

    reader = PdfReader(path)
    if reader.is_encrypted:
        if password is None or not reader.decrypt(password):
            raise SystemExit(f'{path} is encrypted; give --password (decrypt) first.')
    return reader


def _write(writer, out):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'wb') as handle:
        writer.write(handle)
    print(f'wrote {out}')


def _pages(spec, count):
    selected = office_qa.parse_pages(spec) or list(range(1, count + 1))
    bad = [n for n in selected if not 1 <= n <= count]
    if bad:
        raise SystemExit(f'pages out of range 1-{count}: {bad}')
    return selected


# ── inspection ───────────────────────────────────────────────────────────────────────────


def info(path):
    reader = _reader(path) if not _encrypted(path) else None
    result = {'file': path, 'bytes': os.path.getsize(path), 'encrypted': _encrypted(path)}
    if reader is None:
        return result
    first = reader.pages[0].mediabox if reader.pages else None
    result.update({
        'pages': len(reader.pages),
        'page_size_pt': [round(float(first.width)), round(float(first.height))] if first is not None else None,
        'metadata': {k.lstrip('/'): str(v) for k, v in (reader.metadata or {}).items()},
        'form_fields': len(reader.get_fields() or {}),
        'text_chars_first_page': len((reader.pages[0].extract_text() or '').strip()) if reader.pages else 0,
        'fonts': office_qa.pdf_fonts(path),
    })
    if result['pages'] and result['text_chars_first_page'] == 0:
        result['note'] = ('no text layer on page 1: probably a scan. OCR is not available in the '
                          'sandbox; the chat file search (Azure Document Intelligence) can read it.')
    return result


def _encrypted(path):
    from pypdf import PdfReader

    return PdfReader(path).is_encrypted


def text(path, pages=None, layout=False):
    reader = _reader(path)
    selected = _pages(pages, len(reader.pages))
    if layout and subprocess.run(['which', 'pdftotext'], capture_output=True).returncode == 0:
        first, last = min(selected), max(selected)
        return subprocess.run(['pdftotext', '-layout', '-f', str(first), '-l', str(last), path, '-'],
                              capture_output=True, text=True, timeout=120).stdout
    return '\n'.join(f'--- page {n} ---\n{reader.pages[n - 1].extract_text() or ""}' for n in selected)


def tables(path, out, pages=None):
    """Every table pdfplumber finds, one sheet (or CSV block) per table, with its page."""
    import pdfplumber

    found = []
    with pdfplumber.open(path) as pdf:
        for number in _pages(pages, len(pdf.pages)):
            for index, table in enumerate(pdf.pages[number - 1].extract_tables(), start=1):
                rows = [[(cell or '').strip() for cell in row] for row in table if any(row)]
                if rows:
                    found.append((f'p{number}_t{index}', rows))
    if not found:
        print('no tables found (tables drawn as images, or without ruling lines, may not be detected)')
        return 1
    if out.lower().endswith('.csv'):
        import csv

        with open(out, 'w', newline='', encoding='utf-8') as handle:
            writer = csv.writer(handle)
            for name, rows in found:
                writer.writerow([f'# {name}'])
                writer.writerows(rows)
                writer.writerow([])
    else:
        from openpyxl import Workbook

        workbook = Workbook()
        workbook.remove(workbook.active)
        for name, rows in found:
            sheet = workbook.create_sheet(name[:31])
            for row in rows:
                sheet.append(row)
        workbook.save(out)
    print(f'wrote {out} ({len(found)} table(s))')
    return 0


def fields(path):
    reader = _reader(path)
    result = {}
    for name, field in (reader.get_fields() or {}).items():
        result[name] = {
            'type': str(field.get('/FT', '')).lstrip('/'),
            'value': str(field.get('/V', '')) if field.get('/V') is not None else None,
            'options': [str(o) for o in field.get('/_States_', [])] or None,
        }
    return result


# ── transformations ──────────────────────────────────────────────────────────────────────


def merge(files, out):
    from pypdf import PdfWriter

    writer = PdfWriter()
    for path in files:
        writer.append(_reader(path))
    _write(writer, out)


def split(path, ranges, outdir):
    from pypdf import PdfWriter

    reader = _reader(path)
    base = os.path.splitext(os.path.basename(path))[0]
    for part in ranges.split(','):
        writer = PdfWriter()
        for number in _pages(part, len(reader.pages)):
            writer.add_page(reader.pages[number - 1])
        _write(writer, os.path.join(outdir, f'{base}_{part.strip()}.pdf'))


def extract_pages(path, pages, out):
    from pypdf import PdfWriter

    reader = _reader(path)
    writer = PdfWriter()
    for number in _pages(pages, len(reader.pages)):
        writer.add_page(reader.pages[number - 1])
    _write(writer, out)


def rotate(path, pages, degrees, out):
    from pypdf import PdfWriter

    if degrees % 90:
        raise SystemExit('--degrees must be a multiple of 90')
    writer = PdfWriter(clone_from=_reader(path))
    for number in _pages(pages, len(writer.pages)):
        writer.pages[number - 1].rotate(degrees)
    _write(writer, out)


def watermark(path, label, out):
    """A light diagonal label on every page, in the brand's muted ink."""
    import io

    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas

    kb = _brand(required=False)
    colour = [c / 255 for c in (kb.rgb('ink.muted') if kb else (128, 128, 128))]
    writer = PdfWriter(clone_from=_reader(path))
    for page in writer.pages:
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        buffer = io.BytesIO()
        stamp = canvas.Canvas(buffer, pagesize=(width, height))
        stamp.setFillColorRGB(*colour, alpha=0.18)
        stamp.setFont('Helvetica-Bold', min(width, height) / 7)
        stamp.translate(width / 2, height / 2)
        stamp.rotate(35)
        stamp.drawCentredString(0, 0, label)
        stamp.save()
        page.merge_page(PdfReader(io.BytesIO(buffer.getvalue())).pages[0])
    _write(writer, out)


def encrypt(path, password, out):
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=_reader(path))
    writer.encrypt(user_password=password, owner_password=password, algorithm='AES-256')
    _write(writer, out)


def decrypt(path, password, out):
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=_reader(path, password))
    _write(writer, out)


def fill(path, data, out, flatten=False):
    from pypdf import PdfWriter

    reader = _reader(path)
    known = set((reader.get_fields() or {}).keys())
    unknown = sorted(set(data) - known)
    if unknown:
        raise SystemExit(f'unknown field names: {unknown}. Run `fields` for the exact names.')
    values = {}
    for name, value in data.items():
        field = reader.get_fields()[name]
        if field.get('/FT') == '/Btn':  # checkbox/radio: map true/false onto the field's own states
            states = [str(s) for s in field.get('/_States_', [])]
            on = next((s for s in states if s != '/Off'), '/Yes')
            truthy = value is True or str(value).lower().lstrip('/') in ('true', 'yes', 'on', '1', 'x', on.lstrip('/').lower())
            values[name] = on if truthy else '/Off'
        else:
            values[name] = str(value)
    writer = PdfWriter(clone_from=reader)
    writer.update_page_form_field_values(None, values, auto_regenerate=False, flatten=flatten)
    if flatten:  # the values are now page content; drop the widgets and the form itself
        writer.remove_annotations(subtypes='/Widget')
        writer._root_object.pop('/AcroForm', None)
    else:
        writer.set_need_appearances_writer(True)
    _write(writer, out)


def compress(path, out):
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=_reader(path))
    for page in writer.pages:
        page.compress_content_streams()
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    _write(writer, out)
    print(f'{os.path.getsize(path)} → {os.path.getsize(out)} bytes')


# ── creation ─────────────────────────────────────────────────────────────────────────────


def knauf_css():
    """Base stylesheet for a Knauf report in HTML: A4 pages, brand fonts and inks, tables."""
    kb = _brand()
    fonts = kb.install_fonts()
    t = kb.token
    return f"""
@page {{ size: A4; margin: 22mm 20mm 20mm 20mm;
  @bottom-left {{ content: string(doctitle); font: 8.5pt '{fonts['body']}'; color: {t('ink.muted')}; }}
  @bottom-right {{ content: 'Page ' counter(page) ' of ' counter(pages); font: 8.5pt '{fonts['body']}'; color: {t('ink.muted')}; }} }}
html {{ font-family: '{fonts['body']}', Arial, sans-serif; font-size: 10.5pt; color: {t('ink.primary')}; line-height: 1.4; }}
h1, h2, h3 {{ font-family: '{fonts['heading']}', '{fonts['body']}', Arial, sans-serif; color: {t('ink.heading')}; line-height: 1.2; }}
h1 {{ font-size: 24pt; string-set: doctitle content(); margin: 0 0 4mm; }}
h2 {{ font-size: 15pt; margin: 8mm 0 3mm; }}
h3 {{ font-size: 12pt; margin: 6mm 0 2mm; }}
header.knauf {{ text-align: right; margin-bottom: 6mm; }}
header.knauf img {{ height: 9mm; }}
table {{ border-collapse: collapse; width: 100%; margin: 3mm 0 5mm; }}
th {{ background: {t('surface.neutral')}; color: {t('ink.primary')}; text-align: left; font-weight: 700; }}
th, td {{ border: 0.6pt solid {t('surface.border')}; padding: 1.6mm 2.2mm; }}
tr:nth-child(even) td {{ background: {t('surface.page')}; }}
td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.muted {{ color: {t('ink.muted')}; }}
.callout {{ background: {t('surface.page')}; padding: 3mm 4mm; margin: 4mm 0; }}
.callout strong {{ color: {t('ink.heading')}; }}
figcaption {{ font-size: 9pt; color: {t('ink.muted')}; }}
"""


def html_to_pdf(html, out, css=None, with_wordmark=True, title=None):
    """Render HTML (a string) to PDF with the Knauf base stylesheet; fonts are embedded.

    The PDF title (shown in viewer tabs) is `title`, else the page's <title>, else its first <h1>.
    """
    import html as html_lib

    from weasyprint import CSS, HTML

    kb = _brand()
    stylesheets = [CSS(string=knauf_css())] + ([CSS(string=css)] if css else [])
    if with_wordmark and 'class="knauf"' not in html:
        html = f'<header class="knauf"><img src="file://{kb.wordmark_png("logo", 240)}" alt="Knauf"></header>' + html
    if title is None and not re.search(r'<title[\s>]', html, re.IGNORECASE):
        heading = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.IGNORECASE | re.DOTALL)
        title = html_lib.unescape(re.sub(r'<[^>]+>', '', heading.group(1))).strip() if heading else None
    if title:
        html = f'<title>{html_lib.escape(title)}</title>' + html
    HTML(string=html, base_url='/mnt/data').write_pdf(out, stylesheets=stylesheets)
    print(f'wrote {out}')
    return out


# ── CLI ──────────────────────────────────────────────────────────────────────────────────


def main(argv=None):
    parser = argparse.ArgumentParser(prog='karl_pdf.py')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('qa'); p.add_argument('file'); p.add_argument('--pages')
    for name in ('info', 'fields'):
        sub.add_parser(name).add_argument('file')
    p = sub.add_parser('text'); p.add_argument('file'); p.add_argument('--pages'); p.add_argument('--layout', action='store_true')
    p = sub.add_parser('tables'); p.add_argument('file'); p.add_argument('--pages'); p.add_argument('--out', required=True)
    p = sub.add_parser('merge'); p.add_argument('files', nargs='+'); p.add_argument('--out', required=True)
    p = sub.add_parser('split'); p.add_argument('file'); p.add_argument('--ranges', required=True); p.add_argument('--outdir', default='/mnt/data')
    p = sub.add_parser('extract-pages'); p.add_argument('file'); p.add_argument('--pages', required=True); p.add_argument('--out', required=True)
    p = sub.add_parser('rotate'); p.add_argument('file'); p.add_argument('--pages'); p.add_argument('--degrees', type=int, default=90); p.add_argument('--out', required=True)
    p = sub.add_parser('watermark'); p.add_argument('file'); p.add_argument('--text', required=True); p.add_argument('--out', required=True)
    for name in ('encrypt', 'decrypt'):
        p = sub.add_parser(name); p.add_argument('file'); p.add_argument('--password', required=True); p.add_argument('--out', required=True)
    p = sub.add_parser('fill'); p.add_argument('file'); p.add_argument('--data', required=True); p.add_argument('--out', required=True); p.add_argument('--flatten', action='store_true')
    p = sub.add_parser('compress'); p.add_argument('file'); p.add_argument('--out', required=True)
    p = sub.add_parser('from-html'); p.add_argument('file'); p.add_argument('--out', required=True)
    args = parser.parse_args(argv)

    if args.command == 'qa':
        return office_qa.qa(args.file, pages=office_qa.parse_pages(args.pages))
    if args.command == 'info':
        print(json.dumps(info(args.file), indent=1))
    elif args.command == 'fields':
        print(json.dumps(fields(args.file), indent=1))
    elif args.command == 'text':
        print(text(args.file, args.pages, args.layout))
    elif args.command == 'tables':
        return tables(args.file, args.out, args.pages)
    elif args.command == 'merge':
        merge(args.files, args.out)
    elif args.command == 'split':
        split(args.file, args.ranges, args.outdir)
    elif args.command == 'extract-pages':
        extract_pages(args.file, args.pages, args.out)
    elif args.command == 'rotate':
        rotate(args.file, args.pages, args.degrees, args.out)
    elif args.command == 'watermark':
        watermark(args.file, args.text, args.out)
    elif args.command == 'encrypt':
        encrypt(args.file, args.password, args.out)
    elif args.command == 'decrypt':
        decrypt(args.file, args.password, args.out)
    elif args.command == 'fill':
        with open(args.data) as handle:
            fill(args.file, json.load(handle), args.out, args.flatten)
    elif args.command == 'compress':
        compress(args.file, args.out)
    elif args.command == 'from-html':
        with open(args.file, encoding='utf-8') as handle:
            html_to_pdf(handle.read(), args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())

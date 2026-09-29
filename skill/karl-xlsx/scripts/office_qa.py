"""KARL office QA — validate, convert, render and inspect Word, PowerPoint, Excel and PDF files.

Shared by the karl-docx, karl-pptx, karl-pdf and karl-xlsx skills. Every copy of this file is
byte-identical (a repository test enforces it), so a fix goes into all four.

Everything heavy runs in /tmp: LibreOffice gets a throwaway HOME and profile, and inputs are
copied before conversion so lock files never land in /mnt/data. The only thing written to
/mnt/data is the QA contact sheets, under /mnt/data/_karl_qa/, which KARL keeps out of the
chat — they are for looking at, not for the user.

A closer look at one page or slide (full width, /mnt/data/_karl_qa/page-NN.png):

    python3 -B /mnt/data/<skill>/scripts/office_qa.py page /mnt/data/report.docx 3
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

sys.dont_write_bytecode = True

WORK = '/tmp/karl-office'
# The overrides exist for running the helpers outside the sandbox (repository tests).
QA_DIR = os.environ.get('KARL_QA_DIR', '/mnt/data/_karl_qa')
BRAND_HELPER = os.environ.get('KARL_BRAND_HELPER', '/mnt/data/karl-brand/scripts/knauf_brand.py')
MAX_SHEETS = 3
PER_SHEET = 6
SHEET_WIDTH = 1600

PLACEHOLDER_RE = re.compile(
    r'lorem ipsum|\bTODO\b|\bTBD\b|\[insert|\bxxx+\b|click to add|placeholder', re.IGNORECASE
)


def _parse_xml(data):
    try:
        from defusedxml.ElementTree import fromstring
    except ImportError:  # the sandbox has defusedxml; this keeps local runs working
        from xml.etree.ElementTree import fromstring
    return fromstring(data)


def ensure_fonts():
    """Install the Knauf fonts when karl-brand's files are mounted; return the families."""
    if not os.path.exists(BRAND_HELPER):
        return {}
    import importlib.util

    spec = importlib.util.spec_from_file_location('knauf_brand', BRAND_HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.install_fonts()


# LibreOffice keeps the cached result of every formula in an .xlsx by default, and xlsxwriter
# caches 0 for each one, so a converted or rendered workbook would show zeros. Seeding the
# throwaway profile with "always recalculate on load" makes every conversion recompute.
RECALC_ALWAYS = '''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
'''


def soffice(src, fmt, timeout=150):
    """Convert with LibreOffice entirely inside /tmp; return the path of the converted file."""
    os.makedirs(f'{WORK}/home', exist_ok=True)
    registry = f'{WORK}/lo-profile/user/registrymodifications.xcu'
    if not os.path.exists(registry):
        os.makedirs(os.path.dirname(registry), exist_ok=True)
        with open(registry, 'w') as handle:
            handle.write(RECALC_ALWAYS)
    job = tempfile.mkdtemp(dir=WORK)
    staged = os.path.join(job, os.path.basename(src))
    shutil.copy2(src, staged)
    out_dir = os.path.join(job, 'out')
    env = dict(os.environ, HOME=f'{WORK}/home')
    cmd = [
        'soffice', f'-env:UserInstallation=file://{WORK}/lo-profile',
        '--headless', '--norestore', '--convert-to', fmt, '--outdir', out_dir, staged,
    ]
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    ext = fmt.split(':')[0]
    result = os.path.join(out_dir, os.path.splitext(os.path.basename(src))[0] + '.' + ext)
    if done.returncode != 0 or not os.path.exists(result):
        raise RuntimeError(f'LibreOffice could not convert {src} to {ext}: {done.stderr[-400:]}')
    return result


def validate_ooxml(path):
    """Structural problems in a .docx/.pptx/.xlsx: broken zip, bad XML, dangling parts."""
    problems = []
    if not zipfile.is_zipfile(path):
        return [f'{path} is not a ZIP package (not a valid Office file)']
    with zipfile.ZipFile(path) as package:
        bad = package.testzip()
        if bad is not None:
            problems.append(f'corrupt ZIP member: {bad}')
        names = set(package.namelist())
        if '[Content_Types].xml' not in names:
            return problems + ['missing [Content_Types].xml']
        defaults, overrides = set(), set()
        types = _parse_xml(package.read('[Content_Types].xml'))
        for element in types:
            tag = element.tag.rsplit('}', 1)[-1]
            if tag == 'Default':
                defaults.add(element.get('Extension', '').lower())
            elif tag == 'Override':
                overrides.add(element.get('PartName', '').lstrip('/'))
        for name in sorted(names):
            if name.endswith('/'):
                continue
            if name.endswith(('.xml', '.rels')):
                try:
                    _parse_xml(package.read(name))
                except Exception as exc:
                    problems.append(f'{name}: XML does not parse ({exc})')
                    continue
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if name != '[Content_Types].xml' and name not in overrides and ext not in defaults:
                problems.append(f'{name}: no content type declared')
            if name.endswith('.rels'):
                folder = os.path.dirname(os.path.dirname(name))
                for rel in _parse_xml(package.read(name)):
                    if rel.get('TargetMode') == 'External':
                        continue
                    target = rel.get('Target', '')
                    resolved = (
                        target.lstrip('/')
                        if target.startswith('/')
                        else os.path.normpath(os.path.join(folder, target)).replace('\\', '/')
                    )
                    if resolved not in names:
                        problems.append(f'{name}: relationship {rel.get("Id")} points at missing {resolved}')
        main = {'docx': 'word/document.xml', 'pptx': 'ppt/presentation.xml', 'xlsx': 'xl/workbook.xml'}
        kind = path.rsplit('.', 1)[-1].lower()
        if kind in main and main[kind] not in names:
            problems.append(f'missing main part {main[kind]}')
    return problems


SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
# Worksheet children that must come after <pageSetup> (schema order).
AFTER_PAGE_SETUP = (
    'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
    'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects',
    'controls', 'webPublishItems', 'tableParts', 'extLst',
)


def fit_sheets_to_width(xlsx):
    """A /tmp copy of a workbook whose sheets print one page wide, landscape — for rendering.

    The QA render should show each sheet as a whole, not cut into print pages. The copy is
    edited at the XML level so charts and formatting survive (openpyxl would drop charts).
    """
    os.makedirs(WORK, exist_ok=True)
    target = os.path.join(tempfile.mkdtemp(dir=WORK), os.path.basename(xlsx))
    try:
        from lxml import etree
    except ImportError:
        shutil.copy2(xlsx, target)
        return target
    q = lambda tag: f'{{{SHEET_NS}}}{tag}'  # noqa: E731
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
    with zipfile.ZipFile(xlsx) as src, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if re.match(r'xl/worksheets/[^/]+\.xml$', item.filename):
                root = etree.fromstring(data, parser)
                sheet_pr = root.find(q('sheetPr'))
                if sheet_pr is None:
                    sheet_pr = etree.Element(q('sheetPr'))
                    root.insert(0, sheet_pr)
                fit = sheet_pr.find(q('pageSetUpPr'))
                if fit is None:
                    fit = etree.SubElement(sheet_pr, q('pageSetUpPr'))
                fit.set('fitToPage', '1')
                setup = root.find(q('pageSetup'))
                if setup is None:
                    setup = etree.Element(q('pageSetup'))
                    later = next((c for c in root if etree.QName(c).localname in AFTER_PAGE_SETUP), None)
                    margins = root.find(q('pageMargins'))
                    if margins is not None:
                        margins.addnext(setup)
                    elif later is not None:
                        later.addprevious(setup)
                    else:
                        root.append(setup)
                setup.set('orientation', 'landscape')
                setup.set('fitToWidth', '1')
                setup.set('fitToHeight', '0')
                data = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
            dst.writestr(item, data)
    return target


def page_count(pdf):
    import pypdfium2 as pdfium

    return len(pdfium.PdfDocument(pdf))


def _pdf_fonts_pypdf(pdf):
    from pypdf import PdfReader

    fonts = {}
    for page in PdfReader(pdf).pages:
        resources = page.get('/Resources') or {}
        for ref in (resources.get('/Font') or {}).values():
            font = ref.get_object()
            descendants = font.get('/DescendantFonts')
            target = descendants[0].get_object() if descendants else font
            descriptor = target.get('/FontDescriptor')
            descriptor = descriptor.get_object() if descriptor else {}
            name = str(font.get('/BaseFont', '?')).lstrip('/').split('+', 1)[-1]
            embedded = any(k in descriptor for k in ('/FontFile', '/FontFile2', '/FontFile3'))
            fonts[name] = fonts.get(name, False) or embedded
    return [{'name': n, 'embedded': e} for n, e in sorted(fonts.items())]


def pdf_fonts(pdf):
    """Fonts in a PDF as reported by pdffonts (pypdf when it is absent): [{'name', 'embedded'}]."""
    if not shutil.which('pdffonts'):
        return _pdf_fonts_pypdf(pdf)
    out = subprocess.run(['pdffonts', pdf], capture_output=True, text=True, timeout=60).stdout
    fonts = []
    for line in out.splitlines()[2:]:
        # name, type (may contain spaces), encoding, emb, sub, uni, object id, generation
        parts = line.split()
        if len(parts) >= 7:
            fonts.append({'name': parts[0].split('+', 1)[-1], 'embedded': parts[-5] == 'yes'})
    return fonts


def render_pages(pdf, pages=None, width=760):
    """PIL images of the selected 1-based pages, each `width` pixels wide."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        doc.init_forms()  # draw filled form fields as a viewer would; without it they render blank
    except Exception:
        pass
    wanted = pages or list(range(1, len(doc) + 1))
    images = []
    for number in wanted:
        if 1 <= number <= len(doc):
            page = doc[number - 1]
            scale = width / page.get_width()
            images.append((number, page.render(scale=scale).to_pil().convert('RGB')))
    return images


def contact_sheets(images, label='Page', out_dir=QA_DIR):
    """Grids of up to PER_SHEET labelled pages, at most MAX_SHEETS files; returns their paths."""
    from PIL import Image, ImageDraw, ImageFont

    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if old.startswith(('sheet-', 'page-')) and old.endswith('.png'):
            os.remove(os.path.join(out_dir, old))
    try:
        font = ImageFont.load_default(size=22)
    except TypeError:
        font = ImageFont.load_default()
    cols, gap, band = 2, 24, 34
    tile_w = (SHEET_WIDTH - gap * (cols + 1)) // cols
    paths = []
    for index in range(0, min(len(images), PER_SHEET * MAX_SHEETS), PER_SHEET):
        batch = images[index:index + PER_SHEET]
        tiles = [(n, im.resize((tile_w, int(im.height * tile_w / im.width)))) for n, im in batch]
        row_h = max(t.height for _, t in tiles) + band + gap
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new('RGB', (SHEET_WIDTH, rows * row_h + gap), (255, 255, 255))
        draw = ImageDraw.Draw(sheet)
        for i, (number, tile) in enumerate(tiles):
            x = gap + (i % cols) * (tile_w + gap)
            y = gap + (i // cols) * row_h
            draw.text((x, y), f'{label} {number}', fill=(15, 26, 42), font=font)
            sheet.paste(tile, (x, y + band))
            draw.rectangle([x - 1, y + band - 1, x + tile.width, y + band + tile.height], outline=(160, 170, 180))
        path = os.path.join(out_dir, f'sheet-{len(paths) + 1}.png')
        sheet.save(path, optimize=True)
        paths.append(path)
    return paths


def page_image(pdf, number, out_dir=QA_DIR, width=1500):
    """One full-size page render, for a closer look at a single page or slide."""
    os.makedirs(out_dir, exist_ok=True)
    rendered = render_pages(pdf, [number], width=width)
    if not rendered:
        raise ValueError(f'page {number} does not exist')
    path = os.path.join(out_dir, f'page-{number:02d}.png')
    rendered[0][1].save(path, optimize=True)
    return path


def _pdf_text(pdf):
    if shutil.which('pdftotext'):
        return subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, timeout=120).stdout
    import pypdfium2 as pdfium

    return '\n'.join(page.get_textpage().get_text_range() for page in pdfium.PdfDocument(pdf))


def text_dump(path, limit=None):
    """Plain text of any supported file (markitdown for Office, pdftotext for PDF).

    Without markitdown, an Office file is converted to PDF and its text layer read instead.
    """
    if path.lower().endswith('.pdf'):
        out = _pdf_text(path)
    elif shutil.which('markitdown'):
        out = subprocess.run(['markitdown', path], capture_output=True, text=True, timeout=120).stdout
    else:
        out = _pdf_text(soffice(path, 'pdf'))
    return out if limit is None else out[:limit]


def parse_pages(spec):
    """'1-3,7' → [1, 2, 3, 7]."""
    pages = []
    for part in (spec or '').split(','):
        part = part.strip()
        if '-' in part:
            start, end = part.split('-', 1)
            pages.extend(range(int(start), int(end) + 1))
        elif part:
            pages.append(int(part))
    return pages or None


def qa(path, extra_problems=None, pages=None, label='Page'):
    """Validate, convert to PDF, render contact sheets; print a JSON summary; exit code 0/1."""
    ensure_fonts()
    kind = path.rsplit('.', 1)[-1].lower()
    problems = [] if kind == 'pdf' else validate_ooxml(path)
    problems += list(extra_problems or [])
    summary = {'file': path, 'problems': problems}
    try:
        source = fit_sheets_to_width(path) if kind in ('xlsx', 'xlsm') else path
        pdf = path if kind == 'pdf' else soffice(source, 'pdf')
        summary['pages'] = page_count(pdf)
        selected = pages or list(range(1, min(summary['pages'], PER_SHEET * MAX_SHEETS) + 1))
        summary['sheets'] = contact_sheets(render_pages(pdf, selected), label=label)
        if summary['pages'] > PER_SHEET * MAX_SHEETS and not pages:
            summary['note'] = (
                f'only {label.lower()}s 1-{PER_SHEET * MAX_SHEETS} are on the sheets; '
                'run again with --pages for the rest'
            )
        summary['fonts'] = pdf_fonts(pdf)
        text = text_dump(pdf)
        summary['placeholder_text'] = sorted({m.group(0) for m in PLACEHOLDER_RE.finditer(text)})
    except Exception as exc:
        problems.append(f'could not render: {exc}')
    print(json.dumps(summary, indent=1))
    if summary.get('sheets'):
        print('Next: read_file each path in "sheets" and check it for overflow, overlap, '
              'contrast and leftover placeholders before delivering.')
    return 1 if problems else 0


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(prog='office_qa.py')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('page', help='render one page/slide at full width')
    p.add_argument('file')
    p.add_argument('number', type=int)
    p = sub.add_parser('qa', help='validate, render contact sheets, report')
    p.add_argument('file')
    p.add_argument('--pages')
    args = parser.parse_args(argv)
    if args.command == 'qa':
        return qa(args.file, pages=parse_pages(args.pages))
    ensure_fonts()
    kind = args.file.rsplit('.', 1)[-1].lower()
    source = fit_sheets_to_width(args.file) if kind in ('xlsx', 'xlsm') else args.file
    pdf = args.file if kind == 'pdf' else soffice(source, 'pdf')
    print(page_image(pdf, args.number))
    return 0


if __name__ == '__main__':
    sys.exit(main())

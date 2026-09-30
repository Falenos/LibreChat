"""
[knauf] KK20-398 — inventory of the code sandbox's document stack.

Runs INSIDE the ACA code-interpreter sandbox (it is sent as code, never imported) and writes
a JSON report to /mnt/data/doc-stack-probe.json. It answers what the Office/PDF skills may
rely on: which Python packages and binaries exist, which fonts fontconfig sees, whether
LibreOffice converts and a rasteriser renders within budget, and whether any of that leaves
litter in /mnt/data. Driven by probe-doc-stack.mjs; the report is committed as evidence next
to knauf/docs/code-execution/sandbox-inventory.md, which summarises it.
"""
import importlib.metadata as md
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import time

REPORT = '/mnt/data/doc-stack-probe.json'
TMP = '/tmp/karl-probe'
os.makedirs(TMP, exist_ok=True)

MODULES = {
    'docx': 'python-docx', 'pptx': 'python-pptx', 'openpyxl': 'openpyxl',
    'xlsxwriter': 'XlsxWriter', 'xlrd': 'xlrd', 'pyxlsb': 'pyxlsb', 'odf': 'odfpy',
    'reportlab': 'reportlab', 'pypdf': 'pypdf', 'PyPDF2': 'PyPDF2', 'pdfplumber': 'pdfplumber',
    'pdfminer': 'pdfminer.six', 'fitz': 'PyMuPDF', 'pypdfium2': 'pypdfium2', 'fpdf': 'fpdf2',
    'pdf2image': 'pdf2image', 'pytesseract': 'pytesseract', 'camelot': 'camelot-py',
    'weasyprint': 'weasyprint', 'docx2pdf': 'docx2pdf', 'mammoth': 'mammoth',
    'markdown': 'Markdown', 'markitdown': 'markitdown', 'defusedxml': 'defusedxml',
    'lxml': 'lxml', 'PIL': 'Pillow', 'fontTools': 'fonttools', 'cairosvg': 'CairoSVG',
    'svglib': 'svglib', 'matplotlib': 'matplotlib', 'pandas': 'pandas', 'numpy': 'numpy',
    'bs4': 'beautifulsoup4', 'qrcode': 'qrcode', 'seaborn': 'seaborn', 'plotly': 'plotly',
    'scipy': 'scipy', 'sklearn': 'scikit-learn', 'pyarrow': 'pyarrow', 'docx2txt': 'docx2txt',
}
BINARIES = [
    'soffice', 'libreoffice', 'pandoc', 'markitdown', 'pdftoppm', 'pdftotext', 'pdfinfo', 'pdffonts',
    'pdfimages', 'qpdf', 'gs', 'tesseract', 'mutool', 'convert', 'rsvg-convert', 'inkscape',
    'node', 'npm', 'java', 'fc-list', 'fc-cache', 'fc-match', 'unzip', 'zip',
]


def run(cmd, timeout=60, env=None):
    started = time.monotonic()
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return {
            'rc': done.returncode,
            'ms': int((time.monotonic() - started) * 1000),
            'out': done.stdout[-600:],
            'err': done.stderr[-600:],
        }
    except Exception as exc:  # the probe must report, never crash
        return {'rc': None, 'ms': int((time.monotonic() - started) * 1000), 'error': repr(exc)}


def module_version(module, dist):
    # Distribution metadata first: the IPython kernel pre-imports some packages (PIL, lxml,
    # matplotlib) in a way that makes find_spec report None although they import fine.
    try:
        return md.version(dist)
    except Exception:
        pass
    try:
        return 'present' if importlib.util.find_spec(module) is not None else None
    except Exception:
        return None


def listing():
    found = []
    for root, dirs, files in os.walk('/mnt/data'):
        for name in files:
            found.append(os.path.relpath(os.path.join(root, name), '/mnt/data'))
    return sorted(found)


report = {'version': 1, 'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
before = listing()
report['python'] = sys.version.split()[0]
report['platform'] = platform.platform()
report['env'] = {k: os.environ.get(k) for k in ('HOME', 'USER', 'PATH', 'LANG', 'TMPDIR')}
report['cwd'] = os.getcwd()
report['cpu_count'] = os.cpu_count()
report['tmp_free_mb'] = shutil.disk_usage('/tmp').free // (1024 * 1024)
report['mnt_data_free_mb'] = shutil.disk_usage('/mnt/data').free // (1024 * 1024)
report['modules'] = {m: module_version(m, d) for m, d in MODULES.items()}
report['binaries'] = {b: shutil.which(b) for b in BINARIES}
report['versions'] = {
    'soffice': run(['soffice', '--version'], 60) if shutil.which('soffice') else None,
    'pandoc': run(['pandoc', '--version'], 20) if shutil.which('pandoc') else None,
    'node': run(['node', '--version'], 10) if shutil.which('node') else None,
}
fams = run(['fc-list', ':', 'family'], 30) if shutil.which('fc-list') else None
if fams and fams.get('rc') == 0:
    full = subprocess.run(['fc-list', ':', 'family'], capture_output=True, text=True).stdout
    report['font_families'] = sorted({f.strip() for line in full.splitlines() for f in line.split(',') if f.strip()})
for family in ('Arial', 'Calibri', 'Liberation Sans', 'Carlito', 'DejaVu Sans'):
    if shutil.which('fc-match'):
        report.setdefault('fc_match', {})[family] = run(['fc-match', family], 10).get('out', '').strip()

# LibreOffice round trip, entirely inside /tmp with a throwaway profile.
lo_env = dict(os.environ, HOME=f'{TMP}/home')
os.makedirs(lo_env['HOME'], exist_ok=True)
lo = ['soffice', f'-env:UserInstallation=file://{TMP}/lo-profile', '--headless', '--norestore']
conversions = {}
if report['modules'].get('docx'):
    import docx
    document = docx.Document()
    document.add_heading('Probe report', level=1)
    for i in range(30):
        document.add_paragraph(f'Paragraph {i} ' + 'lorem ipsum ' * 20)
    document.save(f'{TMP}/probe.docx')
if report['modules'].get('pptx'):
    from pptx import Presentation
    deck = Presentation()
    for i in range(10):
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = f'Slide {i + 1}'
        slide.placeholders[1].text = 'Point one\nPoint two'
    deck.save(f'{TMP}/deck.pptx')
if shutil.which('soffice'):
    for src in ('probe.docx', 'deck.pptx'):
        if os.path.exists(f'{TMP}/{src}'):
            conversions[src] = run(lo + ['--convert-to', 'pdf', '--outdir', f'{TMP}/out', f'{TMP}/{src}'], 120, lo_env)
report['soffice_to_pdf'] = conversions

raster = {}
# Rasterise the 10-slide deck: the QA loop renders every slide, so time the whole thing.
pdfs = [p for p in (f'{TMP}/out/deck.pdf', f'{TMP}/out/probe.pdf') if os.path.exists(p)]
if pdfs and shutil.which('pdftoppm'):
    raster['pdftoppm'] = run(['pdftoppm', '-png', '-r', '80', pdfs[0], f'{TMP}/page'], 60)
if pdfs and report['modules'].get('pypdfium2'):
    started = time.monotonic()
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdfs[0])
        for index in range(len(doc)):
            doc[index].render(scale=1).to_pil().save(f'{TMP}/pdfium-{index}.png')
        raster['pypdfium2'] = {'rc': 0, 'ms': int((time.monotonic() - started) * 1000)}
    except Exception as exc:
        raster['pypdfium2'] = {'rc': None, 'error': repr(exc)}
if pdfs and report['modules'].get('fitz'):
    started = time.monotonic()
    try:
        import fitz
        for index, page in enumerate(fitz.open(pdfs[0])):
            page.get_pixmap(dpi=80).save(f'{TMP}/fitz-{index}.png')
        raster['fitz'] = {'rc': 0, 'ms': int((time.monotonic() - started) * 1000)}
    except Exception as exc:
        raster['fitz'] = {'rc': None, 'error': repr(exc)}
report['rasterise'] = raster
report['tmp_outputs'] = sorted(os.listdir(f'{TMP}/out')) if os.path.isdir(f'{TMP}/out') else []

# Fonts from a private folder: does fontconfig pick up /tmp fonts via FONTCONFIG_FILE?
fc_conf = f'{TMP}/fonts.conf'
with open(fc_conf, 'w') as fh:
    fh.write(
        '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
        f'<include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>{TMP}/fonts</dir>'
        f'<cachedir>{TMP}/fc-cache</cachedir></fontconfig>'
    )
os.makedirs(f'{TMP}/fonts', exist_ok=True)
report['fontconfig_file_honoured'] = (
    run(['fc-list'], 30, dict(os.environ, FONTCONFIG_FILE=fc_conf)).get('rc') == 0
    if shutil.which('fc-list') else None
)

# Functional checks, run the way the adapter runs user code: a fresh python3 subprocess.
FUNCTIONAL = r'''
import json, os, subprocess, sys, time
T = '/tmp/karl-probe/fn'
os.makedirs(T, exist_ok=True)
out = {}
def check(name, fn):
    started = time.monotonic()
    try:
        out[name] = {'ok': True, 'detail': fn(), 'ms': int((time.monotonic() - started) * 1000)}
    except Exception as exc:
        out[name] = {'ok': False, 'error': repr(exc)[:300], 'ms': int((time.monotonic() - started) * 1000)}
def imports():
    import PIL, lxml, matplotlib, docx, pptx, openpyxl, reportlab, pypdf, pdfplumber, fitz, pypdfium2
    return {'PIL': PIL.__version__, 'matplotlib': matplotlib.__version__}
check('subprocess_imports', imports)
def versions():
    import importlib.metadata as md
    dists = ['python-docx', 'python-pptx', 'openpyxl', 'XlsxWriter', 'reportlab', 'pypdf',
             'PyPDF2', 'pdfplumber', 'PyMuPDF', 'pypdfium2', 'weasyprint', 'fonttools', 'Pillow',
             'lxml', 'matplotlib', 'seaborn', 'plotly', 'pandas', 'numpy', 'markitdown',
             'defusedxml', 'cairosvg', 'svglib', 'fpdf2', 'camelot-py', 'pdf2image']
    found = {}
    for dist in dists:
        try:
            found[dist] = md.version(dist)
        except Exception:
            found[dist] = None
    return {'executable': sys.executable, 'dists': found}
check('bash_python3_versions', versions)
def weasy():
    from weasyprint import HTML
    HTML(string='<h1 style="font-family:Liberation Sans">Probe</h1><p>é ß ü</p>').write_pdf(f'{T}/weasy.pdf')
    return os.path.getsize(f'{T}/weasy.pdf')
check('weasyprint_html_to_pdf', weasy)
def rl_ttf():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    path = subprocess.run(['fc-match', '-f', '%{file}', 'Liberation Sans'], capture_output=True, text=True).stdout
    pdfmetrics.registerFont(TTFont('ProbeSans', path))
    c = canvas.Canvas(f'{T}/rl.pdf'); c.setFont('ProbeSans', 12); c.drawString(72, 720, 'Embedded ü'); c.save()
    fonts = subprocess.run(['pdffonts', f'{T}/rl.pdf'], capture_output=True, text=True).stdout if os.path.exists('/usr/bin/pdffonts') else ''
    return {'font_file': path, 'pdffonts': fonts[-300:]}
check('reportlab_ttf_embed', rl_ttf)
def pptx_chart():
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    prs = Presentation(); s = prs.slides.add_slide(prs.slide_layouts[6])
    data = CategoryChartData(); data.categories = ['Q1', 'Q2']; data.add_series('Revenue', (1.0, 2.0))
    s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1), Inches(6), Inches(4), data)
    prs.save(f'{T}/chart.pptx'); return os.path.getsize(f'{T}/chart.pptx')
check('pptx_native_chart', pptx_chart)
def xlsx_recalc():
    from openpyxl import Workbook, load_workbook
    wb = Workbook(); ws = wb.active; ws['A1'] = 2; ws['A2'] = 3; ws['A3'] = '=SUM(A1:A2)'; wb.save(f'{T}/m.xlsx')
    env = dict(os.environ, HOME=f'{T}/home')
    r = subprocess.run(['soffice', f'-env:UserInstallation=file://{T}/lo', '--headless', '--norestore',
                        '--calc', '--convert-to', 'xlsx', '--outdir', f'{T}/rc', f'{T}/m.xlsx'],
                       capture_output=True, text=True, timeout=120, env=env)
    return {'rc': r.returncode, 'A3': load_workbook(f'{T}/rc/m.xlsx', data_only=True).active['A3'].value}
check('xlsx_libreoffice_recalc', xlsx_recalc)
def docx_image_and_toc_fields():
    import docx
    from docx.shared import Inches
    from PIL import Image
    Image.new('RGB', (200, 60), (0, 55, 120)).save(f'{T}/logo.png')
    d = docx.Document(); d.add_heading('Heading', 1); d.add_picture(f'{T}/logo.png', width=Inches(2)); d.save(f'{T}/img.docx')
    return os.path.getsize(f'{T}/img.docx')
check('docx_picture', docx_image_and_toc_fields)
print(json.dumps(out))
'''
fn = subprocess.run(['python3', '-B', '-c', FUNCTIONAL], capture_output=True, text=True, timeout=180)
try:
    report['functional'] = json.loads(fn.stdout.strip().splitlines()[-1])
except Exception:
    report['functional'] = {'rc': fn.returncode, 'stdout': fn.stdout[-500:], 'stderr': fn.stderr[-800:]}
report['python3_on_path'] = shutil.which('python3')

try:
    pip = subprocess.run([sys.executable, '-m', 'pip', 'list', '--format=json'], capture_output=True, text=True, timeout=60)
    report['pip_list'] = json.loads(pip.stdout) if pip.returncode == 0 else pip.stderr[-400:]
except Exception as exc:
    report['pip_list'] = repr(exc)

after = listing()
report['mnt_data_new_files'] = sorted(set(after) - set(before) - {os.path.basename(REPORT)})
report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
with open(REPORT, 'w') as fh:
    json.dump(report, fh, indent=1, sort_keys=True)
print('probe written', REPORT, os.path.getsize(REPORT), 'bytes')

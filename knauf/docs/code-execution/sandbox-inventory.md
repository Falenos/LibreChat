# Code sandbox inventory — the document stack (verified)

**Probed:** 2026-09-29 against `sp-code-py-spike` (West Europe, CT-SANDBOX). That is the
built-in **PythonLTS** code-interpreter image with egress disabled, the same image every
KARL environment routes `py` and `bash` to (see [how-it-works.md](how-it-works.md)).
**Ticket:** KK20-398.

**Evidence:**
- raw report: [`sandbox-inventory-2026-09-29.json`](../../code-adapter/test/fixtures/aca/sandbox-inventory-2026-09-29.json)
- script: [`probe-doc-stack.py`](../../code-adapter/scripts/probe-doc-stack.py), run by
  [`probe-doc-stack.mjs`](../../code-adapter/scripts/probe-doc-stack.mjs)

Microsoft updates this image without notice, so re-run the probe and diff the reports whenever
a skill starts failing on an import:

```bash
cd knauf/code-adapter
ACA_POOL_ENDPOINT=<pool management endpoint> node scripts/probe-doc-stack.mjs > report.json
```

## Two Pythons — and `bash_tool` uses the second

| | Interpreter | Used by |
|---|---|---|
| Kernel | the IPython kernel's own Python 3.12.7 | the adapter's wrapper; `lang=py` user code (`sys.executable`) |
| **`snenv`** | `/home/ubuntu/snenv/bin/python3` (first `python3` on `PATH`) | **`bash_tool` → `python3 << 'PY'`**, which is how the skills tell the model to run Python |

They share most packages but not all versions. For example, Pillow is 11.3.0 in `snenv` and
10.4.0 in the kernel. Skills must state facts about `snenv`. Pillow, lxml and matplotlib import
fine in `snenv` but ship no distribution metadata there, so `importlib.metadata` reports them
missing. Only an import test is authoritative.

## Libraries (`snenv`, the `bash_tool` interpreter)

| Need | Available | Notes |
|---|---|---|
| Word create/edit | **python-docx 1.2.0**, lxml, defusedxml 0.7.1 | picture insertion verified |
| PowerPoint create/edit | **python-pptx 1.0.2** | native chart (`add_chart`) verified |
| Excel | **openpyxl 3.1.5**, **XlsxWriter 3.2.9**, pandas 2.2.2, xlrd, pyxlsb | no odfpy (`.ods`) |
| PDF create | **reportlab 4.4.6** (TTF subset embedding verified with `pdffonts`), **WeasyPrint 66.0** (HTML/CSS → PDF verified), fpdf (legacy) | |
| PDF read/manipulate | **pypdf 5.9.0**, PyPDF2 3.0.1, **pdfplumber 0.11.8**, pdfminer.six, camelot 1.0.9 | no qpdf |
| Rasterise pages (visual QA) | **pypdfium2 5.2.0** (10 slides ≈ 0.13 s), **PyMuPDF 1.26.7** (≈ 0.2 s), pdf2image 1.17 + `pdftoppm` (≈ 0.3 s) | all three work |
| Fonts | fontTools 4.51.0 | |
| SVG | CairoSVG 2.8.2, svglib 1.6.0, `rsvg-convert` | the wordmark SVG can be rasterised in the sandbox |
| Charts | matplotlib (imports), **seaborn 0.13.2** | plotly is in the kernel only, not in `snenv` |
| Text dump | markitdown 0.1.4, `pandoc` 3.1.3, `pdftotext`, `pdfinfo`, `pdffonts`, `pdfimages` | |
| OCR | pytesseract, but **no `tesseract` binary** | OCR is not available; scanned PDFs go to file search, which uses Azure DI |

## Binaries

| Present | Absent |
|---|---|
| `soffice`/`libreoffice` **24.2.7.2**, `pandoc` 3.1.3, `markitdown`, `pdftoppm`, `pdftotext`, `pdfinfo`, `pdffonts`, `pdfimages`, `rsvg-convert`, `fc-list`/`fc-match`/`fc-cache`, `java` | `node`/`npm` (so Anthropic's docx-js/pptxgenjs route is out), `qpdf`, `gs`, `tesseract`, ImageMagick `convert`, `mutool`, `inkscape`, **`zip`/`unzip`** (use Python `zipfile`) |

## Fonts

1,583 families, including **Liberation Sans/Serif/Mono** (metric-compatible with
Arial/Times/Courier), **Carlito** (Calibri), **Caladea** (Cambria), DejaVu, and a broad Noto
set. `fc-match Arial` → Liberation Sans and `fc-match Calibri` → Carlito, so LibreOffice
renders layout-faithful QA for those faces.

A private font folder works: a `FONTCONFIG_FILE` that includes `/etc/fonts/fonts.conf` and
adds `<dir>/tmp/…/fonts</dir>` with a `/tmp` cache is honoured. That is how the Knauf fonts
shipped in `skill/karl-brand/sandbox/` are made visible to LibreOffice and WeasyPrint.
reportlab registers the TTF by path instead.

## Timings (4 vCPU)

| Step | Time |
|---|---|
| LibreOffice DOCX → PDF (30 paragraphs), cold profile | ~2.1 s |
| LibreOffice PPTX → PDF (10 slides) | ~1.4 s |
| LibreOffice XLSX formula recalculation | ~2.2 s |
| WeasyPrint HTML → PDF (first call) | ~1.0 s |
| Whole probe | 8–16 s of the 220 s budget |

## Hygiene (verified)

- Working in `/tmp` with `HOME=/tmp/…` and `-env:UserInstallation=file:///tmp/…` leaves
  **nothing** in `/mnt/data`. The probe's before/after listing was identical.
- The pool's own `HOME` is `/home/ubuntu`, not under `/mnt/data`. Code-adapter 0.4.0 still
  redirects it defensively, and sets `PYTHONDONTWRITEBYTECODE`.
- `/tmp` has about 14 GB free; it is per-execution scratch space.

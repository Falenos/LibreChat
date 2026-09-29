"""Knauf brand for files built in the code sandbox: tokens, fonts and the wordmark.

Import it from the mounted skill folder (the karl-brand skill must have been invoked so its
files are in the sandbox):

    import sys; sys.path.insert(0, '/mnt/data/karl-brand/scripts')
    import knauf_brand as kb
    fonts = kb.install_fonts()      # {'body': 'Knauf Screen' or 'Arial', 'heading': ..., ...}
    kb.hex('ink.heading')           # 'RRGGBB' for python-pptx / openpyxl / python-docx
    kb.rgb('brand.cyanBlue')        # (r, g, b) for Pillow / reportlab
    kb.wordmark_png(height_px=240)  # PNG path of the official mark, for Word/PowerPoint

The colour values are transcribed from skills/karl-brand/SKILL.md, which owns them; a
repository test keeps the two identical.
"""
import os
import re
import sys
import zipfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
FONT_ZIP = os.path.join(SKILL_DIR, 'sandbox', 'knauf-fonts.zip')
WORDMARK_SVG = os.path.join(SKILL_DIR, 'assets', 'knauf-wordmark.svg')
FONT_DIR = '/tmp/knauf-fonts'
FALLBACK_FAMILY = 'Arial'
BODY_FAMILY = 'Knauf Screen'
HEADING_FAMILY = 'Knauf Screen Head'
FONT_EXTENSIONS = ('.ttf', '.otf')

KNAUF = {
    'brand': {
        'cyanBlue': '#0099DE',
        'logoCyan': '#00A0E6',
        'accessibleBlue': '#003778',
        'darkGreen': '#004B46',
        'lightGreen': '#87C15F',
        'orange': '#F06E00',
        'yellow': '#FFD25C',
        'grey': '#CFD7D9',
    },
    'ink': {
        'primary': '#0F1A2A',
        'secondary': '#3A4A5C',
        'muted': '#5B6770',
        'heading': '#003778',
        'accentOnBrand': '#66BCE8',
        'onDark': '#E6EEF5',
        'mutedOnDark': '#9FB0BF',
        'headingOnDark': '#E6EEF5',
    },
    'surface': {
        'page': '#F4F8FB',
        'card': '#FFFFFF',
        'border': '#DCE6EE',
        'pageDark': '#0F1720',
        'cardDark': '#16212E',
        'borderDark': '#26333F',
        'neutral': '#CFD7D9',
    },
    'categorical': ['#0099DE', '#D96400', '#009184', '#7A4FB5', '#5A9A32', '#C43A8B', '#B8860B'],
    'categoricalAllPairs': ['#0099DE', '#D96400', '#7A4FB5'],
    'ordinalCerulean': ['#66BCE8', '#0099DE', '#0077B0', '#00527A'],
    'sequentialCerulean': ['#E5F3FB', '#B3DCF3', '#66BCE8', '#0099DE', '#0077B0', '#00527A'],
    'status': {'success': '#1F883D', 'warning': '#C98A00', 'serious': '#E8792A', 'critical': '#D64550'},
}


def token(path):
    """The hex for a dotted token path, e.g. 'ink.heading' or 'categorical.2'."""
    value = KNAUF
    for key in path.split('.'):
        value = value[int(key)] if isinstance(value, list) else value[key]
    if not isinstance(value, str):
        raise KeyError(f'{path} is a group, not a colour')
    return value


def hex(path):  # noqa: A001 - the name reads naturally at call sites: kb.hex('ink.heading')
    """'RRGGBB' (no '#'), the form python-pptx, python-docx and openpyxl take."""
    return token(path).lstrip('#').upper()


def rgb(path):
    """(r, g, b) integers, the form Pillow and reportlab take."""
    value = hex(path)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _font_names(path):
    from fontTools.ttLib import TTFont

    font = TTFont(path, lazy=True)
    names = {record.nameID: record.toUnicode() for record in font['name'].names if record.nameID in (1, 2, 16, 17)}
    return names.get(16) or names.get(1), names.get(17) or names.get(2) or 'Regular'


def install_fonts():
    """Make the Knauf fonts visible to LibreOffice, WeasyPrint and fontconfig in this process.

    Returns the family to write into documents and the font files by style. When the font
    archive is not in the sandbox (karl-brand not invoked, or no licensed fonts shipped), the
    families fall back to Arial, which the brand kit sanctions and LibreOffice renders with a
    metric-compatible face.
    """
    result = {'body': FALLBACK_FAMILY, 'heading': FALLBACK_FAMILY, 'files': {}, 'installed': False}
    if not os.path.exists(FONT_ZIP):
        return result
    os.makedirs(FONT_DIR, exist_ok=True)
    with zipfile.ZipFile(FONT_ZIP) as archive:
        for member in archive.infolist():
            name = os.path.basename(member.filename)
            if member.is_dir() or not name.lower().endswith(FONT_EXTENSIONS) or name.startswith('.'):
                continue  # only font files, flattened: no paths from the archive are trusted
            with archive.open(member) as src, open(os.path.join(FONT_DIR, name), 'wb') as dst:
                dst.write(src.read())
    conf = os.path.join(FONT_DIR, 'fonts.conf')
    with open(conf, 'w') as handle:
        handle.write(
            '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
            '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>'
            f'<dir>{FONT_DIR}</dir><cachedir>{FONT_DIR}/cache</cachedir></fontconfig>'
        )
    os.environ['FONTCONFIG_FILE'] = conf
    for name in sorted(os.listdir(FONT_DIR)):
        if not name.lower().endswith(FONT_EXTENSIONS):
            continue
        try:
            family, style = _font_names(os.path.join(FONT_DIR, name))
        except Exception:
            os.remove(os.path.join(FONT_DIR, name))  # not a readable font: never offer it
            continue
        result['files'].setdefault(family, {})[style] = os.path.join(FONT_DIR, name)
    families = sorted(result['files'])
    heading = [f for f in families if re.search(r'\bhead', f, re.IGNORECASE)]
    body = [f for f in families if f not in heading and not re.search(r'\bnarrow', f, re.IGNORECASE)]
    body = [BODY_FAMILY] if BODY_FAMILY in families else body
    heading = [HEADING_FAMILY] if HEADING_FAMILY in families else heading
    if body:
        result['body'] = body[0]
        result['heading'] = heading[0] if heading else body[0]
        result['installed'] = True
    return result


def wordmark_png(fill='logo', height_px=240, out=None):
    """PNG of the official wordmark. fill: 'logo' (cyan, on white) or 'white' (on a brand field).

    Never recolour it any other way — the brand book allows only these two fills.
    """
    import cairosvg

    colours = {'logo': token('brand.logoCyan'), 'white': '#FFFFFF'}
    if fill not in colours:
        raise ValueError("fill must be 'logo' or 'white'")
    with open(WORDMARK_SVG) as handle:
        svg = handle.read().replace(token('brand.logoCyan'), colours[fill])
    out = out or f'/tmp/knauf-wordmark-{fill}-{height_px}.png'
    cairosvg.svg2png(bytestring=svg.encode(), write_to=out, output_height=height_px)
    return out


WORDMARK_ASPECT = 283.4646 / 143.4898  # width / height; size by height, never stretch

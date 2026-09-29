// [knauf] KK20-374 — reproducible translation-quality and fidelity fixtures.
'use strict';

const JSZip = require('jszip');
const sharp = require('sharp');

const BENCHMARK_CASES = Object.freeze([
  {
    id: 'office-docx-de',
    filename: 'office-layout.docx',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Agentic Karl', 'Knauf'],
    referenceText: 'Agentic Karl unterstützt Knauf bei der Dokumentübersetzung.',
  },
  {
    id: 'office-pptx-ar',
    filename: 'presentation-rtl.pptx',
    sourceLocale: 'en',
    targetLocale: 'ar',
    protectedTerms: ['Agentic Karl', 'Knauf'],
    referenceText: 'يساعد Agentic Karl شركة Knauf في ترجمة المستندات.',
  },
  {
    id: 'office-xlsx-de',
    filename: 'workbook-units.xlsx',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Knauf'],
    referenceText: 'Knauf Platte – 12,5 mm – 28.09.2026',
  },
  {
    id: 'pdf-layout-de',
    filename: 'brochure-layout.pdf',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Agentic Karl', 'Knauf'],
    referenceText: 'Agentic Karl unterstützt Knauf.',
  },
  {
    id: 'image-png-de',
    filename: 'campaign-banner.png',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Knauf'],
    referenceText: 'Bessere Räume mit Knauf',
  },
  {
    id: 'image-jpeg-de',
    filename: 'product-label.jpeg',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Knauf'],
    referenceText: 'Knauf Platte – 12,5 mm',
  },
  {
    id: 'image-webp-ar',
    filename: 'rtl-banner.webp',
    sourceLocale: 'en',
    targetLocale: 'ar',
    protectedTerms: ['Knauf'],
    referenceText: 'مساحات أفضل مع Knauf',
  },
  {
    id: 'idml-styles-de',
    filename: 'catalog-styles.idml',
    sourceLocale: 'en',
    targetLocale: 'de',
    protectedTerms: ['Agentic Karl', 'Knauf'],
    referenceText: 'Agentic Karl unterstützt Knauf.',
  },
]);

const xml = (value) => Buffer.from(value, 'utf8');

async function createBrandAsset() {
  return sharp({
    create: {
      width: 32,
      height: 16,
      channels: 4,
      background: { r: 0, g: 92, b: 169, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function buildZip(entries, mimetype) {
  const zip = new JSZip();
  if (mimetype) {
    zip.file('mimetype', mimetype, { compression: 'STORE', createFolders: false });
  }
  for (const [name, value] of Object.entries(entries)) {
    zip.file(name, value, { createFolders: false });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
}

async function buildDocxFixture(asset) {
  return buildZip({
    '[Content_Types].xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
        '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
    'word/document.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>Agentic Karl helps Knauf translate documents.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Panel thickness: 12.5 mm — 09/28/2026</w:t></w:r></w:p>' +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
        '</w:body></w:document>',
    ),
    'word/styles.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:rPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '</w:styles>',
    ),
    'word/fontTable.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Arial"/></w:fonts>',
    ),
    'word/theme/theme1.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Knauf"><a:themeElements/></a:theme>',
    ),
    'word/_rels/document.xml.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/knauf.png"/>' +
        '</Relationships>',
    ),
    'word/media/knauf.png': asset,
  });
}

async function buildPptxFixture(asset) {
  return buildZip({
    '[Content_Types].xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        '</Relationships>',
    ),
    'ppt/presentation.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
        '</p:presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
        '</Relationships>',
    ),
    'ppt/slides/slide1.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Translation benchmark"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
        '<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10058400" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400" typeface="Arial"/><a:t>Agentic Karl helps Knauf translate documents.</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody>' +
        '</p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    ),
    'ppt/slides/_rels/slide1.xml.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/knauf.png"/>' +
        '</Relationships>',
    ),
    'ppt/theme/theme1.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Knauf"><a:themeElements/></a:theme>',
    ),
    'ppt/media/knauf.png': asset,
  });
}

async function buildXlsxFixture(asset) {
  return buildZip({
    '[Content_Types].xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
        '</Relationships>',
    ),
    'xl/worksheets/sheet1.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>Knauf board</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>12.5 mm</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>09/28/2026</t></is></c>' +
        '</row></sheetData></worksheet>',
    ),
    'xl/styles.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    ),
    'xl/theme/theme1.xml': xml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Knauf"><a:themeElements/></a:theme>',
    ),
    'xl/drawings/_rels/drawing1.xml.rels': xml(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ),
    'xl/media/knauf.png': asset,
  });
}

async function buildIdmlFixture(asset) {
  return buildZip(
    {
      'designmap.xml': xml(
        '<?xml version="1.0"?><Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><idPkg:Story src="Stories/Story_u1.xml"/></Document>',
      ),
      'Stories/Story_u1.xml': xml(
        '<?xml version="1.0"?><idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u1"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange AppliedFont="Arial" FontStyle="Regular"><Content>Agentic Karl helps Knauf.</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>',
      ),
      'Resources/Fonts.xml': xml(
        '<?xml version="1.0"?><idPkg:Fonts xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><FontFamily Self="Arial"/></idPkg:Fonts>',
      ),
      'Resources/Styles.xml': xml(
        '<?xml version="1.0"?><idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><ParagraphStyle Self="ParagraphStyle/Body"/></idPkg:Styles>',
      ),
      'Links/knauf.png': asset,
    },
    'application/vnd.adobe.indesign-idml-package',
  );
}

function buildPdfFixture() {
  const encode = (value) => Buffer.from(value, 'latin1');
  const content = encode('BT /F1 18 Tf 40 160 Td (Agentic Karl helps Knauf.) Tj ET\n');
  const objects = [
    encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    encode('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    encode(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    ),
    encode(
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    ),
    Buffer.concat([
      encode(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`),
      content,
      encode('endstream\nendobj\n'),
    ]),
  ];
  const header = encode('%PDF-1.4\n');
  const offsets = [0];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xrefStart = offset;
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `),
  ].join('\n');
  return Buffer.concat([
    header,
    ...objects,
    encode(`${xref}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`),
  ]);
}

async function buildImageFixture(format) {
  const image = sharp({
    create: {
      width: 320,
      height: 180,
      channels: 4,
      background: { r: 245, g: 248, b: 252, alpha: 1 },
    },
  }).composite([
    {
      input: {
        text: {
          text: '<span foreground="#005ca9" font="Arial 22">Knauf 12.5 mm</span>',
          rgba: true,
        },
      },
      left: 24,
      top: 70,
    },
  ]);
  if (format === 'jpeg') return image.jpeg({ quality: 90 }).toBuffer();
  if (format === 'webp') return image.webp({ quality: 90 }).toBuffer();
  return image.png().toBuffer();
}

async function buildBenchmarkFixtures() {
  const asset = await createBrandAsset();
  const buffers = {
    'office-docx-de': await buildDocxFixture(asset),
    'office-pptx-ar': await buildPptxFixture(asset),
    'office-xlsx-de': await buildXlsxFixture(asset),
    'pdf-layout-de': buildPdfFixture(),
    'image-png-de': await buildImageFixture('png'),
    'image-jpeg-de': await buildImageFixture('jpeg'),
    'image-webp-ar': await buildImageFixture('webp'),
    'idml-styles-de': await buildIdmlFixture(asset),
  };
  return BENCHMARK_CASES.map((definition) => ({
    ...definition,
    buffer: buffers[definition.id],
  }));
}

module.exports = {
  BENCHMARK_CASES,
  buildBenchmarkFixtures,
};

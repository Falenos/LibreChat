// [knauf] KK20-297 — structure-preserving adapters for generic file translation.
'use strict';

const {
  formatForFile,
  jsonAdapter,
  markdownAdapter,
  selectTranslationFiles,
  sourceLocaleRequirement,
  sourceLocaleRequired,
  svgAdapter,
  xmlAdapter,
} = require('./tool');

function translated(adapter, values) {
  return adapter.build(new Map(values.map((value, index) => [`t${index}`, value]))).toString();
}

describe('[knauf] file translation formats', () => {
  it.each([
    ['sample.idml', 'idml'],
    ['sample.pdf', 'batch'],
    ['sample.docx', 'document'],
    ['sample.csv', 'document'],
    ['sample.md', 'markdown'],
    ['sample.json', 'json'],
    ['sample.xml', 'xml'],
    ['sample.svg', 'svg'],
    ['sample.png', 'image'],
  ])('routes %s through the %s handler', (filename, mode) => {
    expect(formatForFile({ filename })).toMatchObject({ mode });
  });

  it('does not route source code through the text/plain fallback', () => {
    expect(formatForFile({ filename: 'component.tsx', type: 'text/plain' })).toBeNull();
    expect(formatForFile({ filename: 'notes.txt', type: 'text/plain' })).toMatchObject({
      mode: 'document',
    });
  });

  it('requires a source locale when the selected format cannot supply detection text', () => {
    const revision = process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
    const glossaryRequired = process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED;
    delete process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
    delete process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED;

    for (const filename of [
      'sample.idml',
      'sample.json',
      'sample.md',
      'sample.xml',
      'sample.svg',
    ]) {
      expect(sourceLocaleRequired([{ filename }])).toBe(true);
    }
    for (const filename of ['sample.docx', 'sample.pdf', 'sample.png']) {
      expect(sourceLocaleRequired([{ filename }])).toBe(false);
    }
    expect(sourceLocaleRequirement([{ filename: 'sample.docx' }], ['HERADESIGN'])).toBe(
      'source_locale is required when preserve_terms is used',
    );
    expect(sourceLocaleRequirement([{ filename: 'sample.json' }])).toBe(
      'source_locale is required for JSON translation',
    );

    process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = 'dictionary-sha';
    expect(sourceLocaleRequired([{ filename: 'sample.docx' }])).toBe(false);
    expect(sourceLocaleRequirement([{ filename: 'sample.docx' }])).toBeNull();
    expect(sourceLocaleRequirement([{ filename: 'sample.png' }])).toBe(
      'source_locale is required for PNG translation',
    );
    expect(sourceLocaleRequirement([{ filename: 'sample.pptx' }])).toBe(
      'source_locale is required for PPTX translation',
    );
    expect(sourceLocaleRequirement([{ filename: 'sample.json' }])).toBe(
      'source_locale is required for JSON translation',
    );
    if (revision == null) delete process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
    else process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION = revision;
    if (glossaryRequired == null) delete process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED;
    else process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED = glossaryRequired;
  });

  // [knauf] KK20-367 — implicit translation scope must prefer exactly one current attachment.
  it('selects the only current-message file without including historical files', () => {
    const current = { file_id: 'current', filename: 'new.pdf' };
    const historical = { file_id: 'historical', filename: 'older.pdf' };

    expect(selectTranslationFiles([current, historical], {}, [current.file_id])).toEqual([current]);
  });

  it('requires a named choice when multiple current-message files are available', () => {
    const first = { file_id: 'current-1', filename: 'first.pdf' };
    const second = { file_id: 'current-2', filename: 'second.pdf' };
    const historical = { file_id: 'historical', filename: 'older.pdf' };

    expect(() =>
      selectTranslationFiles([first, second, historical], {}, [first.file_id, second.file_id]),
    ).toThrow(
      expect.objectContaining({
        code: 'translation_file_selection_required',
        message: expect.stringContaining('first.pdf, second.pdf'),
      }),
    );
  });

  it('requires a named choice for an ambiguous historical follow-up', () => {
    const first = { file_id: 'historical-1', filename: 'first.pdf' };
    const second = { file_id: 'historical-2', filename: 'second.pdf' };

    expect(() => selectTranslationFiles([first, second])).toThrow(
      expect.objectContaining({
        code: 'translation_file_selection_required',
        message: expect.stringContaining('first.pdf, second.pdf'),
      }),
    );
  });

  it('requires an explicit filename for a historical-only follow-up', () => {
    const historical = { file_id: 'historical', filename: 'older.pdf' };

    expect(() => selectTranslationFiles([historical])).toThrow(
      expect.objectContaining({
        code: 'translation_file_selection_required',
        message: expect.stringContaining('older.pdf'),
      }),
    );
  });

  it('does not fall back to a historical file when the current message has no supported file', () => {
    const historical = { file_id: 'historical', filename: 'older.pdf' };

    expect(() => selectTranslationFiles([historical], {}, ['current-typescript'])).toThrow(
      expect.objectContaining({
        code: 'translation_file_selection_required',
        message: expect.stringContaining('No supported file is attached to the current message'),
      }),
    );
  });

  it('keeps explicit historical-file and translate-all selections available', () => {
    const current = { file_id: 'current', filename: 'new.pdf' };
    const historical = { file_id: 'historical', filename: 'older.pdf' };
    const files = [current, historical];

    expect(selectTranslationFiles(files, { filenames: ['older.pdf'] }, [current.file_id])).toEqual([
      historical,
    ]);
    expect(selectTranslationFiles(files, { all_files: true }, [current.file_id])).toEqual(files);
  });
  // End [knauf]

  it('translates JSON values while preserving keys and formatting', () => {
    const source = '{\n  "title": "Hello",\n  "items": ["Wall", 7],\n  "enabled": true\n}\n';
    const adapter = jsonAdapter(Buffer.from(source));

    expect(adapter.segments.map((segment) => segment.source)).toEqual(['Hello', 'Wall']);
    expect(translated(adapter, ['Hallo', 'Wand'])).toBe(
      '{\n  "title": "Hallo",\n  "items": ["Wand", 7],\n  "enabled": true\n}\n',
    );
  });

  it('keeps Markdown code and URLs byte-identical', () => {
    const source =
      '# Hello\n\nVisit https://example.test/a or use `npm test`.\n\n```js\nalert("Hello")\n```\n';
    const adapter = markdownAdapter(Buffer.from(source));
    const output = translated(
      adapter,
      adapter.segments.map((segment) => `DE:${segment.source}`),
    );

    expect(output).toContain('https://example.test/a');
    expect(output).toContain('`npm test`');
    expect(output).toContain('```js\nalert("Hello")\n```');
    expect(output).toContain('DE:Hello');
  });

  it('keeps Markdown destinations, references, indented code, and fence contents unchanged', () => {
    const source =
      '[Docs](../guide/page.md)\n\n[Guide][install]\n\n[install]: docs/install.md\n\n    npm run build\n\n````md\n```\nInside\n```\n````\n';
    const adapter = markdownAdapter(Buffer.from(source));
    const output = translated(
      adapter,
      adapter.segments.map((segment) => `DE:${segment.source}`),
    );

    expect(output).toContain('](../guide/page.md)');
    expect(output).toContain('[DE:Guide][install]');
    expect(output).toContain('[install]: docs/install.md');
    expect(output).toContain('    npm run build');
    expect(output).toContain('````md\n```\nInside\n```\n````');
    expect(adapter.segments.map((segment) => segment.source)).not.toEqual(
      expect.arrayContaining([
        '../guide/page.md',
        'install',
        'docs/install.md',
        'npm run build',
        'Inside',
      ]),
    );
  });

  it('bounds retained JSON and Markdown translation segments', () => {
    const json = `[${Array.from({ length: 10001 }, () => '"A"').join(',')}]`;
    const markdown = Array.from({ length: 10001 }, (_, index) => `Line ${index}\n`).join('');

    expect(() => jsonAdapter(Buffer.from(json))).toThrow(
      expect.objectContaining({ code: 'too_many_segments' }),
    );
    expect(() => markdownAdapter(Buffer.from(markdown))).toThrow(
      expect.objectContaining({ code: 'too_many_segments' }),
    );
  });

  it('translates only visible SVG text and rejects entities', () => {
    const adapter = svgAdapter(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><title>Icon</title><text>Hello <tspan>World</tspan></text><path d="M0 0"/></svg>',
      ),
    );
    const output = translated(adapter, ['Hallo ', 'Welt']);

    expect(output).toContain('<title>Icon</title>');
    expect(output).toContain('<text>Hallo <tspan>Welt</tspan></text>');
    expect(output).toContain('d="M0 0"');
    expect(() => svgAdapter(Buffer.from('<!DOCTYPE svg [<!ENTITY x "boom">]><svg/>'))).toThrow(
      expect.objectContaining({ code: 'unsafe_xml' }),
    );
  });

  it('bounds SVG translation segments before retaining them', () => {
    expect(() => svgAdapter(Buffer.from(`<svg>${'<text>A</text>'.repeat(10001)}</svg>`))).toThrow(
      expect.objectContaining({ code: 'too_many_segments' }),
    );
  });

  it('translates XML text nodes while preserving structure and outer whitespace', () => {
    const adapter = xmlAdapter(
      Buffer.from(
        '<?xml version="1.0"?><catalog xmlns:k="urn:knauf"><k:item id="A1">  Hello <b>World</b>  </k:item><!--keep--><?job keep?></catalog>',
      ),
    );
    const output = adapter
      .build(
        new Map([
          ['x0', 'Hallo'],
          ['x1', 'Welt'],
        ]),
      )
      .toString();

    expect(adapter.segments).toEqual([
      { id: 'x0', source: 'Hello', path: '/catalog[1]/k:item[1]/text()[1]' },
      { id: 'x1', source: 'World', path: '/catalog[1]/k:item[1]/b[1]/text()[1]' },
    ]);
    expect(adapter.elements).toEqual([
      { path: '/catalog[1]', attributes: { 'xmlns:k': 'urn:knauf' } },
      { path: '/catalog[1]/k:item[1]', attributes: { id: 'A1' } },
      { path: '/catalog[1]/k:item[1]/b[1]', attributes: {} },
    ]);
    expect(output).toContain('xmlns:k="urn:knauf"');
    expect(output).toContain('id="A1"');
    expect(output).toContain('>  Hallo <b>Welt</b>  </k:item>');
    expect(output).toContain('<!--keep--><?job keep?>');
  });

  it('changes only translated XML ranges and preserves carriage-return references', () => {
    const source =
      '\uFEFF<?xml version=\'1.0\'?>\r\n<catalog xmlns:k="urn:knauf"><k:keep>Keep&#13;line</k:keep><change>  Hello 😀  </change><!--  keep  --><?job  keep?><empty /></catalog>';
    const adapter = xmlAdapter(Buffer.from(source));
    const unchanged = adapter.build(
      new Map(adapter.segments.map((segment) => [segment.id, segment.source])),
    );

    expect(unchanged.toString()).toBe(source);

    const output = adapter
      .build(
        new Map([
          ['x0', 'Keep\rline'],
          ['x1', 'Hallo & sicher'],
        ]),
      )
      .toString();
    expect(output).toContain('<k:keep>Keep&#13;line</k:keep>');
    expect(output).toContain('<change>  Hallo &amp; sicher  </change>');
    expect(output).toContain('<!--  keep  --><?job  keep?><empty />');
    expect(xmlAdapter(Buffer.from(output)).segments[0].source).toBe('Keep\rline');
  });

  it('encodes translated XML carriage returns and keeps CDATA bounded', () => {
    const text = xmlAdapter(Buffer.from('<root>Hello</root>'));
    expect(text.build(new Map([['x0', 'A\rB']])).toString()).toBe('<root>A&#13;B</root>');

    const cdata = xmlAdapter(Buffer.from('<root><![CDATA[Hello]]></root>'));
    expect(cdata.build(new Map([['x0', 'Safe <text>']])).toString()).toBe(
      '<root><![CDATA[Safe <text>]]></root>',
    );
    expect(() => cdata.build(new Map([['x0', 'A\rB']]))).toThrow(
      expect.objectContaining({ code: 'invalid_edit' }),
    );
    expect(() => cdata.build(new Map([['x0', 'bad ]]> value']]))).toThrow(
      expect.objectContaining({ code: 'invalid_edit' }),
    );
  });

  it('rejects unsafe, malformed, and oversized XML', () => {
    expect(() =>
      xmlAdapter(Buffer.from('<!DOCTYPE root [<!ENTITY x "boom">]><root>&x;</root>')),
    ).toThrow(expect.objectContaining({ code: 'unsafe_xml' }));
    expect(() => xmlAdapter(Buffer.from('<root><broken></root>'))).toThrow(
      expect.objectContaining({ code: 'invalid_xml' }),
    );
    expect(() => xmlAdapter(Buffer.from('text without a root element'))).toThrow(
      expect.objectContaining({ code: 'invalid_xml' }),
    );
    expect(() =>
      xmlAdapter(Buffer.from(`<root>${'<item>Hello</item>'.repeat(10001)}</root>`)),
    ).toThrow(expect.objectContaining({ code: 'too_many_segments' }));
    expect(() => xmlAdapter(Buffer.from('<root>Bare & value</root>'))).toThrow(
      expect.objectContaining({ code: 'invalid_xml' }),
    );
  });

  it('rejects non-UTF-8 XML and illegal replacement characters', () => {
    expect(() =>
      xmlAdapter(
        Buffer.from(
          '<?xml version="1.0" encoding="ISO-8859-1"?><root>Gr\xfc\xdfe</root>',
          'latin1',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'unsupported_xml_encoding' }));

    const adapter = xmlAdapter(Buffer.from('<root>Hello</root>'));
    expect(() => adapter.build(new Map([['x0', 'Invalid\u0000text']]))).toThrow(
      expect.objectContaining({ code: 'invalid_edit' }),
    );
  });
});
// End [knauf]

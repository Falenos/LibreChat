'use strict';

const { applyTextEdits } = require('../idml/edit');
const { xmlAdapter } = require('../translation/tool');
const { buildXmlToolContext, inspectAdapter, validateExplicitSegmentSelection } = require('./edit');

const fixture = () =>
  xmlAdapter(
    Buffer.from(
      '<?xml version="1.0"?><catalog xmlns="urn:test"><item code="A">Hello world</item><item code="B">Hello world</item><note>Unique &amp; safe</note></catalog>',
    ),
  );

describe('[knauf] edit_xml', () => {
  it('tells the model not to bypass text ambiguity with an inferred segment id', () => {
    const context = buildXmlToolContext({
      body: { files: [{ file_id: 'xml-1', filename: 'sample.xml' }] },
    });

    expect(context).toContain('user explicitly supplies a segment_id');
    expect(context).toContain('never infer');
  });

  it('rejects model-inferred segment ids absent from the user request', () => {
    expect(() =>
      validateExplicitSegmentSelection(
        { body: { text: 'Replace "Hello" with "Hallo". Do not replace all occurrences.' } },
        { segment_edits: [{ segment_id: 'x0', text: 'Hallo world' }] },
      ),
    ).toThrow(expect.objectContaining({ code: 'segment_selection_required' }));
  });

  it('allows a segment id explicitly supplied by the user', () => {
    expect(() =>
      validateExplicitSegmentSelection(
        { body: { text: 'Replace segment x0 with "Hallo world".' } },
        { segment_edits: [{ segment_id: 'x0', text: 'Hallo world' }] },
      ),
    ).not.toThrow();
  });

  it('inspects bounded searchable text nodes with stable ids and paths', () => {
    expect(inspectAdapter(fixture(), { query: 'Hello', offset: 1, limit: 1 })).toEqual({
      totalElements: 4,
      matchedElements: 0,
      totalSegments: 3,
      matchedSegments: 2,
      totalComments: 0,
      matchedComments: 0,
      totalProcessingInstructions: 0,
      matchedProcessingInstructions: 0,
      offset: 1,
      limit: 1,
      elements: [],
      segments: [{ id: 'x1', path: '/catalog[1]/item[2]/text()[1]', text: 'Hello world' }],
      comments: [],
      processingInstructions: [],
    });
  });

  it('reads attribute-only XML without making attributes editable', () => {
    const adapter = xmlAdapter(
      Buffer.from('<catalog><product id="A1" price="12.50"/><product id="B2"/></catalog>'),
    );

    expect(inspectAdapter(adapter, { query: 'A1' })).toMatchObject({
      totalElements: 3,
      matchedElements: 1,
      totalSegments: 0,
      elements: [{ path: '/catalog[1]/product[1]', attributes: { id: 'A1', price: '12.50' } }],
      segments: [],
    });
  });

  it('fails closed on ambiguous replacements and exports escaped text', () => {
    expect(() =>
      applyTextEdits(
        fixture(),
        { replacements: [{ find: 'Hello', replace: 'Hallo' }] },
        { segmentIdPattern: /^x\d+$/, formatLabel: 'XML' },
      ),
    ).toThrow(expect.objectContaining({ code: 'ambiguous_match' }));

    const adapter = fixture();
    const edits = applyTextEdits(
      adapter,
      {
        replacements: [{ find: 'Hello', replace: 'Hallo', replace_all: true }],
        segment_edits: [{ segment_id: 'x2', text: 'New & <safe>' }],
      },
      { segmentIdPattern: /^x\d+$/, formatLabel: 'XML' },
    );
    const output = adapter.build(edits.translations).toString();

    expect(edits.applied).toBe(3);
    expect(output).toContain('<item code="A">Hallo world</item>');
    expect(output).toContain('<item code="B">Hallo world</item>');
    expect(output).toContain('<note>New &amp; &lt;safe&gt;</note>');
    expect(output).toContain('xmlns="urn:test"');
  });

  it('preserves untouched XML lexical content during an exact edit', () => {
    const source =
      "<?xml version='1.0'?><root><keep>Keep&#13;line</keep><change>Hello</change><!--  keep  --><?job  keep?><empty /></root>";
    const adapter = xmlAdapter(Buffer.from(source));
    const edits = applyTextEdits(
      adapter,
      { segment_edits: [{ segment_id: 'x1', text: 'Hallo & sicher' }] },
      { segmentIdPattern: /^x\d+$/, formatLabel: 'XML' },
    );
    const output = adapter.build(edits.translations).toString();

    expect(output).toBe(
      "<?xml version='1.0'?><root><keep>Keep&#13;line</keep><change>Hallo &amp; sicher</change><!--  keep  --><?job  keep?><empty /></root>",
    );
  });

  it('reports comments and processing instructions during inspection', () => {
    const adapter = xmlAdapter(
      Buffer.from('<?xml version="1.0"?><!--before--><root><?job keep?><!--inside--></root>'),
    );

    expect(inspectAdapter(adapter)).toMatchObject({
      totalComments: 2,
      matchedComments: 2,
      comments: [{ text: 'before' }, { text: 'inside' }],
      totalProcessingInstructions: 1,
      matchedProcessingInstructions: 1,
      processingInstructions: [{ target: 'job', body: 'keep' }],
    });
  });

  it('bounds large read-only metadata in inspection responses', () => {
    const adapter = xmlAdapter(
      Buffer.from(`<root><!--${'x'.repeat(5000)}--><?job ${'y'.repeat(5000)}?></root>`),
    );
    const report = inspectAdapter(adapter);

    expect(report.comments[0].truncated).toBe(true);
    expect(report.comments[0].totalCharacters).toBe(5000);
    expect(report.comments[0].text).toHaveLength(4000);
    expect(report.processingInstructions[0].target).toBe('job');
    expect(report.processingInstructions[0].truncated).toBe(true);
    expect(report.processingInstructions[0].totalCharacters).toBe(5000);
    expect(report.processingInstructions[0].body).toHaveLength(4000);
  });

  it('rejects IDML segment ids for XML edits', () => {
    expect(() =>
      applyTextEdits(
        fixture(),
        { segment_edits: [{ segment_id: 's0-c0', text: 'No' }] },
        { segmentIdPattern: /^x\d+$/, formatLabel: 'XML' },
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_edit' }));
  });
});

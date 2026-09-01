// [knauf] KK20-297 — prompt-facing IDML inspection and exact story-text edits.
'use strict';

const JSZip = require('jszip');
const { IDML_MIME, buildIdml, parseIdml } = require('./core');
const { applyTextEdits, inspectParsed } = require('./edit');

async function fixture(contents = ['Hello world', 'Hello world', 'Unique text']) {
  const zip = new JSZip();
  zip.file('mimetype', IDML_MIME, { compression: 'STORE', createFolders: false });
  zip.file('designmap.xml', '<?xml version="1.0"?><Document/>');
  zip.file(
    'Stories/Story_u1.xml',
    `<?xml version="1.0"?><Story>${contents.map((text) => `<Content>${text}</Content>`).join('')}</Story>`,
  );
  zip.file('Resources/Styles.xml', '<Styles><Style Self="body"/></Styles>');
  return parseIdml(
    await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }),
  );
}

describe('[knauf] edit_idml', () => {
  it('inspects bounded, searchable segments with stable ids', async () => {
    const parsed = await fixture();

    expect(inspectParsed(parsed, { query: 'Hello', offset: 1, limit: 1 })).toEqual({
      totalSegments: 3,
      matchedSegments: 2,
      offset: 1,
      limit: 1,
      segments: [{ id: 's0-c1', story: 'Stories/Story_u1.xml', text: 'Hello world' }],
    });
  });

  it('fails closed on ambiguous exact text unless replace_all is explicit', async () => {
    const parsed = await fixture();

    expect(() =>
      applyTextEdits(parsed, { replacements: [{ find: 'Hello', replace: 'Hallo' }] }),
    ).toThrow(expect.objectContaining({ code: 'ambiguous_match' }));

    const edited = applyTextEdits(parsed, {
      replacements: [{ find: 'Hello', replace: 'Hallo', replace_all: true }],
    });
    expect(edited.applied).toBe(2);
    expect([...edited.translations.values()]).toEqual([
      'Hallo world',
      'Hallo world',
      'Unique text',
    ]);
  });

  it('supports exact segment edits, deletion, and XML-safe export', async () => {
    const parsed = await fixture(['Original']);
    const edited = applyTextEdits(parsed, {
      segment_edits: [{ segment_id: 's0-c0', text: 'New & <safe>' }],
    });
    const built = await buildIdml(parsed, edited.translations, { allowEmpty: true });
    const output = await JSZip.loadAsync(built.buffer);
    const story = await output.file('Stories/Story_u1.xml').async('string');

    expect(story).toContain('<Content>New &amp; &lt;safe&gt;</Content>');
    expect(await output.file('Resources/Styles.xml').async('string')).toBe(
      '<Styles><Style Self="body"/></Styles>',
    );

    const cleared = applyTextEdits(parsed, {
      segment_edits: [{ segment_id: 's0-c0', text: '' }],
    });
    await expect(
      buildIdml(parsed, cleared.translations, { allowEmpty: true }),
    ).resolves.toBeTruthy();
  });

  it('accepts structural subsegment ids around inline Adobe controls', async () => {
    const parsed = await fixture(['Alpha<?ACE 8?>Beta']);
    const edited = applyTextEdits(parsed, {
      segment_edits: [{ segment_id: 's0-c0-p1', text: 'Zwei' }],
    });
    const built = await buildIdml(parsed, edited.translations, { allowEmpty: true });
    const output = await JSZip.loadAsync(built.buffer);

    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content>Alpha<?ACE 8?>Zwei</Content>',
    );
  });

  it('treats replacement dollar tokens literally and bounds expanded output', async () => {
    const parsed = await fixture(['Original']);
    const literal = applyTextEdits(parsed, {
      replacements: [{ find: 'Original', replace: "$& $` $'" }],
    });

    expect(literal.translations.get('s0-c0')).toBe("$& $` $'");
    const expanded = await fixture(['O'.repeat(30)]);
    expect(() =>
      applyTextEdits(expanded, {
        replacements: [{ find: 'O', replace: 'x'.repeat(100000), replace_all: true }],
      }),
    ).toThrow(expect.objectContaining({ code: 'edit_too_large' }));
  });

  it('rejects missing text, unknown segments, and duplicate segment edits', async () => {
    const parsed = await fixture(['Original']);

    expect(() =>
      applyTextEdits(parsed, { replacements: [{ find: 'Missing', replace: 'New' }] }),
    ).toThrow(expect.objectContaining({ code: 'text_not_found' }));
    expect(() =>
      applyTextEdits(parsed, { segment_edits: [{ segment_id: 's9-c9', text: 'New' }] }),
    ).toThrow(expect.objectContaining({ code: 'unknown_segment' }));
    expect(() =>
      applyTextEdits(parsed, {
        segment_edits: [
          { segment_id: 's0-c0', text: 'One' },
          { segment_id: 's0-c0', text: 'Two' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'duplicate_segment_edit' }));
  });
});
// End [knauf]

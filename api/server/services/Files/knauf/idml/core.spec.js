// [knauf] KK20-297 — secure IDML parse/translate/repackage behavior.
'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const {
  IDML_MIME,
  buildIdml,
  normalizeLocale,
  parseIdml,
  validateXmlStructure,
} = require('./core');

const storyXml = (content = 'Hello &amp; welcome') =>
  `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u1"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" AppliedFont="Knauf Screen" FontStyle="Bold"><Content> ${content} </Content><Content>12345</Content><Content>https://knauf.com</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`;

async function fixture({ story = storyXml(), mimetype = IDML_MIME } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', mimetype, { compression: 'STORE', createFolders: false });
  zip.file(
    'designmap.xml',
    '<?xml version="1.0"?><Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><idPkg:Story src="Stories/Story_u1.xml"/></Document>',
  );
  zip.file('Stories/Story_u1.xml', story);
  zip.file(
    'Resources/Styles.xml',
    '<idPkg:Styles xmlns:idPkg="urn:test"><CharacterStyle Self="CharacterStyle/Body" AppliedFont="Knauf Screen" FontStyle="Regular"/></idPkg:Styles>',
  );
  zip.file(
    'Resources/Fonts.xml',
    '<idPkg:Fonts xmlns:idPkg="urn:test"><FontFamily Name="Knauf Screen"><Font FontStyleName="Regular" PostScriptName="KnaufScreen-Regular"/></FontFamily></idPkg:Fonts>',
  );
  zip.file('Links/logo.bin', Buffer.from([0, 1, 2, 3, 254, 255]));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('[knauf] IDML core', () => {
  it('replaces story Content and preserves non-story package bytes', async () => {
    const parsed = await parseIdml(await fixture());

    expect(parsed.segments).toEqual([
      expect.objectContaining({ id: 's0-c0', source: 'Hello & welcome' }),
    ]);
    expect(parsed.fontStyleManifest).toMatchObject({
      resources: [
        { entryName: 'Resources/Fonts.xml', hash: expect.any(String) },
        { entryName: 'Resources/Styles.xml', hash: expect.any(String) },
      ],
      stories: [
        {
          entryName: 'Stories/Story_u1.xml',
          references: expect.arrayContaining([
            expect.objectContaining({
              attribute: 'AppliedParagraphStyle',
              value: 'ParagraphStyle/Body',
            }),
            expect.objectContaining({ attribute: 'AppliedFont', value: 'Knauf Screen' }),
            expect.objectContaining({ attribute: 'FontStyle', value: 'Bold' }),
          ]),
        },
      ],
    });
    const built = await buildIdml(parsed, new Map([['s0-c0', 'Hallo & willkommen']]));
    const output = await JSZip.loadAsync(built.buffer, { checkCRC32: true });

    expect(built.fontValidation).toBe('preserved');
    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content> Hallo &amp; willkommen </Content>',
    );
    expect(digest(await output.file('Links/logo.bin').async('nodebuffer'))).toBe(
      parsed.immutableHashes.get('Links/logo.bin'),
    );
    expect(built.buffer.subarray(30, 38).toString('utf8')).toBe('mimetype');
  });

  it('fails when the rebuilt font/style manifest differs from the source contract', async () => {
    const parsed = await parseIdml(await fixture());
    parsed.stories[0].xml = parsed.stories[0].xml.replace(
      'ParagraphStyle/Body',
      'ParagraphStyle/Fake',
    );

    await expect(
      buildIdml(parsed, new Map([['s0-c0', 'Hallo & willkommen']])),
    ).rejects.toMatchObject({ code: 'font_fidelity_failed' });
  });

  it('classifies changed font/style resources as font fidelity failures', async () => {
    const parsed = await parseIdml(await fixture());
    const styles = parsed.entries.find((entry) => entry.name === 'Resources/Styles.xml');
    styles.async = async () =>
      Buffer.from(
        '<idPkg:Styles xmlns:idPkg="urn:test"><CharacterStyle Self="CharacterStyle/Body" AppliedFont="Arial" FontStyle="Regular"/></idPkg:Styles>',
      );

    await expect(
      buildIdml(parsed, new Map([['s0-c0', 'Hallo & willkommen']])),
    ).rejects.toMatchObject({ code: 'font_fidelity_failed' });
  });

  it('preserves RTL and non-BMP translated text as valid UTF-8 XML', async () => {
    const parsed = await parseIdml(await fixture());
    const translated = 'مرحبا بالعالم — 😀';
    const built = await buildIdml(parsed, new Map([['s0-c0', translated]]));
    const reparsed = await parseIdml(built.buffer);

    expect(reparsed.segments).toEqual([expect.objectContaining({ source: translated })]);
  });

  it('rejects a package whose required mimetype entry is wrong', async () => {
    await expect(parseIdml(await fixture({ mimetype: 'application/zip' }))).rejects.toMatchObject({
      code: 'invalid_idml_mimetype',
    });
  });

  it('rejects DTD/entity XML', async () => {
    await expect(
      parseIdml(
        await fixture({
          story:
            '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Story><Content>&e;</Content></Story>',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unsafe_xml' });
  });

  it('extracts only real Content elements, not literals in comments or CDATA', async () => {
    const parsed = await parseIdml(
      await fixture({
        story:
          '<Story><!-- <Content>Fake comment</Content> --><Content>Real text</Content><![CDATA[<Content>Fake CDATA</Content>]]></Story>',
      }),
    );

    expect(parsed.segments.map((segment) => segment.source)).toEqual(['Real text']);
    const built = await buildIdml(parsed, new Map([['s0-c0', 'Echter Text']]));
    const output = await JSZip.loadAsync(built.buffer);
    const story = await output.file('Stories/Story_u1.xml').async('string');
    expect(story).toContain('<!-- <Content>Fake comment</Content> -->');
    expect(story).toContain('<![CDATA[<Content>Fake CDATA</Content>]]>');
    expect(story).toContain('<Content>Echter Text</Content>');
  });

  it('rejects duplicate raw central-directory paths before JSZip collapses them', async () => {
    const zip = new JSZip();
    zip.file('mimetype', IDML_MIME, { compression: 'STORE', createFolders: false });
    zip.file('designmap.xml', '<Document/>');
    zip.file('Stories/Story_u1.xml', '<Story><Content>Hello</Content></Story>');
    zip.file('A.txt', 'one');
    zip.file('B.txt', 'two');
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    for (let offset = 0; offset <= buffer.length - 5; offset += 1) {
      if (buffer.subarray(offset, offset + 5).toString('ascii') === 'B.txt') {
        buffer.write('A.txt', offset, 'ascii');
      }
    }

    await expect(parseIdml(buffer)).rejects.toMatchObject({ code: 'duplicate_zip_path' });
  });

  it('enforces the content-node budget while stories are scanned', async () => {
    await expect(
      parseIdml(
        await fixture({
          story: `<Story>${'<Content>1</Content>'.repeat(50001)}</Story>`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'too_many_content_nodes' });
  });

  it('accepts attribute-heavy Adobe stories within the bounded IDML budget', () => {
    expect(() =>
      validateXmlStructure(
        `<Story>${'<Range AppliedStyle="Body"/>'.repeat(22000)}</Story>`,
        'Story',
      ),
    ).not.toThrow();
  });

  it('rejects attribute data beyond the bounded IDML budget', () => {
    expect(() =>
      validateXmlStructure(
        `<Story>${'<Range AppliedStyle="Body"/>'.repeat(50001)}</Story>`,
        'Story',
      ),
    ).toThrow(expect.objectContaining({ code: 'too_many_attributes' }));
    expect(() =>
      validateXmlStructure(`<Story Value="${'x'.repeat(2 * 1024 * 1024)}"/>`, 'Story'),
    ).toThrow(expect.objectContaining({ code: 'too_many_attributes' }));
  });

  it('rejects incomplete translation maps', async () => {
    const parsed = await parseIdml(await fixture());
    await expect(buildIdml(parsed, new Map())).rejects.toMatchObject({ code: 'segment_mismatch' });
  });

  it('preserves Adobe ACE processing instructions before translated text', async () => {
    const parsed = await parseIdml(await fixture({ story: storyXml('<?ACE 7?>Hello') }));
    const built = await buildIdml(parsed, new Map([['s0-c0', 'Hallo']]));
    const output = await JSZip.loadAsync(built.buffer);

    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content> <?ACE 7?>Hallo </Content>',
    );
  });

  it('preserves inline Adobe ACE controls at their structural boundary', async () => {
    const parsed = await parseIdml(await fixture({ story: storyXml('Genesis<?ACE 8?>6') }));

    expect(parsed.segments).toEqual([expect.objectContaining({ id: 's0-c0', source: 'Genesis' })]);
    const built = await buildIdml(parsed, new Map([['s0-c0', 'Genese']]));
    const output = await JSZip.loadAsync(built.buffer);

    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content> Genese<?ACE 8?>6 </Content>',
    );
  });

  it('creates stable subsegments around inline Adobe ACE controls', async () => {
    const parsed = await parseIdml(await fixture({ story: storyXml('Alpha<?ACE 8?>Beta') }));

    expect(parsed.segments.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 's0-c0-p0', source: 'Alpha' },
      { id: 's0-c0-p1', source: 'Beta' },
    ]);
    const built = await buildIdml(
      parsed,
      new Map([
        ['s0-c0-p0', 'Eins'],
        ['s0-c0-p1', 'Zwei'],
      ]),
    );
    const output = await JSZip.loadAsync(built.buffer);

    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content> Eins<?ACE 8?>Zwei </Content>',
    );
  });

  it('allows an explicit manipulation to clear a story segment', async () => {
    const parsed = await parseIdml(await fixture());
    const built = await buildIdml(parsed, new Map([['s0-c0', '']]), { allowEmpty: true });
    const output = await JSZip.loadAsync(built.buffer);

    expect(await output.file('Stories/Story_u1.xml').async('string')).toContain(
      '<Content>  </Content>',
    );
  });

  it('normalizes arbitrary valid BCP-47 locales and rejects invalid ones', () => {
    expect(normalizeLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-Hant-TW');
    expect(() => normalizeLocale('en--US')).toThrow(
      expect.objectContaining({ code: 'invalid_locale' }),
    );
  });
});
// End [knauf]

'use strict';

const {
  MAX_SVG_ARTIFACT_BYTES,
  validateSvgArtifactSource,
} = require('@knauf/knauf/server/validateArtifactSource');

// [knauf] NO-TICKET — production-safe validation for user-uploaded editable SVG source.
describe('validateSvgArtifactSource', () => {
  const safe =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Mark</title><defs><linearGradient id="fill"><stop stop-color="#fff"/></linearGradient></defs><path fill="url(#fill)" d="M0 0h20v20z"/></svg>';

  test('accepts well-formed, self-contained vector source', () => {
    expect(validateSvgArtifactSource(safe)).toBeNull();
  });

  test.each([
    ['missing viewBox', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
    ['malformed XML', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path></svg>'],
    ['multiple roots', `${safe}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`],
    ['non-finite coordinates', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 NaN 10"/>'],
    [
      'duplicate IDs',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="a"/><path id="a"/></svg>',
    ],
    [
      'broken reference',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="url(#missing)"/></svg>',
    ],
    [
      'script',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    ],
    [
      'event handler',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"/>',
    ],
    [
      'javascript URL',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="javascript:alert(1)"/></svg>',
    ],
    [
      'external href',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use href="https://example.com/x.svg#a"/></svg>',
    ],
    [
      'foreignObject',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject/></svg>',
    ],
    [
      'raster image',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,eA=="/></svg>',
    ],
  ])('rejects %s', (_label, source) => {
    expect(validateSvgArtifactSource(source)).toEqual(
      expect.objectContaining({ message: expect.any(String) }),
    );
  });

  test('rejects source above the 8 MB artifact limit', () => {
    expect(validateSvgArtifactSource(' '.repeat(MAX_SVG_ARTIFACT_BYTES + 1))).toEqual(
      expect.objectContaining({ message: expect.stringContaining('8 MB') }),
    );
  });

  test('accepts valid source exactly at the 8 MB limit', () => {
    const start = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--';
    const end = '--></svg>';
    const source = start + ' '.repeat(MAX_SVG_ARTIFACT_BYTES - start.length - end.length) + end;
    expect(Buffer.byteLength(source)).toBe(MAX_SVG_ARTIFACT_BYTES);
    expect(validateSvgArtifactSource(source)).toBeNull();
  });
});
// End [knauf]

const { assertImageOptions } = require('./imageOptions');

const valid = {
  model: 'gpt-image-2',
  size: '1024x1024',
  background: 'auto',
  outputFormat: 'png',
  outputCompression: 85,
};

describe('gpt-image-2 image options', () => {
  it.each(['auto', '1024x1024', '1536x1024', '1024x1536', '3840x2160'])(
    'accepts supported size %s',
    (size) => expect(() => assertImageOptions({ ...valid, size })).not.toThrow(),
  );

  it.each(['1000x1000', '4000x1024', '3840x1024', '128x128', 'not-a-size'])(
    'rejects unsupported size %s',
    (size) => expect(() => assertImageOptions({ ...valid, size })).toThrow(/size/i),
  );

  it('rejects transparent backgrounds', () => {
    expect(() => assertImageOptions({ ...valid, background: 'transparent' })).toThrow(
      /transparent/i,
    );
  });

  it('rejects output unsupported by the configured Azure Image API', () => {
    expect(() => assertImageOptions({ ...valid, outputFormat: 'webp' })).toThrow(/WebP/i);
    expect(() => assertImageOptions({ ...valid, outputFormat: 'gif' })).toThrow(/format/i);
    expect(() => assertImageOptions({ ...valid, outputCompression: 101 })).toThrow(/compression/i);
  });

  it('keeps legacy model dimensions and transparency backward compatible', () => {
    expect(() =>
      assertImageOptions({
        ...valid,
        model: 'gpt-image-1',
        size: '1024x1024',
        background: 'transparent',
        outputFormat: 'webp',
      }),
    ).not.toThrow();
  });
});

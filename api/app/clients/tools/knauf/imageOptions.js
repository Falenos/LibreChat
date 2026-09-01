const FORMATS = new Set(['png', 'jpeg', 'webp']);
const BACKGROUNDS = new Set(['auto', 'opaque', 'transparent']);

function assertImageOptions({ model, size, background, outputFormat, outputCompression }) {
  if (!FORMATS.has(outputFormat)) {
    throw new Error(`Unsupported image output format: ${outputFormat}`);
  }
  if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
    throw new Error('Image output compression must be an integer from 0 to 100.');
  }
  if (!BACKGROUNDS.has(background)) {
    throw new Error(`Unsupported image background: ${background}`);
  }
  if (model !== 'gpt-image-2') {
    return;
  }
  if (outputFormat === 'webp') {
    throw new Error('gpt-image-2 does not support WebP output on the configured Azure Image API.');
  }
  if (background === 'transparent') {
    throw new Error('gpt-image-2 does not support transparent backgrounds.');
  }
  if (size === 'auto') {
    return;
  }

  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (!dimensions) {
    throw new Error('gpt-image-2 size must be auto or WIDTHxHEIGHT.');
  }
  const width = Number(dimensions[1]);
  const height = Number(dimensions[2]);
  const pixels = width * height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    Math.max(width, height) > 3840 ||
    Math.max(width, height) / Math.min(width, height) > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  ) {
    throw new Error('gpt-image-2 size is outside the supported dimension constraints.');
  }
}

module.exports = { assertImageOptions };

const { determineFileType } = require('~/server/utils/files');

// [knauf] KK20-199 — bound and verify private Blob bytes before provider delivery.
async function streamToValidatedBase64(stream, sizeLimit, expectedMime) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > sizeLimit) {
        throw new Error('Invalid image size');
      }
      chunks.push(buffer);
    }
    const imageBuffer = Buffer.concat(chunks, bytes);
    const actualType = await determineFileType(imageBuffer, true);
    if (actualType?.mime !== expectedMime) {
      throw new Error('Unsupported image type');
    }
    return imageBuffer.toString('base64');
  } finally {
    chunks.length = 0;
    if (typeof stream.destroy === 'function') {
      stream.destroy();
    }
  }
}
// End [knauf]

module.exports = streamToValidatedBase64;

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { validateImage } = require('@librechat/api');
const {
  FileSources,
  VisionModes,
  ImageDetail,
  ContentTypes,
  EModelEndpoint,
  mergeFileConfig,
  getEndpointFileConfig,
  knaufCategorySizeLimit,
} = require('librechat-data-provider');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
// [knauf] KK20-199 — validate private Blob bytes before Foundry delivery.
const streamToValidatedBase64 = require('./knauf/streamToValidatedBase64');
// End [knauf]

/**
 * Fetches an image from a URL and returns its base64 representation.
 *
 * @async
 * @param {string} url The URL of the image.
 * @returns {Promise<string>} The base64-encoded string of the image.
 * @throws {Error} If there's an issue fetching the image or encoding it.
 */
async function fetchImageToBase64(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });
    const base64Data = Buffer.from(response.data).toString('base64');
    response.data = null;
    return base64Data;
  } catch (_error) {
    // [knauf] KK20-199 — signed blob URLs and transport errors must not leak
    // through the base64-only provider compatibility path.
    logger.error('Image fetch for normalization failed', {
      operation: 'image_normalization_fetch',
    });
    throw new Error('Image normalization failed');
    // End [knauf]
  }
}

const base64Only = new Set([
  EModelEndpoint.google,
  EModelEndpoint.anthropic,
  'Ollama',
  'ollama',
  EModelEndpoint.bedrock,
]);

const blobStorageSources = new Set([
  FileSources.azure_blob,
  FileSources.s3,
  FileSources.firebase,
  FileSources.cloudfront,
]);

// [knauf] KK20-199 — keep stored image metadata inside the same type/size
// boundary as upload before handing a signed URL or bytes to a model provider.
const knaufImageEndpoints = new Set([EModelEndpoint.agents, EModelEndpoint.azureOpenAI]);
// End [knauf]

/**
 * Encodes and formats the given files.
 * @param {ServerRequest} req - The request object.
 * @param {Array<MongoFile>} files - The array of files to encode and format.
 * @param {object} params - Object containing provider/endpoint information
 * @param {Providers | EModelEndpoint | string} [params.provider] - The provider for the image
 * @param {string} [params.endpoint] - Optional: The endpoint for the image
 * @param {string} [mode] - Optional: The endpoint mode for the image.
 * @returns {Promise<{ files: MongoFile[]; image_urls: MessageContentImageUrl[] }>} - A promise that resolves to the result object containing the encoded images and file details.
 */
async function encodeAndFormat(req, files, params, mode) {
  const { provider, endpoint } = params;
  const effectiveEndpoint = endpoint ?? provider;
  const promises = [];
  /** @type {Record<FileSources, Pick<ReturnType<typeof getStrategyFunctions>, 'prepareImagePayload' | 'getDownloadStream'>>} */
  const encodingMethods = {};
  /** @type {{ files: MongoFile[]; image_urls: MessageContentImageUrl[] }} */
  const result = {
    files: [],
    image_urls: [],
  };

  if (!files || !files.length) {
    return result;
  }

  // [knauf] KK20-199 — outbound validation is defense in depth for historical
  // or tampered Mongo rows that did not pass today's upload boundary.
  const fileConfig = mergeFileConfig(req.config?.fileConfig);
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint: effectiveEndpoint });
  const configuredFileSizeLimit = endpointConfig?.fileSizeLimit;
  // End [knauf]

  for (let file of files) {
    /** @type {FileSources} */
    const source = file.source ?? FileSources.local;

    if (!file.height) {
      promises.push([file, null]);
      continue;
    }

    // [knauf] KK20-199 — never send an unapproved or unbounded stored image to
    // Foundry. Error text deliberately excludes filenames, paths, and user data.
    if (!fileConfig.checkType(file.type, endpointConfig?.supportedMimeTypes)) {
      throw new Error('Unsupported image type');
    }
    const categoryLimit = knaufImageEndpoints.has(effectiveEndpoint)
      ? knaufCategorySizeLimit(file.type)
      : undefined;
    const sizeLimit = Math.min(configuredFileSizeLimit ?? Infinity, categoryLimit ?? Infinity);
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > sizeLimit) {
      throw new Error('Invalid image size');
    }
    // End [knauf]

    if (!encodingMethods[source]) {
      const { prepareImagePayload, getDownloadStream } = getStrategyFunctions(source);
      if (!prepareImagePayload) {
        throw new Error(`Encoding function not implemented for ${source}`);
      }

      encodingMethods[source] = { prepareImagePayload, getDownloadStream };
    }

    const preparePayload = encodingMethods[source].prepareImagePayload;
    /* Base64-only providers and private Azure Foundry inputs need blob bytes. */
    // [knauf] KK20-199 — Foundry's image fetcher cannot access private Blob
    // Storage even through the application's short-lived SAS URL. Match the
    // storage source too because serverless Foundry normalizes its provider to
    // `openAI` before this function runs.
    // Read through the existing authenticated storage strategy and send the
    // provider-supported data URL. Image-bearing agent tracing is disabled at
    // Run creation so these bytes never enter OTEL/Langfuse payloads.
    const needsBlobBytes =
      source === FileSources.azure_blob ||
      base64Only.has(effectiveEndpoint) ||
      provider === EModelEndpoint.azureOpenAI;
    if (blobStorageSources.has(source) && needsBlobBytes) {
      try {
        const downloadStream = encodingMethods[source].getDownloadStream;
        let stream = await downloadStream(req, file.filepath);
        let base64Data = await streamToValidatedBase64(stream, sizeLimit, file.type);
        stream = null;
        promises.push([file, base64Data]);
        base64Data = null;
        continue;
      } catch (_error) {
        logger.error('Image normalization failed', {
          operation: 'image_normalization',
          storageSource: source,
        });
        throw new Error('Image normalization failed');
      }
    } else if (source !== FileSources.local && base64Only.has(effectiveEndpoint)) {
      const [_file, imageURL] = await preparePayload(req, file);
      promises.push([_file, await fetchImageToBase64(imageURL)]);
      continue;
    }
    promises.push(preparePayload(req, file));
    // End [knauf]
  }

  const detail = req.body.imageDetail ?? ImageDetail.auto;

  /** @type {Array<[MongoFile, string]>} */
  const formattedImages = await Promise.all(promises);
  promises.length = 0;

  for (const [file, imageContent] of formattedImages) {
    const fileMetadata = {
      type: file.type,
      file_id: file.file_id,
      filepath: file.filepath,
      filename: file.filename,
      embedded: !!file.embedded,
      metadata: file.metadata,
    };

    if (file.height && file.width) {
      fileMetadata.height = file.height;
      fileMetadata.width = file.width;
    }

    if (!imageContent) {
      result.files.push(fileMetadata);
      continue;
    }

    /** Validate image buffer against size limits */
    if (file.height && file.width) {
      const imageBuffer = imageContent.startsWith('http')
        ? null
        : Buffer.from(imageContent, 'base64');

      if (imageBuffer) {
        const validation = await validateImage(
          imageBuffer,
          imageBuffer.length,
          effectiveEndpoint,
          configuredFileSizeLimit,
        );

        if (!validation.isValid) {
          // [knauf] KK20-199 — provider/application errors must not disclose
          // filenames or parser internals through logs or terminal job errors.
          throw new Error('Image validation failed');
          // End [knauf]
        }
      }
    }

    const imagePart = {
      type: ContentTypes.IMAGE_URL,
      image_url: {
        url: imageContent.startsWith('http')
          ? imageContent
          : `data:${file.type};base64,${imageContent}`,
        detail,
      },
    };

    if (mode === VisionModes.agents) {
      result.image_urls.push({ ...imagePart });
      result.files.push({ ...fileMetadata });
      continue;
    }

    if (
      effectiveEndpoint &&
      effectiveEndpoint === EModelEndpoint.google &&
      mode === VisionModes.generative
    ) {
      delete imagePart.image_url;
      imagePart.inlineData = {
        mimeType: file.type,
        data: imageContent,
      };
    } else if (effectiveEndpoint && effectiveEndpoint === EModelEndpoint.google) {
      imagePart.image_url = imagePart.image_url.url;
    } else if (effectiveEndpoint && effectiveEndpoint === EModelEndpoint.anthropic) {
      imagePart.type = 'image';
      imagePart.source = {
        type: 'base64',
        media_type: file.type,
        data: imageContent,
      };
      delete imagePart.image_url;
    }

    result.image_urls.push({ ...imagePart });
    result.files.push({ ...fileMetadata });
  }
  formattedImages.length = 0;
  return { ...result };
}

module.exports = {
  encodeAndFormat,
};

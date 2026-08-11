const fs = require('fs');
const path = require('path');
const mime = require('mime');
const { v4 } = require('uuid');
const {
  isUUID,
  megabyte,
  // [knauf] KK20-203 — Constants.NEW_CONVO sentinel guard for the conversationId stamp below.
  Constants,
  // End [knauf]
  FileContext,
  FileSources,
  imageExtRegex,
  EModelEndpoint,
  EToolResources,
  mergeFileConfig,
  AgentCapabilities,
  checkOpenAIStorage,
  removeNullishValues,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  documentParserMimeTypes,
  // [knauf] Per-category upload size caps (documents 25 / data 50 / images 20 MB). KK20-190.
  knaufCategorySizeLimit,
  knaufCategorySizeErrorKey,
  knaufLegacyOfficeErrorKey,
  // End [knauf]
} = require('librechat-data-provider');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  sanitizeFilename,
  parseText,
  // [knauf] NO-TICKET — preserve uploaded native SVG markup byte-for-byte as text.
  parseTextNative,
  // End [knauf]
  processAudioFile,
  getStorageMetadata,
  recordFileIndexEmbed,
  recordFileIndexProviderError,
  recordFileIndexEmbedRetry,
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
} = require('@librechat/api');
// [knauf] NO-TICKET — reject active/external SVG content before it reaches artifact preview.
const { validateSvgArtifactSource } = require('@knauf/knauf/server/validateArtifactSource');
// End [knauf]
const {
  convertImage,
  resizeAndConvert,
  resizeImageBuffer,
} = require('~/server/services/Files/images');
const { addResourceFileId, deleteResourceFileId } = require('~/server/controllers/assistants/v2');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { checkCapability } = require('~/server/services/Config');
const { LB_QueueAsyncCall } = require('~/server/utils/queue');
const { getRetentionExpiry, getAgentFileRetentionExpiry } = require('./retention');
const { getStrategyFunctions } = require('./strategies');
const { determineFileType } = require('~/server/utils');
const { STTService } = require('./Audio/STTService');
const db = require('~/models');

/**
 * Creates a modular file upload wrapper that ensures filename sanitization
 * across all storage strategies. This prevents storage-specific implementations
 * from having to handle sanitization individually.
 *
 * @param {Function} uploadFunction - The storage strategy's upload function
 * @returns {Function} - Wrapped upload function with sanitization
 */
const createSanitizedUploadWrapper = (uploadFunction) => {
  return async (params) => {
    const { req, file, file_id, ...restParams } = params;

    // Create a modified file object with sanitized original name
    // This ensures consistent filename handling across all storage strategies
    const sanitizedFile = {
      ...file,
      originalname: sanitizeFilename(file.originalname),
    };

    return uploadFunction({ req, file: sanitizedFile, file_id, ...restParams });
  };
};

const hasCodeEnvRef = (file) => file?.metadata?.codeEnvRef != null;

const isMissingStorageError = (err) => {
  const code = err?.code ?? err?.status ?? err?.statusCode ?? err?.response?.status;
  if ([404, '404', 'ENOENT', 'NoSuchKey', 'NotFound', 'ResourceNotFound'].includes(code)) {
    return true;
  }

  return /(?:file|object|blob|key|resource) (?:not found|does not exist)|no such (?:file|key)/i.test(
    String(err?.message ?? ''),
  );
};

/**
 * Enqueues the delete operation to the leaky bucket queue if necessary, or adds it directly to promises.
 *
 * @param {object} params - The passed parameters.
 * @param {ServerRequest} params.req - The express request object.
 * @param {MongoFile} params.file - The file object to delete.
 * @param {Function} params.deleteFile - The delete file function.
 * @param {Promise[]} params.promises - The array of promises to await.
 * @param {Set<string>} params.resolvedFileIds - File IDs whose storage delete succeeded.
 * @param {Set<string>} params.failedFileIds - File IDs whose storage delete failed.
 * @param {OpenAI | undefined} [params.openai] - If an OpenAI file, the initialized OpenAI client.
 */
function enqueueDeleteOperation({
  req,
  file,
  deleteFile,
  promises,
  resolvedFileIds,
  failedFileIds,
  openai,
}) {
  if (checkOpenAIStorage(file.source)) {
    // Enqueue to leaky bucket
    promises.push(
      new Promise((resolve, reject) => {
        LB_QueueAsyncCall(
          () => deleteFile(req, file, openai),
          [],
          (err, result) => {
            if (err) {
              if (isMissingStorageError(err)) {
                resolvedFileIds.add(file.file_id);
                logger.warn('File storage was already missing during delete', err);
                resolve(result);
                return;
              }
              failedFileIds.add(file.file_id);
              logger.error('Error deleting file from OpenAI source', err);
              reject(err);
            } else {
              resolvedFileIds.add(file.file_id);
              resolve(result);
            }
          },
        );
      }),
    );
  } else {
    // Add directly to promises
    promises.push(
      deleteFile(req, file)
        .then(() => resolvedFileIds.add(file.file_id))
        .catch((err) => {
          if (isMissingStorageError(err)) {
            resolvedFileIds.add(file.file_id);
            logger.warn('File storage was already missing during delete', err);
            return;
          }
          failedFileIds.add(file.file_id);
          logger.error('Error deleting file', err);
          return Promise.reject(err);
        }),
    );
  }
}

const getDeleteMethod = ({ source, deletionMethods }) => {
  if (deletionMethods[source]) {
    return deletionMethods[source];
  }

  const { deleteFile } = getStrategyFunctions(source);
  if (!deleteFile) {
    throw new Error(`Delete function not implemented for ${source}`);
  }

  deletionMethods[source] = deleteFile;
  return deleteFile;
};

const createDeleteFileWithSecondaryStorage = ({ source, deleteFile, deletionMethods }) => {
  return async (req, file, openai) => {
    const secondaryDeleteMethods = [];
    if (file.embedded === true && source !== FileSources.vectordb) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.vectordb, deletionMethods }),
      );
    }
    if (hasCodeEnvRef(file) && source !== FileSources.execute_code) {
      secondaryDeleteMethods.push(
        getDeleteMethod({ source: FileSources.execute_code, deletionMethods }),
      );
    }

    try {
      await deleteFile(req, file, openai);
    } catch (err) {
      if (!isMissingStorageError(err)) {
        throw err;
      }
      logger.warn('Primary file storage was already missing during delete', err);
    }

    await Promise.all(
      secondaryDeleteMethods.map((secondaryDeleteFile) => secondaryDeleteFile(req, file)),
    );
  };
};

// TODO: refactor as currently only image files can be deleted this way
// as other filetypes will not reside in public path
/**
 * Deletes a list of files from the server filesystem and the database.
 *
 * @param {Object} params - The params object.
 * @param {MongoFile[]} params.files - The file objects to delete.
 * @param {ServerRequest} params.req - The express request object.
 * @param {DeleteFilesBody} params.req.body - The request body.
 * @param {string} [params.req.body.agent_id] - The agent ID if file uploaded is associated to an agent.
 * @param {string} [params.req.body.assistant_id] - The assistant ID if file uploaded is associated to an assistant.
 * @param {string} [params.req.body.tool_resource] - The tool resource if assistant file uploaded is associated to a tool resource.
 *
 * @returns {Promise<{ deletedFileIds: string[], failedFileIds: string[] }>}
 * @throws {Error} When storage deletion cannot be scheduled or file metadata cleanup fails.
 */
const processDeleteRequest = async ({ req, files }) => {
  const appConfig = req.config;
  const resolvedFileIds = new Set();
  const failedFileIds = new Set();
  const deletionMethods = {};
  const promises = [];
  const assetCleanupPromises = new Map();
  const cleanedAssetIds = new Set();

  /** @type {Record<string, OpenAI | undefined>} */
  const client = { [FileSources.openai]: undefined, [FileSources.azure]: undefined };
  const initializeClients = async () => {
    if (appConfig.endpoints?.[EModelEndpoint.assistants]) {
      const openAIClient = await getOpenAIClient({
        req,
        overrideEndpoint: EModelEndpoint.assistants,
      });
      client[FileSources.openai] = openAIClient.openai;
    }

    if (!appConfig.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
      return;
    }

    const azureClient = await getOpenAIClient({
      req,
      overrideEndpoint: EModelEndpoint.azureAssistants,
    });
    client[FileSources.azure] = azureClient.openai;
  };

  if (req.body.assistant_id !== undefined) {
    await initializeClients();
  }

  const agentFiles = [];

  // [knauf] KK20-195 review R4 — §8.2 tombstone-before-physical: assets whose
  // every reference sits inside this delete set are tombstoned BEFORE their
  // blob/vectors are destroyed, so a queued/processing asset can't be claimed
  // or activated mid-delete. The post-delete finalize below remains the remove
  // step. F5 (re-review): the tombstone is the deletion FENCE — assets whose
  // fence could not be established come back in `unfenced`, and their physical
  // delete is SKIPPED so we never destroy blob/vectors under a still-claimable
  // asset (the reconciler retries the whole delete).
  let unfencedAssetIds = new Set();
  let retainedAssetIds = new Set();
  let tombstonedAssets = new Map();
  {
    const { preTombstoneLastReferences } = require('./knauf/fileAssetDelete');
    ({
      unfenced: unfencedAssetIds,
      retained: retainedAssetIds,
      tombstoned: tombstonedAssets,
    } = await preTombstoneLastReferences({ db, files, logger }));
  }
  // End [knauf]

  for (const file of files) {
    // [knauf] KK20-195 review F5 — fence failed for this asset; skip its
    // physical delete and leave the row intact (reported as failed) so a worker
    // can't be racing an in-flight claim while its blob/vectors are destroyed.
    if (file.knauf_asset_id && unfencedAssetIds.has(file.knauf_asset_id)) {
      failedFileIds.add(file.file_id);
      continue;
    }
    if (req.body.agent_id && req.body.tool_resource) {
      agentFiles.push({
        tool_resource: req.body.tool_resource,
        file_id: file.file_id,
      });
    }
    // A surviving logical reference owns the shared blob/vectors. Delete only
    // this File row and its agent-resource reference.
    if (file.knauf_asset_id && retainedAssetIds.has(file.knauf_asset_id)) {
      resolvedFileIds.add(file.file_id);
      continue;
    }
    // A tombstoned FileAsset owns physical state. Clean every ledger generation
    // and the blob exactly once, regardless of the logical File.embedded flag.
    const tombstonedAsset = file.knauf_asset_id ? tombstonedAssets.get(file.knauf_asset_id) : null;
    if (tombstonedAsset) {
      let cleanup = assetCleanupPromises.get(file.knauf_asset_id);
      if (!cleanup) {
        const { createGenerationRagClient } = require('./knauf/generationRagClient');
        const { cleanupFileAssetPhysical } = require('./knauf/fileAssetDelete');
        const ragClient = createGenerationRagClient({ getStrategyFunctions });
        const userId =
          tombstonedAsset.scope_type === 'user'
            ? String(tombstonedAsset.scope_id)
            : String(file.user ?? req.user.id);
        cleanup = cleanupFileAssetPhysical({
          req,
          asset: tombstonedAsset,
          userId,
          ragClient,
          getStrategyFunctions,
          logger,
        }).then(async (cleaned) => {
          try {
            if (cleaned) {
              // Keep the deleting ledger row until logical metadata commits.
              // If that DB write fails, a retry can idempotently re-drive the
              // physical cleanup instead of leaving a File pointing nowhere.
              cleanedAssetIds.add(file.knauf_asset_id);
            } else {
              await db.markDeleteFailed({
                asset_id: file.knauf_asset_id,
                error_code: 'physical_cleanup_failed',
              });
            }
            return cleaned;
          } catch (error) {
            logger.warn(
              `[processDeleteRequest] failed recording cleanup for ${file.knauf_asset_id}: ${error?.message}`,
            );
            return false;
          }
        });
        assetCleanupPromises.set(file.knauf_asset_id, cleanup);
      }
      promises.push(
        cleanup.then((cleaned) => {
          (cleaned ? resolvedFileIds : failedFileIds).add(file.file_id);
        }),
      );
      continue;
    }
    // End [knauf]
    const source = file.source ?? FileSources.local;

    if (source === FileSources.text) {
      resolvedFileIds.add(file.file_id);
      continue;
    }

    if (checkOpenAIStorage(source) && !client[source]) {
      await initializeClients();
    }

    const openai = client[source];

    if (req.body.assistant_id && req.body.tool_resource) {
      promises.push(
        deleteResourceFileId({
          req,
          openai,
          file_id: file.file_id,
          assistant_id: req.body.assistant_id,
          tool_resource: req.body.tool_resource,
        }),
      );
    } else if (req.body.assistant_id) {
      promises.push(openai.beta.assistants.files.del(req.body.assistant_id, file.file_id));
    }

    const deleteFile = getDeleteMethod({ source, deletionMethods });
    enqueueDeleteOperation({
      req,
      file,
      deleteFile: createDeleteFileWithSecondaryStorage({ source, deleteFile, deletionMethods }),
      promises,
      resolvedFileIds,
      failedFileIds,
      openai,
    });
  }

  if (agentFiles.length > 0) {
    promises.push(
      db.removeAgentResourceFiles({
        agent_id: req.body.agent_id,
        files: agentFiles,
      }),
    );
  }

  await Promise.allSettled(promises);
  const deletedFileIds = [...resolvedFileIds];
  let metadataDeletedFileIds = deletedFileIds;
  if (deletedFileIds.length > 0) {
    try {
      await db.deleteFiles(deletedFileIds);
    } catch (error) {
      logger.error('Error deleting file metadata after storage deletion', error);
      deletedFileIds.forEach((fileId) => failedFileIds.add(fileId));
      metadataDeletedFileIds = [];
      throw error;
    }
    if (metadataDeletedFileIds.length > 0) {
      for (const asset_id of cleanedAssetIds) {
        try {
          await db.removeAsset({ asset_id });
        } catch (error) {
          // Metadata is already gone. Leave the tombstoned ledger for the
          // reconciler, which can repeat idempotent cleanup and remove it.
          logger.warn(
            `[processDeleteRequest] failed removing cleaned asset ${asset_id}: ${error?.message}`,
          );
        }
      }
      try {
        await db.removeAgentResourceFilesFromAllAgents({ file_ids: metadataDeletedFileIds });
      } catch (error) {
        logger.error('Error cleaning up orphaned agent file references', error);
      }
      const { tombstoneRetainedOrphansAfterRowDelete } = require('./knauf/fileAssetDelete');
      const deletedSet = new Set(metadataDeletedFileIds);
      await tombstoneRetainedOrphansAfterRowDelete({
        db,
        deletedFiles: files.filter((file) => deletedSet.has(file.file_id)),
        retainedAssetIds,
        logger,
      });
    }
    // [knauf] KK20-195 WP3d — record the deletion on the FileAsset ledger
    // (plan §8.1): recount each deleted row's asset and tombstone + remove
    // the ones that lost their last logical reference. Physical cleanup was
    // already confirmed above (files whose storage delete failed never reach
    // the row delete). Covers the direct-delete route, agent detach, and the
    // retention sweep — all of which land here. Best-effort: never throws.
    if (metadataDeletedFileIds.length > 0) {
      const { finalizeAssetsAfterRowDelete } = require('./knauf/fileAssetDelete');
      const deletedSet = new Set(metadataDeletedFileIds);
      await finalizeAssetsAfterRowDelete({
        db,
        deletedFiles: files.filter(
          (f) =>
            deletedSet.has(f.file_id) &&
            !tombstonedAssets.has(f.knauf_asset_id) &&
            !retainedAssetIds.has(f.knauf_asset_id),
        ),
        logger,
      });
    }
    // End [knauf]
  }

  return {
    deletedFileIds: metadataDeletedFileIds,
    failedFileIds: [...failedFileIds],
  };
};

/**
 * Deletes expired file storage before removing the corresponding File records.
 *
 * Mongo TTL indexes delete only the metadata document, so file retention uses
 * this application sweep for records with `expiredAt` instead.
 *
 * @param {object} params
 * @param {AppConfig} params.appConfig
 * @param {number} [params.limit]
 * @param {() => Promise<AppConfig>} [params.loadAppConfig]
 * @returns {Promise<{ scanned: number, deleted: number, failed: number }>}
 */
async function sweepExpiredFiles(options = {}) {
  return sweepExpiredFilesWithDeps(options, {
    getExpiredFiles: db.getExpiredFiles,
    processDeleteRequest,
    logger,
  });
}

function startExpiredFileSweep(options = {}) {
  return startExpiredFileSweepWithDeps(options, {
    sweepExpiredFiles,
    runAsSystem,
    logger,
  });
}

/**
 * Processes a file URL using a specified file handling strategy. This function accepts a strategy name,
 * fetches the corresponding file processing functions (for saving and retrieving file URLs), and then
 * executes these functions in sequence. It first saves the file using the provided URL and then retrieves
 * the URL of the saved file. If any error occurs during this process, it logs the error and throws an
 * exception with an appropriate message.
 *
 * @param {Object} params - The parameters object.
 * @param {FileSources} params.fileStrategy - The file handling strategy to use.
 * Must be a value from the `FileSources` enum, which defines different file
 * handling strategies (like saving to Firebase, local storage, etc.).
 * @param {string} params.userId - The user's unique identifier. Used for creating user-specific paths or
 * references in the file handling process.
 * @param {string} params.URL - The URL of the file to be processed.
 * @param {string} params.fileName - The name that will be used to save the file (including extension)
 * @param {string} params.basePath - The base path or directory where the file will be saved or retrieved from.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {string} [params.tenantId] - Optional tenant identifier for tenant-prefixed storage paths.
 * @param {ServerRequest} [params.req] - Request context used to apply data retention metadata.
 * @returns {Promise<MongoFile>} A promise that resolves to the DB representation (MongoFile)
 *  of the processed file. It throws an error if the file processing fails at any stage.
 */
const processFileURL = async ({
  fileStrategy,
  userId,
  URL,
  fileName,
  basePath,
  context,
  tenantId,
  req,
}) => {
  const { saveURL, getFileURL } = getStrategyFunctions(fileStrategy);
  try {
    const savedFile = await saveURL({ userId, URL, fileName, basePath, tenantId });
    if (!savedFile) {
      throw new Error(`Strategy "${fileStrategy}" did not save "${fileName}"`);
    }

    const {
      bytes = 0,
      type = '',
      dimensions = {},
    } = typeof savedFile === 'string' ? {} : savedFile;
    const fallbackFileName =
      fileStrategy === FileSources.local || fileStrategy === FileSources.firebase
        ? `${userId}/${fileName}`
        : fileName;
    const filepath =
      typeof savedFile === 'string'
        ? savedFile
        : (savedFile.filepath ??
          (await getFileURL({ userId, fileName: fallbackFileName, basePath, tenantId })));
    if (!filepath) {
      throw new Error(`Strategy "${fileStrategy}" did not return a file URL for "${fileName}"`);
    }
    const storageMetadata = getStorageMetadata({
      filepath,
      source: fileStrategy,
      storageKey: typeof savedFile === 'string' ? undefined : savedFile.storageKey,
      storageRegion: typeof savedFile === 'string' ? undefined : savedFile.storageRegion,
    });

    return await db.createFile(
      {
        user: userId,
        file_id: v4(),
        bytes,
        filepath,
        ...storageMetadata,
        filename: fileName,
        source: fileStrategy,
        type,
        context,
        ...(await getRetentionExpiry(req)),
        tenantId,
        width: dimensions.width,
        height: dimensions.height,
      },
      true,
    );
  } catch (error) {
    logger.error(`Error while processing the image with ${fileStrategy}:`, error);
    throw new Error(`Failed to process the image with ${fileStrategy}. ${error.message}`);
  }
};

/**
 * Applies the current strategy for image uploads.
 * Saves file metadata to the database with an expiry TTL.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} [params.res] - The Express response object.
 * @param {ImageMetadata} params.metadata - Additional metadata for the file.
 * @param {boolean} params.returnFile - Whether to return the file metadata or return response as normal.
 * @returns {Promise<void>}
 */
const processImageFile = async ({ req, res, metadata, returnFile = false }) => {
  const { file } = req;
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { handleImageUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id, endpoint } = metadata;

  const { filepath, bytes, width, height, storageKey, storageRegion } = await handleImageUpload({
    req,
    file,
    file_id,
    endpoint,
  });
  const storageMetadata = getStorageMetadata({ filepath, source, storageKey, storageRegion });

  const result = await db.createFile(
    {
      user: req.user.id,
      file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: file.originalname,
      context: FileContext.message_attachment,
      source,
      type: `image/${appConfig.imageOutputType}`,
      ...(await getRetentionExpiry(req)),
      width,
      height,
      tenantId: req.user.tenantId,
    },
    true,
  );

  if (returnFile) {
    return result;
  }
  res.status(200).json({ message: 'File uploaded and processed successfully', ...result });
};

/**
 * Applies the current strategy for image uploads and
 * returns minimal file metadata, without saving to the database.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {FileContext} params.context - The context of the file (e.g., 'avatar', 'image_generation', etc.)
 * @param {boolean} [params.resize=true] - Whether to resize and convert the image to target format. Default is `true`.
 * @param {{ buffer: Buffer, width: number, height: number, bytes: number, filename: string, type: string, file_id: string }} [params.metadata] - Required metadata for the file if resize is false.
 * @returns {Promise<{ filepath: string, filename: string, source: string, type: string}>}
 */
const uploadImageBuffer = async ({ req, context, metadata = {}, resize = true }) => {
  const appConfig = req.config;
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  let { buffer, width, height, bytes, filename, file_id, type } = metadata;
  if (resize) {
    file_id = v4();
    type = `image/${appConfig.imageOutputType}`;
    ({ buffer, width, height, bytes } = await resizeAndConvert({
      inputBuffer: buffer,
      desiredFormat: appConfig.imageOutputType,
    }));
    filename = `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.${
      appConfig.imageOutputType
    }`;
  }
  const fileName = `${file_id}-${filename}`;
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName,
    buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      user: req.user.id,
      file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename,
      context,
      source,
      type,
      width,
      ...(await getRetentionExpiry(req)),
      height,
      tenantId: req.user.tenantId,
    },
    true,
  );
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @returns {Promise<void>}
 */
const processFileUpload = async ({ req, res, metadata }) => {
  const appConfig = req.config;
  const isAssistantUpload = isAssistantsEndpoint(metadata.endpoint);
  const assistantSource =
    metadata.endpoint === EModelEndpoint.azureAssistants ? FileSources.azure : FileSources.openai;
  // Use the configured file strategy for regular file uploads (not vectordb)
  const source = isAssistantUpload ? assistantSource : appConfig.fileStrategy;
  const { handleFileUpload } = getStrategyFunctions(source);
  const { file_id, temp_file_id = null } = metadata;

  /** @type {OpenAI | undefined} */
  let openai;
  if (checkOpenAIStorage(source)) {
    ({ openai } = await getOpenAIClient({ req }));
  }

  const { file } = req;
  const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
  const {
    id,
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    embedded,
    height,
    width,
  } = await sanitizedUploadFn({
    req,
    file,
    file_id,
    openai,
  });

  if (isAssistantUpload && !metadata.message_file && !metadata.tool_resource) {
    await openai.beta.assistants.files.create(metadata.assistant_id, {
      file_id: id,
    });
  } else if (isAssistantUpload && !metadata.message_file) {
    await addResourceFileId({
      req,
      openai,
      file_id: id,
      assistant_id: metadata.assistant_id,
      tool_resource: metadata.tool_resource,
    });
  }

  let filepath = isAssistantUpload ? `${openai.baseURL}/files/${id}` : _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });
  if (isAssistantUpload && file.mimetype.startsWith('image')) {
    const result = await processImageFile({
      req,
      file,
      metadata: { file_id: v4() },
      returnFile: true,
    });
    filepath = result.filepath;
    storageMetadata = getStorageMetadata({
      filepath,
      source: result.source,
      storageKey: result.storageKey,
      storageRegion: result.storageRegion,
    });
  }

  const result = await db.createFile(
    {
      user: req.user.id,
      file_id: id ?? file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: isAssistantUpload ? FileContext.assistants : FileContext.message_attachment,
      model: isAssistantUpload ? req.body.model : undefined,
      type: file.mimetype,
      ...(await getRetentionExpiry(req)),
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
    },
    true,
  );
  res.status(200).json({ message: 'File uploaded and processed successfully', ...result });
};

/**
 * Applies the current strategy for file uploads.
 * Saves file metadata to the database with an expiry TTL.
 * Files must be deleted from the server filesystem manually.
 *
 * @param {Object} params - The parameters object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Express.Response} params.res - The Express response object.
 * @param {FileMetadata} params.metadata - Additional metadata for the file.
 * @returns {Promise<void>}
 */
const processAgentFileUpload = async ({ req, res, metadata }) => {
  const { file } = req;
  const appConfig = req.config;
  const { agent_id, tool_resource, file_id, temp_file_id = null } = metadata;

  let messageAttachment = !!metadata.message_file;

  if (agent_id && !tool_resource && !messageAttachment) {
    throw new Error('No tool resource provided for agent file upload');
  }

  if (tool_resource === EToolResources.file_search && file.mimetype.startsWith('image')) {
    throw new Error('Image uploads are not supported for file search tool resources');
  }

  if (!messageAttachment && !agent_id) {
    throw new Error('No agent ID provided for agent file upload');
  }

  const isImage = file.mimetype.startsWith('image');
  let fileInfoMetadata;
  const entity_id = messageAttachment === true ? undefined : agent_id;
  const basePath = mime.getType(file.originalname)?.startsWith('image') ? 'images' : 'uploads';
  if (tool_resource === EToolResources.execute_code) {
    const isCodeEnabled = await checkCapability(req, AgentCapabilities.execute_code);
    if (!isCodeEnabled) {
      throw new Error('Code execution is not enabled for Agents');
    }
    const { handleFileUpload: uploadCodeEnvFile } = getStrategyFunctions(FileSources.execute_code);
    const stream = fs.createReadStream(file.path);
    /* Resource identity for codeapi's sessionKey:
     * - chat attachments (messageAttachment=true): `kind: 'user'`, codeapi
     *   buckets under `<tenant>:user:<authContext.userId>` regardless of `id`.
     * - agent setup files (messageAttachment=false): `kind: 'agent'`, shared
     *   per agent identity. `id` carries the agent id. */
    const codeKind = messageAttachment === true ? 'user' : 'agent';
    const codeId = messageAttachment === true ? req.user.id : agent_id;
    /* Upload under the same sanitized filename LC stores in its DB
     * (`fileInfo.filename` below uses `sanitizeFilename(originalname)`).
     * Codeapi/file_server use this as the on-disk name in the sandbox
     * — `/mnt/data/<filename>` — and `primeFiles`'s `toolContext` text
     * + `_injected_files.name` both reference `file.filename`. Sending
     * the unsanitized `file.originalname` here makes the sandbox path
     * (with spaces / special chars) drift from what LC tells the model
     * is available, causing FileNotFoundError on the first reference. */
    const sandboxFilename = sanitizeFilename(file.originalname);
    const uploaded = await uploadCodeEnvFile({
      req,
      stream,
      filename: sandboxFilename,
      kind: codeKind,
      id: codeId,
    });
    /* Persist under the structured `codeEnvRef` shape — the only key the
     * post-cutover schema (`metadata.codeEnvRef`) and downstream readers
     * (`primeFiles`, `getCodeFilesByIds`, `categorizeFileForToolResources`,
     * controller filtering) accept. Storing under the legacy
     * `fileIdentifier` key would be silently dropped by mongoose strict
     * mode and the file would lose its sandbox reference on subsequent
     * priming turns. */
    fileInfoMetadata = {
      codeEnvRef: {
        kind: codeKind,
        id: codeId,
        storage_session_id: uploaded.storage_session_id,
        file_id: uploaded.file_id,
      },
    };
  } else if (tool_resource === EToolResources.file_search) {
    const isFileSearchEnabled = await checkCapability(req, AgentCapabilities.file_search);
    if (!isFileSearchEnabled) {
      throw new Error('File search is not enabled for Agents');
    }
    // Note: File search processing continues to dual storage logic below
  } else if (tool_resource === EToolResources.context) {
    const { file_id, temp_file_id = null } = metadata;

    /**
     * @param {object} params
     * @param {string} params.text
     * @param {number} params.bytes
     * @param {string} params.filepath
     * @param {string} params.type
     * @return {Promise<void>}
     */
    const createTextFile = async ({ text, bytes, filepath, type = 'text/plain' }) => {
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes > 15 * megabyte) {
        throw new Error(
          `Extracted text from "${file.originalname}" exceeds the 15MB storage limit (${Math.round(textBytes / megabyte)}MB). Try a shorter document.`,
        );
      }
      const retentionExpiry = await getAgentFileRetentionExpiry({
        req,
        messageAttachment,
        tool_resource,
      });
      const fileInfo = {
        ...removeNullishValues({
          text,
          bytes,
          file_id,
          temp_file_id,
          user: req.user.id,
          type,
          filepath: filepath ?? file.path,
          source: FileSources.text,
          filename: file.originalname,
          model: messageAttachment ? undefined : req.body.model,
          context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
          tenantId: req.user.tenantId,
        }),
        ...retentionExpiry,
      };

      if (!messageAttachment && tool_resource) {
        await db.addAgentResourceFile({
          file_id,
          agent_id,
          tool_resource,
          updatingUserId: req?.user?.id,
        });
      }
      const result = await db.createFile(fileInfo, true);
      return res
        .status(200)
        .json({ message: 'Agent file uploaded and processed successfully', ...result });
    };

    const fileConfig = mergeFileConfig(appConfig.fileConfig);

    // [knauf] NO-TICKET — SVG is readable XML source, not OCR/RAG or a vision bitmap.
    if (/^image\/svg(?:\+xml)?$/i.test(file.mimetype)) {
      const { text, bytes } = await parseTextNative(file);
      const validationError = validateSvgArtifactSource(text);
      if (validationError) {
        throw new Error(`Invalid SVG upload: ${validationError.message}`);
      }
      return await createTextFile({ text, bytes, type: 'image/svg+xml' });
    }
    // End [knauf]

    const shouldUseConfiguredOCR =
      appConfig?.ocr != null &&
      fileConfig.checkType(file.mimetype, fileConfig.ocr?.supportedMimeTypes || []);

    const shouldUseDocumentParser =
      !shouldUseConfiguredOCR && documentParserMimeTypes.some((regex) => regex.test(file.mimetype));

    const shouldUseOCR = shouldUseConfiguredOCR || shouldUseDocumentParser;

    const resolveDocumentText = async () => {
      if (shouldUseConfiguredOCR) {
        try {
          const ocrStrategy = appConfig?.ocr?.strategy ?? FileSources.document_parser;
          const { handleFileUpload } = getStrategyFunctions(ocrStrategy);
          return await handleFileUpload({ req, file, loadAuthValues });
        } catch (err) {
          logger.error(
            `[processAgentFileUpload] Configured OCR failed for "${file.originalname}", falling back to document_parser:`,
            err,
          );
        }
      }
      try {
        const { handleFileUpload } = getStrategyFunctions(FileSources.document_parser);
        return await handleFileUpload({ req, file, loadAuthValues });
      } catch (err) {
        logger.error(
          `[processAgentFileUpload] Document parser failed for "${file.originalname}":`,
          err,
        );
      }
    };

    if (shouldUseConfiguredOCR && !(await checkCapability(req, AgentCapabilities.ocr))) {
      throw new Error('OCR capability is not enabled for Agents');
    }

    if (shouldUseOCR) {
      const ocrResult = await resolveDocumentText();
      if (ocrResult) {
        const { text, bytes, filepath: ocrFileURL } = ocrResult;
        return await createTextFile({ text, bytes, filepath: ocrFileURL });
      }
      throw new Error(
        `Unable to extract text from "${file.originalname}". The document may be image-based and requires an OCR service to process.`,
      );
    }

    const shouldUseSTT = fileConfig.checkType(
      file.mimetype,
      fileConfig.stt?.supportedMimeTypes || [],
    );

    if (shouldUseSTT) {
      const sttService = await STTService.getInstance();
      const { text, bytes } = await processAudioFile({ req, file, sttService });
      return await createTextFile({ text, bytes });
    }

    const shouldUseText = fileConfig.checkType(
      file.mimetype,
      fileConfig.text?.supportedMimeTypes || [],
    );

    if (!shouldUseText) {
      throw new Error(`File type ${file.mimetype} is not supported for text parsing.`);
    }

    const { text, bytes } = await parseText({ req, file, file_id });
    return await createTextFile({ text, bytes, type: file.mimetype });
  }

  // Dual storage pattern for RAG files: Storage + Vector DB
  let storageResult, embeddingResult;
  const isImageFile = file.mimetype.startsWith('image');
  let source = getFileStrategy(appConfig, { isImage: isImageFile });
  // [knauf] KK20-204 — per-user content-hash dedup bookkeeping (file_search path only).
  let knaufContentHash;
  let knaufAssetId;
  let knaufDedupOwner;
  // KK20-195 WP3b — the physical asset reserved for this upload + whether the
  // async-acceptance flag applies to this request (202 instead of sync embed).
  let knaufUploadAsset;
  let knaufAsyncAccepted = false;
  // End [knauf]

  if (tool_resource === EToolResources.file_search) {
    // [knauf] KK20-195 WP3b (subsumes KK20-204's lookup) — reservation-first
    // lifecycle: the physical FileAsset is reserved BEFORE any physical work,
    // so concurrent identical chat uploads coalesce on ONE asset instead of
    // both embedding, and the asset records the whole lifecycle either way.
    // Chat/message attachments dedup per user (dedup_key = scope + hash);
    // agent-library knowledge stays un-deduplicated and agent-scoped
    // (messageAttachment is the discriminator, as under KK20-204).
    // Flag OFF (rollout step 4): claim THIS asset, write one generation in-
    // request, then activate it. Failed cleanup stays durably recoverable.
    // Flag ON: no embed in-request; 202 + indexing projection; the WP4 worker
    //   drains the queue. The flag stays off until WP5 ships the client UX.
    const { computeContentHash } = require('./knauf/contentDedup');
    const {
      reserveForUpload,
      classifyExistingAsset,
      recordSyncEmbed,
    } = require('./knauf/fileSearchAssetLifecycle');
    const {
      isAsyncAcceptedForUser,
      isIndexingWorkerEnabled,
    } = require('./knauf/asyncIndexingConfig');
    const { isAzureSearchEnabledForAgents, parseRetryAfterMs } = require('./VectorDB/crud');
    const { createGenerationRagClient } = require('./knauf/generationRagClient');
    const { checkIndexAdmission } = require('./knauf/indexAdmission');
    const generationRagClient = createGenerationRagClient({ getStrategyFunctions });
    const syncEmbedTimeoutMs =
      Number.parseInt(process.env.RAG_EMBED_SYNC_TIMEOUT_MS ?? '', 10) || 5 * 60 * 1000;
    const syncEmbedAttempts = Math.max(
      1,
      Number.parseInt(process.env.RAG_EMBED_MAX_ATTEMPTS ?? '', 10) || 3,
    );
    const embedGenerationSync = async (params) => {
      const deadline = Date.now() + syncEmbedTimeoutMs;
      const metricRoute = params.embed_route === '/agent/embed' ? 'agent_embed' : 'embed';
      const startedAtMs = Date.now();
      let outcome = 'failure';
      let lastError;
      try {
        for (let attempt = 1; attempt <= syncEmbedAttempts; attempt++) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            break;
          }
          try {
            const result = await generationRagClient.embedGeneration({
              ...params,
              timeoutMs: remainingMs,
            });
            outcome = 'success';
            return result;
          } catch (error) {
            lastError = error;
            const status = error?.response?.status ?? error?.status;
            if (status === 429) {
              recordFileIndexProviderError?.(metricRoute, '429');
            } else if (status >= 500) {
              recordFileIndexProviderError?.(metricRoute, '5xx');
            }
            if (error?.code === 'ECONNABORTED') {
              outcome = 'timeout';
            }
            const retryable = status === 408 || status === 429 || status >= 500 || status == null;
            if (!retryable || attempt === syncEmbedAttempts) {
              throw error;
            }
            const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']) ?? 0;
            const jitterMs = Math.floor(Math.random() * Math.min(1000 * attempt, 5000));
            const delayMs = retryAfterMs + jitterMs;
            if (delayMs >= deadline - Date.now()) {
              throw error;
            }
            recordFileIndexEmbedRetry?.(metricRoute);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError ?? new Error('Embed aborted: end-to-end budget exhausted.');
      } finally {
        recordFileIndexEmbed?.(metricRoute, outcome, (Date.now() - startedAtMs) / 1000);
      }
    };

    knaufAsyncAccepted = isAsyncAcceptedForUser(req.user);

    // Hash every File Search upload. Agent-library assets stay un-deduplicated,
    // but exact replay must still distinguish different same-sized content.
    knaufContentHash = await computeContentHash(file.path);

    let reservation;
    if (req.knaufRecoverAssetId) {
      const recoveryAsset = await db.getAssetByAssetId(req.knaufRecoverAssetId);
      if (!recoveryAsset) {
        throw new Error('file_asset_finalization_asset_missing');
      }
      const expectedScopeType = messageAttachment ? 'user' : 'agent';
      const expectedScopeId = String(messageAttachment ? req.user.id : (entity_id ?? req.user.id));
      if (
        recoveryAsset.scope_type !== expectedScopeType ||
        String(recoveryAsset.scope_id) !== expectedScopeId
      ) {
        throw new Error('file_asset_finalization_scope_mismatch');
      }
      reservation = { asset: recoveryAsset, created: false };
    } else {
      reservation = await reserveForUpload({
        db,
        userId: req.user.id,
        // The physical identity must not be reusable with the logical client
        // file id. Otherwise a late cleanup from a deleted incarnation can
        // remove the same numbered generation of a later upload.
        asset_id: v4(),
        entityId: entity_id,
        messageAttachment,
        contentHash: knaufContentHash,
        azureSearchForAgents: isAzureSearchEnabledForAgents(),
        bytes: file.size, // F9 — reserved for the byte-cap admission below
      });
    }
    knaufUploadAsset = reservation.asset;
    knaufAssetId = reservation.asset.asset_id;
    knaufDedupOwner = messageAttachment && reservation.created ? true : undefined;

    if (knaufAsyncAccepted && reservation.created) {
      // Admission (plan §9.3, review R7) — reserve-then-recheck-or-compensate:
      // the reservation above is durably counted BEFORE this decision, so
      // concurrent uploads can never all pass the same stale count (TOCTOU).
      // Rejection removes the reservation this request just made. Sync
      // uploads and found-assets skip: no new backlog either way.
      const admission = await checkIndexAdmission({
        db,
        scope_type: messageAttachment ? 'user' : 'agent',
        scope_id: messageAttachment ? req.user.id : String(entity_id ?? req.user.id),
        incomingBytes: file.size ?? 0,
        countIncludesSelf: true,
      });
      if (!admission.admitted) {
        await db.tombstoneForDelete({ asset_id: knaufAssetId }).catch(() => {});
        await db.removeAsset({ asset_id: knaufAssetId }).catch(() => {});
        return res
          .status(429)
          .json({ error: 'file_indexing_backlog_full', reason: admission.reason, file_id });
      }
    }

    let runCreatedPath = reservation.created;
    let runRecoveredSyncPath = false;
    if (!reservation.created) {
      const verdict = classifyExistingAsset(reservation.asset, {
        now: new Date(),
        // Reclaim only when nothing else reaps stale assets: with the worker
        // enabled its expired-lease re-claim + the reconciler own recovery, so
        // deleting a stale asset here would race/discard their work.
        reclaimable: !isIndexingWorkerEnabled(),
      });
      if (verdict === 'reuse' || verdict === 'reuse_stale_profile') {
        // Establish the new logical reference before accepting the shared
        // physical asset. A concurrent last-reference delete either sees this
        // row and retains the asset, or tombstones first; the re-read below
        // detects that state and removes the pending row.
        source = reservation.asset.blob?.source ?? source;
        const pendingReuse = await db.createFile(
          removeNullishValues({
            user: req.user.id,
            file_id,
            temp_file_id,
            knauf_asset_id: knaufAssetId,
            knauf_upload_batch_id:
              typeof metadata.batch_id === 'string' && metadata.batch_id.length <= 64
                ? metadata.batch_id
                : undefined,
            conversationId:
              req.body.conversationId && req.body.conversationId !== Constants.NEW_CONVO
                ? req.body.conversationId
                : undefined,
            filename: sanitizeFilename(file.originalname),
            filepath: reservation.asset.blob?.path,
            type: file.mimetype,
            bytes: reservation.asset.blob?.bytes,
            context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
            embedded: false,
            source,
            tenantId: req.user.tenantId,
            knauf_content_hash: knaufContentHash,
            knauf_upload_finalized: false,
          }),
          true,
          { userId: req.user.id, tenantId: req.user.tenantId ?? null },
        );
        if (!pendingReuse) {
          throw new Error('file_asset_pending_file_lost');
        }
        const confirmedAsset = await db.getAssetByAssetId(knaufAssetId);
        if (
          !confirmedAsset ||
          confirmedAsset.status !== 'ready' ||
          confirmedAsset.delete_requested_at != null ||
          confirmedAsset.active_generation == null ||
          confirmedAsset.active_generation !== reservation.asset.active_generation
        ) {
          try {
            await db.deleteFiles([file_id]);
          } catch (error) {
            // The asset tombstone remains authoritative; case 5 of the
            // reconciler removes this interrupted pending row before cleanup.
            logger.error(
              `[processAgentFileUpload][alert][pending_reuse_rollback_failed] ${file_id}: ${error?.message}`,
            );
          }
          return res.status(409).json({ error: 'file_asset_conflict', file_id });
        }
        knaufUploadAsset = confirmedAsset;
        // Same semantics as the KK20-204 dedup HIT: reuse the shared asset's
        // blob + embeddings; no storage upload, no embed. The route's finally
        // cleans the unconsumed temp file.
        storageResult = {
          bytes: confirmedAsset.blob?.bytes,
          filename: file.originalname,
          filepath: confirmedAsset.blob?.path,
          embedded: true,
        };
        embeddingResult = { embedded: true, filename: file.originalname };
      } else if (verdict === 'reclaim') {
        const staleAsset = reservation.asset;
        const hasQueuedBlob =
          staleAsset.blob?.path && ['queued', 'processing'].includes(staleAsset.status);
        if (hasQueuedBlob) {
          if (knaufAsyncAccepted) {
            return res.status(409).json({ error: 'file_indexing_in_progress', file_id });
          }
          // Reclaim the expired claim on the SAME physical asset. Replacing
          // the asset would let a late claimant write vectors after its ledger
          // was removed. Token + generation fencing now makes the old claimant
          // clean only its own obsolete generation.
          logger.warn(
            `[knauf][KK20-195] resuming abandoned '${staleAsset.status}' asset ${knaufAssetId}`,
          );
          source = staleAsset.blob.source ?? source;
          storageResult = {
            bytes: staleAsset.blob.bytes,
            filename: staleAsset.blob.filename ?? file.originalname,
            filepath: staleAsset.blob.path,
            embedded: false,
          };
          runRecoveredSyncPath = true;
        } else {
          // A stale uploading reservation has no queued blob/generation to
          // resume. Clean its durable blob intent, then reserve a new asset.
          logger.warn(
            `[knauf][KK20-195] reclaiming abandoned '${staleAsset.status}' asset ${knaufAssetId} for re-upload`,
          );
          const { gcAssetThroughLifecycle } = require('./knauf/fileAssetDelete');
          const reclaimed = await gcAssetThroughLifecycle({
            db,
            asset_id: knaufAssetId,
            logger,
            cleanup: async () => {
              if (!staleAsset.blob?.path) {
                return true; // died before a blob was persisted — nothing to clean
              }
              try {
                const { deleteFile } = getStrategyFunctions(staleAsset.blob.source ?? source);
                await deleteFile(req, {
                  file_id: knaufAssetId,
                  filepath: staleAsset.blob.path,
                  source: staleAsset.blob.source ?? source,
                  embedded: false,
                });
                return true;
              } catch (blobError) {
                logger.warn(
                  `[knauf][KK20-195] reclaim blob cleanup failed for ${knaufAssetId}: ${blobError?.message}`,
                );
                return false;
              }
            },
          });
          if (!reclaimed) {
            // The abandoned blob could not be cleaned — the ledger is kept
            // (delete_failed) for recovery; never re-drive onto un-cleaned bytes.
            return res.status(409).json({ error: 'file_indexing_in_progress', file_id });
          }
          const fresh = await reserveForUpload({
            db,
            userId: req.user.id,
            asset_id: v4(),
            entityId: entity_id,
            messageAttachment,
            contentHash: knaufContentHash,
            azureSearchForAgents: isAzureSearchEnabledForAgents(),
            bytes: file.size, // F9 — reserved for the byte-cap admission
          });
          if (!fresh.created) {
            // A concurrent upload took the freed slot between remove and
            // re-reserve — that request is the live owner now, so this is a
            // genuine in-flight conflict.
            return res.status(409).json({ error: 'file_indexing_in_progress', file_id });
          }
          knaufUploadAsset = fresh.asset;
          knaufAssetId = fresh.asset.asset_id;
          knaufDedupOwner = messageAttachment ? true : undefined;
          runCreatedPath = true;
        }
      } else {
        // in_progress / retry_failed / deleting — stable conflicts for now:
        // the WP3c status/retry endpoints upgrade in_progress to a 202 "join"
        // and failed to an authorized retry. Never duplicate physical work.
        const codes = {
          in_progress: 'file_indexing_in_progress',
          retry_failed: 'file_asset_failed',
          deleting: 'file_asset_deleting',
        };
        return res.status(409).json({ error: codes[verdict] ?? 'file_asset_conflict', file_id });
      }
    }

    const runSyncGenerationEmbed = (createdThisRequest) =>
      recordSyncEmbed({
        db,
        asset_id: knaufAssetId,
        createdThisRequest,
        logger,
        embed: async ({ generation, index_profile }) => {
          await embedGenerationSync({
            asset_id: knaufAssetId,
            generation,
            index_profile,
            embed_route: knaufUploadAsset.embed_route,
            blob: {
              source,
              path: storageResult.filepath,
              bytes: storageResult.bytes,
              mime: file.mimetype,
              filename: sanitizeFilename(file.originalname),
            },
            scope: {
              userId: req.user.id,
              entityId: messageAttachment ? req.user.id : entity_id,
            },
          });
          return { embedded: true, filename: file.originalname };
        },
        cleanupGeneration: ({ generation }) =>
          generationRagClient.deleteGeneration({
            asset_id: knaufAssetId,
            generation,
            vector_backend: knaufUploadAsset.vector_backend,
            userId: req.user.id,
          }),
      });

    if (runCreatedPath) {
      // KK20-195 review F3 (re-review) — persist a PENDING File row BEFORE any
      // physical work. Process death after markQueued but before the final
      // createFile below used to leave a queued asset with NO user-visible File
      // (no status, no retry, and the worker's resolveScope finds no owning
      // user). The pending row references the asset from the start; the final
      // createFile upserts it (same file_id) to its finished state. embedded=false
      // so the indexing projection shows it as in-flight, not ready.
      let uploadStrategy;
      let knaufBlobIntentPath;
      try {
        uploadStrategy = getStrategyFunctions(source);
        if (source === FileSources.azure_blob && typeof uploadStrategy.getFileURL === 'function') {
          // Azure's blob key is deterministic once the immutable asset id and
          // multer temp basename are known. Persist its URL before streaming so
          // a process death after upload can still be reconciled and cleaned.
          knaufBlobIntentPath = await uploadStrategy.getFileURL({
            fileName: `${knaufAssetId}__${path.basename(file.path)}`,
            basePath,
            userId: req.user.id,
          });
        }
        const pendingFileData = removeNullishValues({
          user: req.user.id,
          file_id,
          temp_file_id,
          knauf_asset_id: knaufAssetId,
          knauf_upload_batch_id:
            typeof metadata.batch_id === 'string' && metadata.batch_id.length <= 64
              ? metadata.batch_id
              : undefined,
          conversationId:
            req.body.conversationId && req.body.conversationId !== Constants.NEW_CONVO
              ? req.body.conversationId
              : undefined,
          filename: sanitizeFilename(file.originalname),
          filepath: knaufBlobIntentPath,
          type: file.mimetype,
          bytes: file.size,
          context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
          embedded: false,
          source,
          tenantId: req.user.tenantId,
          knauf_content_hash: knaufContentHash,
          knauf_dedup_owner: knaufDedupOwner,
          knauf_upload_finalized: false,
        });
        const pendingOwnerScope = { userId: req.user.id, tenantId: req.user.tenantId ?? null };
        let pendingFile;
        try {
          pendingFile = await db.createFile(pendingFileData, true, pendingOwnerScope);
        } catch (pendingError) {
          if (pendingError?.code !== 11000) {
            throw pendingError;
          }
          // Concurrent upserts can both miss; after one insert wins, the retry is an update.
          const ownerClaimConflict = Boolean(pendingError?.keyPattern?.knauf_dedup_owner);
          // If an older/pending owner already owns this content hash, keep this logical
          // upload visible as a non-owner row and reuse the shared asset lifecycle.
          pendingFile = await db.createFile(
            ownerClaimConflict
              ? { ...pendingFileData, knauf_dedup_owner: undefined }
              : pendingFileData,
            true,
            pendingOwnerScope,
          );
        }
        if (!pendingFile) {
          throw new Error('file_asset_pending_file_lost');
        }
      } catch (pendingError) {
        // No physical work has started yet. Fail closed and release the empty
        // reservation; continuing without the recovery anchor can create a
        // queued asset that no user can poll, retry, or delete.
        await db.tombstoneForDelete({ asset_id: knaufAssetId }).catch(() => {});
        await db.removeAsset({ asset_id: knaufAssetId }).catch(() => {});
        throw pendingError;
      }
      try {
        const { handleFileUpload } = uploadStrategy;
        const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
        storageResult = await sanitizedUploadFn({
          req,
          file,
          file_id: knaufAssetId,
          basePath,
          entity_id,
        });
        // F3 — record the blob path on the pending File as soon as it is known
        // (recoverable blob intent): a crash before markQueued still leaves a
        // discoverable blob (File.filepath) for delete/reconcile to clean.
        const blobIntent = await db.updateFile({
          file_id,
          filepath: storageResult.filepath,
          bytes: storageResult.bytes,
        });
        if (!blobIntent) {
          const intentLost = new Error('file_asset_blob_intent_lost');
          intentLost.knaufCode = 'file_asset_blob_intent_lost';
          throw intentLost;
        }
        // KK20-195 review R3 — the CAS can MISS (null), not just throw: a
        // concurrent tombstone leaves the asset 'uploading' and nothing would
        // ever drain it. A miss is the same failure as a throw.
        const queued = await db.markQueued({
          asset_id: knaufAssetId,
          // Keep flag-off work invisible to the worker during the tiny queue →
          // explicit-claim window. If this request dies, it becomes worker-
          // eligible after the same bounded sync budget.
          next_attempt_at: knaufAsyncAccepted
            ? undefined
            : new Date(Date.now() + syncEmbedTimeoutMs),
          blob: {
            source,
            path: storageResult.filepath,
            bytes: storageResult.bytes,
            mime: file.mimetype,
            filename: sanitizeFilename(file.originalname),
          },
        });
        if (!queued) {
          const missed = new Error('file_asset_queue_transition_lost');
          missed.knaufCode = 'file_asset_queue_transition_lost';
          throw missed;
        }

        if (knaufAsyncAccepted) {
          // Async acceptance: the worker embeds; this request only records
          // durable state. embedded=false until generation activation (WP4).
          embeddingResult = { embedded: false, filename: file.originalname };
        } else {
          // Synchronous execution uses the same generation-safe contract as
          // the worker. A lost claim can therefore delete only its own
          // generation, never a successor's vectors.
          embeddingResult = await runSyncGenerationEmbed(true);
        }
      } catch (error) {
        // A HANDLED failure (blob upload / queue transition / sync embed) —
        // release everything this request created so nothing lingers. (Process
        // DEATH is the recoverable case F3 covers: the pending File + asset
        // remain, user-visible and retryable, blob discoverable via File.filepath.)
        // KK20-195 review R3 — if the blob DID land, delete it too: removing only
        // the ledger row orphaned the uploaded bytes.
        if (error?.knaufPreserveLifecycle) {
          throw error;
        }
        let blobCleanupFailed = false;
        if (storageResult?.filepath) {
          try {
            const { deleteFile } = getStrategyFunctions(source);
            await deleteFile(req, {
              file_id: knaufAssetId,
              filepath: storageResult.filepath,
              source,
              embedded: false,
            });
          } catch (blobError) {
            blobCleanupFailed = true;
            logger.warn(
              `[processAgentFileUpload][alert][blob_cleanup_deferred] ${knaufAssetId}: ${blobError?.message}`,
            );
          }
        }
        if (blobCleanupFailed) {
          // Keep both recovery anchors. Removing the asset and pending File
          // here would leave the failed Azure/local blob permanently orphaned.
          await db.tombstoneForDelete({ asset_id: knaufAssetId }).catch(() => null);
          await db
            .markDeleteFailed({
              asset_id: knaufAssetId,
              error_code: 'blob_cleanup_failed',
            })
            .catch(() => false);
          error.knaufPreserveLifecycle = true;
          throw error;
        }
        await db.tombstoneForDelete({ asset_id: knaufAssetId }).catch(() => {});
        await db.removeAsset({ asset_id: knaufAssetId }).catch(() => {});
        // F3 — remove the pending File row this request inserted, so a handled
        // failure leaves no orphaned "uploading" row.
        await db.deleteFiles([file_id]).catch(() => {});
        throw error;
      }
    }
    if (runRecoveredSyncPath) {
      embeddingResult = await runSyncGenerationEmbed(false);
    }
    // End [knauf]

    // Vector status will be stored at root level, no need for metadata
    fileInfoMetadata = {};
  } else {
    // Standard single storage for non-RAG files
    const { handleFileUpload } = getStrategyFunctions(source);
    const sanitizedUploadFn = createSanitizedUploadWrapper(handleFileUpload);
    storageResult = await sanitizedUploadFn({
      req,
      file,
      file_id,
      basePath,
      entity_id,
    });
  }

  let {
    bytes,
    filename,
    filepath: _filepath,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
    height,
    width,
  } = storageResult;
  // For RAG files, use embedding result; for others, use storage result
  let embedded = storageResult.embedded;
  if (tool_resource === EToolResources.file_search) {
    embedded = embeddingResult?.embedded;
    filename = embeddingResult?.filename || filename;
  }

  let filepath = _filepath;
  let storageMetadata = getStorageMetadata({
    filepath,
    source,
    storageKey: _storageKey,
    storageRegion: _storageRegion,
  });

  if (!messageAttachment && tool_resource) {
    await db.addAgentResourceFile({
      file_id,
      agent_id,
      tool_resource,
      updatingUserId: req?.user?.id,
    });
  }

  if (isImage) {
    const result = await processImageFile({
      req,
      file,
      metadata: { file_id: v4() },
      returnFile: true,
    });
    filepath = result.filepath;
    storageMetadata = getStorageMetadata({
      filepath,
      source: result.source,
      storageKey: result.storageKey,
      storageRegion: result.storageRegion,
    });
  }

  const retentionExpiry = await getAgentFileRetentionExpiry({
    req,
    messageAttachment,
    tool_resource,
  });
  const fileInfo = {
    ...removeNullishValues({
      user: req.user.id,
      // [knauf] KK20-203 — stamp the originating conversation so chat deletion can
      // cascade-clean this file (chat file_search uploads carried no conversationId
      // before, which is why they orphaned). removeNullishValues drops it when
      // absent; the NEW_CONVO sentinel ('new') is not a real id, so treat as absent.
      conversationId:
        req.body.conversationId && req.body.conversationId !== Constants.NEW_CONVO
          ? req.body.conversationId
          : undefined,
      // End [knauf]
      file_id,
      temp_file_id,
      bytes,
      filepath,
      ...storageMetadata,
      filename: filename ?? sanitizeFilename(file.originalname),
      context: messageAttachment ? FileContext.message_attachment : FileContext.agents,
      model: messageAttachment ? undefined : req.body.model,
      metadata: fileInfoMetadata,
      type: file.mimetype,
      embedded,
      source,
      height,
      width,
      tenantId: req.user.tenantId,
      // [knauf] KK20-204 — content-hash dedup bookkeeping. All undefined on non-
      // file_search paths (→ dropped by removeNullishValues). knauf_asset_id is the
      // immutable physical id the shared blob + embeddings live under (new UUID
      // for a new asset; the existing physical id on dedup reuse).
      // knauf_dedup_owner marks the embed owner (unique per (user, hash) via index).
      knauf_content_hash: knaufContentHash,
      knauf_asset_id: knaufAssetId,
      knauf_dedup_owner: knaufDedupOwner,
      // End [knauf]
      // [knauf] KK20-195 WP3b — client batch id for multi-file selections
      // (drives the owner-scoped batch-status projection; never authorization).
      knauf_upload_batch_id:
        typeof metadata.batch_id === 'string' && metadata.batch_id.length <= 64
          ? metadata.batch_id
          : undefined,
      knauf_upload_finalized: tool_resource === EToolResources.file_search ? true : undefined,
      // End [knauf]
    }),
    ...retentionExpiry,
  };

  // [knauf] KK20-204 — unique-owner index: at most one knauf_dedup_owner row per
  // (user, content-hash). On a concurrent first-upload race the loser's insert hits
  // a duplicate-key error; accept it as a non-owner row (its own embedding is a
  // transient duplicate the delete-time group GC reclaims) and log so the race
  // frequency is observable. Retrieval/GC key on knauf_asset_id, so the row works.
  let result;
  // KK20-195 WP3a — owner-scoped upsert: with the client-supplied file_id now
  // adopted as the logical id, the write filter carries the owner so a replay
  // can never overwrite a row that belongs to a different user.
  const knaufOwnerScope = { userId: req.user.id, tenantId: req.user.tenantId ?? null };
  try {
    result = await db.createFile(fileInfo, true, knaufOwnerScope);
  } catch (error) {
    if (error?.code === 11000 && fileInfo.knauf_dedup_owner) {
      logger.info(
        '[knauf][dedup] concurrent owner claim for content-hash; recording this upload as a non-owner duplicate (group GC will reclaim it)',
      );
      result = await db.createFile(
        { ...fileInfo, knauf_dedup_owner: undefined },
        true,
        knaufOwnerScope,
      );
    } else {
      throw error;
    }
  }
  if (!result) {
    throw new Error('file_asset_final_file_lost');
  }
  // End [knauf]

  // [knauf] KK20-195 WP3b — superset response (plan §6.2 fields as SIBLINGS of
  // the flat TFile spread, never a nested body: current clients parse the flat
  // shape). 202 = async acceptance (durable state exists, indexing pending).
  if (knaufUploadAsset) {
    const { buildIndexingProjection } = require('./knauf/fileSearchAssetLifecycle');
    const liveAsset = await db.getAssetByAssetId(knaufAssetId).catch(() => null);
    const indexing = buildIndexingProjection(liveAsset ?? knaufUploadAsset);
    const statusCode = knaufAsyncAccepted && !indexing.ready ? 202 : 200;
    return res.status(statusCode).json({
      message:
        statusCode === 202
          ? 'File accepted; indexing in progress'
          : 'Agent file uploaded and processed successfully',
      ...result,
      indexing,
      ...(fileInfo.knauf_upload_batch_id ? { batch_id: fileInfo.knauf_upload_batch_id } : {}),
    });
  }
  // End [knauf]
  res.status(200).json({ message: 'Agent file uploaded and processed successfully', ...result });
};

/**
 * @param {object} params - The params object.
 * @param {OpenAI} params.openai - The OpenAI client instance.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} params.userId - The user ID.
 * @param {string} [params.filename] - The name of the file. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.saveFile=false] - Whether to save the file metadata to the database.
 * @param {boolean} [params.updateUsage=false] - Whether to update file usage in database.
 */
const processOpenAIFile = async ({
  openai,
  file_id,
  userId,
  filename,
  saveFile = false,
  updateUsage = false,
}) => {
  const _file = await openai.files.retrieve(file_id);
  const originalName = filename ?? (_file.filename ? path.basename(_file.filename) : undefined);
  const filepath = `${openai.baseURL}/files/${userId}/${file_id}${
    originalName ? `/${originalName}` : ''
  }`;
  const type = mime.getType(originalName ?? file_id);
  const source =
    openai.req.body.endpoint === EModelEndpoint.azureAssistants
      ? FileSources.azure
      : FileSources.openai;
  const file = {
    ..._file,
    type,
    file_id,
    filepath,
    usage: 1,
    user: userId,
    context: _file.purpose,
    source,
    model: openai.req.body.model,
    filename: originalName ?? file_id,
    ...(await getRetentionExpiry(openai.req)),
    tenantId: openai.req?.user?.tenantId,
  };

  if (saveFile) {
    await db.createFile(file, true);
  } else if (updateUsage) {
    try {
      await db.updateFileUsage({
        file_id,
        user: userId,
        tenantId: openai.req?.user?.tenantId,
      });
    } catch (error) {
      logger.error('Error updating file usage', error);
    }
  }

  return file;
};

/**
 * Process OpenAI image files, convert to target format, save and return file metadata.
 * @param {object} params - The params object.
 * @param {ServerRequest} params.req - The Express request object.
 * @param {Buffer} params.buffer - The image buffer.
 * @param {string} params.file_id - The file ID.
 * @param {string} params.filename - The filename.
 * @param {string} params.fileExt - The file extension.
 * @returns {Promise<MongoFile>} The file metadata.
 */
const processOpenAIImageOutput = async ({ req, buffer, file_id, filename, fileExt }) => {
  const currentDate = new Date();
  const formattedDate = currentDate.toISOString();
  const appConfig = req.config;
  const _file = await convertImage(req, buffer, undefined, `${file_id}${fileExt}`);

  // Create only one file record with the correct information
  const file = {
    ..._file,
    usage: 1,
    user: req.user.id,
    type: mime.getType(fileExt),
    createdAt: formattedDate,
    updatedAt: formattedDate,
    source: getFileStrategy(appConfig, { isImage: true }),
    context: FileContext.assistants_output,
    file_id,
    filename,
    ...(await getRetentionExpiry(req)),
    tenantId: req.user.tenantId,
  };
  try {
    await db.createFile(file, true);
  } catch (error) {
    logger.warn('Error saving OpenAI image output file metadata', error);
  }
  return file;
};

/**
 * Retrieves and processes an OpenAI file based on its type.
 *
 * @param {Object} params - The params passed to the function.
 * @param {OpenAIClient} params.openai - The OpenAI client instance.
 * @param {RunClient} params.client - The LibreChat client instance: either refers to `openai` or `streamRunManager`.
 * @param {string} params.file_id - The ID of the file to retrieve.
 * @param {string} [params.basename] - The basename of the file (if image); e.g., 'image.jpg'. `undefined` for `file_citation` annotations.
 * @param {boolean} [params.unknownType] - Whether the file type is unknown.
 * @returns {Promise<{file_id: string, filepath: string, source: string, bytes?: number, width?: number, height?: number} | null>}
 * - Returns null if `file_id` is not defined; else, the file metadata if successfully retrieved and processed.
 */
async function retrieveAndProcessFile({
  openai,
  client,
  file_id,
  basename: _basename,
  unknownType,
}) {
  if (!file_id) {
    return null;
  }

  let basename = _basename;
  const processArgs = { openai, file_id, filename: basename, userId: client.req.user.id };

  // If no basename provided, return only the file metadata
  if (!basename) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  const fileExt = path.extname(basename);
  if (client.attachedFileIds?.has(file_id) || client.processedFileIds?.has(file_id)) {
    return processOpenAIFile({ ...processArgs, updateUsage: true });
  }

  /**
   * @returns {Promise<Buffer>} The file data buffer.
   */
  const getDataBuffer = async () => {
    const response = await openai.files.content(file_id);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  let dataBuffer;
  if (unknownType || !fileExt || imageExtRegex.test(basename)) {
    try {
      dataBuffer = await getDataBuffer();
    } catch (error) {
      logger.error('Error downloading file from OpenAI:', error);
      dataBuffer = null;
    }
  }

  if (!dataBuffer) {
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }

  // If the filetype is unknown, inspect the file
  if (dataBuffer && (unknownType || !fileExt)) {
    const detectedExt = await determineFileType(dataBuffer);
    const isImageOutput = detectedExt && imageExtRegex.test('.' + detectedExt);

    if (!isImageOutput) {
      return await processOpenAIFile({ ...processArgs, saveFile: true });
    }

    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt: detectedExt,
    });
  } else if (dataBuffer && imageExtRegex.test(basename)) {
    return await processOpenAIImageOutput({
      file_id,
      req: client.req,
      buffer: dataBuffer,
      filename: basename,
      fileExt,
    });
  } else {
    logger.debug(`[retrieveAndProcessFile] Non-image file type detected: ${basename}`);
    return await processOpenAIFile({ ...processArgs, saveFile: true });
  }
}

/**
 * Converts a base64 string to a buffer.
 * @param {string} base64String
 * @returns {Buffer<ArrayBufferLike>}
 */
function base64ToBuffer(base64String) {
  try {
    const typeMatch = base64String.match(/^data:([A-Za-z-+/]+);base64,/);
    const type = typeMatch ? typeMatch[1] : '';

    const base64Data = base64String.replace(/^data:([A-Za-z-+/]+);base64,/, '');

    if (!base64Data) {
      throw new Error('Invalid base64 string');
    }

    return {
      buffer: Buffer.from(base64Data, 'base64'),
      type,
    };
  } catch (error) {
    throw new Error(`Failed to convert base64 to buffer: ${error.message}`);
  }
}

async function saveBase64Image(
  url,
  { req, file_id: _file_id, filename: _filename, endpoint, context, resolution },
) {
  const appConfig = req.config;
  const effectiveResolution = resolution ?? appConfig.fileConfig?.imageGeneration ?? 'high';
  const file_id = _file_id ?? v4();
  let filename = `${file_id}-${_filename}`;
  const { buffer: inputBuffer, type } = base64ToBuffer(url);
  if (!path.extname(_filename)) {
    const extension = mime.getExtension(type);
    if (extension) {
      filename += `.${extension}`;
    } else {
      throw new Error(`Could not determine file extension from MIME type: ${type}`);
    }
  }

  const image = await resizeImageBuffer(inputBuffer, effectiveResolution, endpoint);
  const source = getFileStrategy(appConfig, { isImage: true });
  const { saveBuffer } = getStrategyFunctions(source);
  const filepath = await saveBuffer({
    userId: req.user.id,
    fileName: filename,
    buffer: image.buffer,
    tenantId: req.user.tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source });
  return await db.createFile(
    {
      type,
      source,
      context,
      file_id,
      filepath,
      ...storageMetadata,
      filename,
      user: req.user.id,
      bytes: image.bytes,
      width: image.width,
      ...(await getRetentionExpiry(req)),
      height: image.height,
      tenantId: req.user.tenantId,
    },
    true,
  );
}

/**
 * Filters a file based on its size and the endpoint origin.
 *
 * @param {Object} params - The parameters for the function.
 * @param {ServerRequest} params.req - The request object from Express.
 * @param {string} [params.req.endpoint]
 * @param {string} [params.req.file_id]
 * @param {number} [params.req.width]
 * @param {number} [params.req.height]
 * @param {number} [params.req.version]
 * @param {boolean} [params.image] - Whether the file expected is an image.
 * @param {boolean} [params.isAvatar] - Whether the file expected is a user or entity avatar.
 * @returns {void}
 *
 * @throws {Error} If a file exception is caught (invalid file size or type, lack of metadata).
 */
function filterFile({ req, image, isAvatar }) {
  const { file } = req;
  const { endpoint, endpointType, file_id, width, height } = req.body;

  if (!file_id && !isAvatar) {
    throw new Error('No file_id provided');
  }

  if (file.size === 0) {
    throw new Error('Empty file uploaded');
  }

  /* parse to validate api call, throws error on fail */
  if (!isAvatar) {
    isUUID.parse(file_id);
  }

  if (!endpoint && !isAvatar) {
    throw new Error('No endpoint provided');
  }

  const appConfig = req.config;
  const fileConfig = mergeFileConfig(appConfig.fileConfig);

  const endpointFileConfig = getEndpointFileConfig({
    endpoint,
    fileConfig,
    endpointType,
  });
  const fileSizeLimit =
    isAvatar === true ? fileConfig.avatarSizeLimit : endpointFileConfig.fileSizeLimit;

  // [knauf] The Knauf upload endpoints (azureOpenAI chat + agents) carry the
  // restricted allow-list in librechat.yaml (&knauf_allowed_mime). Gate all
  // Knauf-specific rejection messaging + per-category caps to them, so a future
  // non-Knauf endpoint or the broad upstream default keeps upstream behavior.
  // (mergeWithDefault always backfills endpointFileConfig.supportedMimeTypes, so
  // its presence can't be the opt-in signal — the endpoint id is.) A file_search
  // upload (agent knowledge) ALSO follows this policy regardless of the agent's
  // model-provider endpoint: KnaufFileSearch resolves the agents policy client-side,
  // and this `tool_resource` check is the server-side backstop so the per-category
  // caps can't be bypassed by a non-Knauf endpoint on a file_search upload. On these
  // endpoints the per-category cap (enforced below) is the AUTHORITATIVE per-file
  // size gate, so compute it here and skip the generic endpoint fileSizeLimit check
  // for capped types — keeping the boundary + message in lockstep with the client
  // (validateFiles), which would otherwise diverge at the data=50 MB cap (which
  // equals fileSizeLimit). Every allow-listed type is capped. KK20-190.
  const isKnaufCappedEndpoint =
    endpoint === EModelEndpoint.azureOpenAI ||
    endpoint === EModelEndpoint.agents ||
    req.body.tool_resource === EToolResources.file_search;
  const knaufCategoryCap =
    isAvatar !== true && isKnaufCappedEndpoint ? knaufCategorySizeLimit(file.mimetype) : undefined;
  // End [knauf]

  // [knauf] Skip the generic endpoint size check when a Knauf per-category cap
  // applies (the category check below is authoritative for capped types). KK20-190.
  if (knaufCategoryCap == null && file.size > fileSizeLimit) {
    throw new Error(
      `File size limit of ${fileSizeLimit / megabyte} MB exceeded for ${
        isAvatar ? 'avatar upload' : `${endpoint} endpoint`
      }`,
    );
  }
  // End [knauf]

  const isSupportedMimeType = fileConfig.checkType(
    file.mimetype,
    endpointFileConfig.supportedMimeTypes,
  );

  if (!isSupportedMimeType) {
    // [knauf] Actionable rejection on the Knauf endpoints: legacy Office binaries
    // (.doc/.xls/.ppt) get specific Save-As-to-OOXML help; anything else gets a
    // friendly supported-formats message. Forwarded via resolveUploadErrorMessage
    // + localized client-side. Other endpoints keep the upstream generic error.
    // KK20-190 (upload-guidance follow-up).
    if (isKnaufCappedEndpoint) {
      throw new Error(
        knaufLegacyOfficeErrorKey(file.mimetype, file.originalname) ??
          'com_knauf_error_unsupported_type',
      );
    }
    // End [knauf]
    throw new Error('Unsupported file type');
  }

  // [knauf] Per-category size cap (documents 25 / data 50 / images 20 MB) — the
  // authoritative size gate on the Knauf endpoints (replaces the generic check,
  // which is skipped above for capped types). Throws the i18n key, surfaced to the
  // client via resolveUploadErrorMessage (USER_FACING_UPLOAD_ERRORS) + localize().
  // `knaufCategoryCap` is undefined for avatars / non-Knauf endpoints / uncapped
  // types, so this is a no-op there. Strict `>` mirrors validateFiles. KK20-190.
  if (knaufCategoryCap != null && file.size > knaufCategoryCap) {
    throw new Error(knaufCategorySizeErrorKey(file.mimetype));
  }
  // End [knauf]

  if (!image || isAvatar === true) {
    return;
  }

  if (!width) {
    throw new Error('No width provided');
  }

  if (!height) {
    throw new Error('No height provided');
  }
}

module.exports = {
  filterFile,
  processFileURL,
  saveBase64Image,
  processImageFile,
  uploadImageBuffer,
  sweepExpiredFiles,
  startExpiredFileSweep,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
  retrieveAndProcessFile,
};

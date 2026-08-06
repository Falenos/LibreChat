const fs = require('fs').promises;
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  logAxiosError,
  refreshS3FileUrls,
  detectEncryptedFileAtPath,
  resolveUploadErrorMessage,
  verifyAgentUploadPermission,
} = require('@librechat/api');
// [knauf] KK20-232 — bounded, process-isolated PDF access classification for File Search.
const {
  isPdfFileAtPath,
  probePdfAccess,
  PDF_PROBE_UNAVAILABLE_CODE,
} = require('@knauf/knauf/server/pdfAccessProbe');
// End [knauf]
const {
  isUUID,
  CacheKeys,
  FileSources,
  ResourceType,
  EModelEndpoint,
  PermissionBits,
  checkOpenAIStorage,
  isAssistantsEndpoint,
  // [knauf] KK20-232 — scope PDF probing to File Search uploads only.
  EToolResources,
  // End [knauf]
} = require('librechat-data-provider');
const {
  filterFile,
  processFileUpload,
  processDeleteRequest,
  processAgentFileUpload,
} = require('~/server/services/Files/process');
const { fileAccess } = require('~/server/middleware/accessResources/fileAccess');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getOpenAIClient } = require('~/server/controllers/assistants/helpers');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission } = require('~/server/services/PermissionService');
// [knauf] KK20-167 — SAS-signed Azure Blob refresh chain and the shared
// half-TTL refresh-cache helper. Pairs with fileUrlRefreshBySource below.
const { refreshAzureFileUrls } = require('~/server/services/Files/Azure/crud');
const { getFileURLRefreshCacheTime } = require('~/server/utils/getFileStrategy');
// End [knauf]
const { hasAccessToFilesViaAgent } = require('~/server/services/Files');
// [knauf] KK20-204 — dedup-aware direct file delete: removing a file that owns a
// content-hash-deduped blob/embedding set must GC the shared asset only when its
// (user, hash) group is empty, mirroring the chat-delete cascade. Lazy require of
// process.js stays inside the module, so this top-level import is load-cycle-safe.
const {
  deleteFilesWithDedupAwareness,
} = require('~/server/services/Files/knauf/cascadeDeleteConvoFiles');
// End [knauf]
// [knauf] KK20-195 WP3a — client-file_id adoption + replay/conflict decisions.
const {
  isValidClientFileId,
  classifyUploadReplay,
} = require('~/server/services/Files/knauf/uploadIdempotency');
// End [knauf]
// [knauf] KK20-195 WP3c — async-indexing status projections (per-file, batch,
// list attachment) and the failed→queued retry decision.
const {
  projectFileIndexing,
  attachIndexingCore,
  attachIndexingToFiles,
  buildBatchIndexStatus,
  retryFileIndexing,
} = require('~/server/services/Files/knauf/indexStatus');
// KK20-195 review R6 — ownership/agent-EDIT gate for the mutating retry.
const { knaufFileIndexRetryAuth } = require('~/server/middleware/knaufFileIndexRetryAuth');
// End [knauf]
const { cleanFileName, getContentDisposition } = require('~/server/utils/files');
const { getLogStores } = require('~/cache');
const { Readable } = require('stream');
const db = require('~/models');

const router = express.Router();

/**
 * Dispatch table for refreshing signed file URLs by storage source.
 * Adding a new provider only requires another entry here.
 */
const fileUrlRefreshBySource = {
  [FileSources.s3]: {
    cacheKey: CacheKeys.S3_EXPIRY_INTERVAL,
    refreshFiles: refreshS3FileUrls,
  },
  [FileSources.azure_blob]: {
    cacheKey: CacheKeys.AZURE_EXPIRY_INTERVAL,
    refreshFiles: refreshAzureFileUrls,
  },
};

router.get('/', async (req, res) => {
  try {
    const appConfig = req.config;
    const files = await db.getFiles({ user: req.user.id });
    const refresher = fileUrlRefreshBySource[appConfig.fileStrategy];
    if (refresher) {
      try {
        const cache = getLogStores(refresher.cacheKey);
        const alreadyChecked = await cache.get(req.user.id);
        if (!alreadyChecked) {
          await refresher.refreshFiles(files, db.batchUpdateFiles);
          const cacheTime = getFileURLRefreshCacheTime(appConfig.fileStrategy);
          await cache.set(req.user.id, true, cacheTime);
        }
      } catch (error) {
        logger.warn(
          '[/files] Error refreshing file URLs for strategy:',
          appConfig.fileStrategy,
          error,
        );
      }
    }
    // [knauf] KK20-195 WP3c — one batched asset load projects `indexing` onto
    // every row that carries an asset pointer (plan §6.3: no per-row polling).
    res.status(200).send(await attachIndexingToFiles({ db, files }));
    // End [knauf]
  } catch (error) {
    logger.error('[/files] Error getting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

/**
 * Get files specific to an agent
 * @route GET /files/agent/:agent_id
 * @param {string} agent_id - The agent ID to get files for
 * @returns {Promise<TFile[]>} Array of files attached to the agent
 */
router.get('/agent/:agent_id', async (req, res) => {
  try {
    const { agent_id } = req.params;
    const userId = req.user.id;

    if (!agent_id) {
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    const agent = await db.getAgent({ id: agent_id });
    if (!agent) {
      return res.status(200).json([]);
    }

    if (agent.author.toString() !== userId) {
      const hasEditPermission = await checkPermission({
        userId,
        role: req.user.role,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.EDIT,
      });

      if (!hasEditPermission) {
        return res.status(200).json([]);
      }
    }

    const agentFileIds = [];
    if (agent.tool_resources) {
      for (const [, resource] of Object.entries(agent.tool_resources)) {
        if (resource?.file_ids && Array.isArray(resource.file_ids)) {
          agentFileIds.push(...resource.file_ids);
        }
      }
    }

    if (agentFileIds.length === 0) {
      return res.status(200).json([]);
    }

    const files = await db.getFiles({ file_id: { $in: agentFileIds }, user: agent.author }, null, {
      text: 0,
    });

    // [knauf] KK20-195 WP3c — same batched `indexing` projection as GET /files
    // so agent knowledge lists render pending/failed states without polling
    // per row (plan §6.3/§6.5: failed knowledge stays visible after reload).
    res.status(200).json(await attachIndexingToFiles({ db, files }));
    // End [knauf]
  } catch (error) {
    logger.error('[/files/agent/:agent_id] Error fetching agent files:', error);
    res.status(500).json({ error: 'Failed to fetch agent files' });
  }
});

// [knauf] KK20-195 WP3c — async-indexing read/retry surface (plan §6.3/§6.4).
/**
 * Aggregate indexing status for one client upload batch (multi-file UX).
 * The batch id is a client-generated grouping key, NEVER authorization —
 * the query is hard-scoped to the authenticated owner, so foreign batch ids
 * simply return an empty batch.
 *
 * @route GET /files/index-status?batch_id=<id>
 */
router.get('/index-status', async (req, res) => {
  try {
    const batchId = req.query.batch_id;
    if (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > 64) {
      return res.status(400).json({ error: 'batch_id_required' });
    }
    const summary = await buildBatchIndexStatus({ db, userId: req.user.id, batchId });
    return res.status(200).json(summary);
  } catch (error) {
    logger.error('[/files/index-status] Error building batch status:', error);
    return res.status(500).json({ error: 'Failed to fetch batch indexing status' });
  }
});

/**
 * Indexing status for one logical file. `fileAccess` gives the same ACL as
 * download/preview; the projection is derived from the physical asset when
 * one exists, else from the legacy `embedded` flag.
 *
 * @route GET /files/:file_id/index-status
 */
router.get('/:file_id/index-status', fileAccess, async (req, res) => {
  try {
    const file = req.fileAccess.file;
    const asset = file.knauf_asset_id ? await db.getAssetByAssetId(file.knauf_asset_id) : null;
    return res
      .status(200)
      .json({ file_id: file.file_id, indexing: projectFileIndexing(file, asset) });
  } catch (error) {
    logger.error('[/files/:file_id/index-status] Error fetching indexing status:', error);
    return res.status(500).json({ error: 'Failed to fetch indexing status' });
  }
});

/**
 * Authorized retry of a failed indexing run: CASes only failed → queued on
 * the physical asset (idempotent when another reference already retried);
 * assets without durable blob metadata answer `file_reupload_required`.
 *
 * KK20-195 review R6 — retry MUTATES a shared asset (requeue + OCR/embedding
 * capacity), so VIEW-level `fileAccess` alone is not enough: ownership or
 * agent EDIT is enforced by `knaufFileIndexRetryAuth` on top of it.
 *
 * @route POST /files/:file_id/index/retry
 */
router.post('/:file_id/index/retry', fileAccess, knaufFileIndexRetryAuth, async (req, res) => {
  try {
    const { httpStatus, body } = await retryFileIndexing({ db, file: req.fileAccess.file });
    return res.status(httpStatus).json(body);
  } catch (error) {
    logger.error('[/files/:file_id/index/retry] Error retrying indexing:', error);
    return res.status(500).json({ error: 'Failed to retry indexing' });
  }
});
// End [knauf]

router.get('/config', async (req, res) => {
  try {
    const appConfig = req.config;
    res.status(200).json(appConfig.fileConfig);
  } catch (error) {
    logger.error('[/files] Error getting fileConfig', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    const { files: _files } = req.body;

    /** @type {MongoFile[]} */
    const files = _files.filter((file) => {
      if (!file.file_id) {
        return false;
      }
      if (!file.filepath) {
        return false;
      }

      if (/^(file|assistant)-/.test(file.file_id)) {
        return true;
      }

      return isUUID.safeParse(file.file_id).success;
    });

    if (files.length === 0) {
      res.status(204).json({ message: 'Nothing provided to delete' });
      return;
    }

    const fileIds = files.map((file) => file.file_id);
    const dbFiles = await db.getFiles({ file_id: { $in: fileIds } });

    const ownedFiles = [];
    const nonOwnedFiles = [];

    for (const file of dbFiles) {
      if (file.user.toString() === req.user.id.toString()) {
        ownedFiles.push(file);
      } else {
        nonOwnedFiles.push(file);
      }
    }

    if (dbFiles.length > 0 && nonOwnedFiles.length === 0) {
      // [knauf] KK20-204 — route through the dedup-aware delete so a deduped
      // pointer's removal GCs the shared blob/vectors only when its content-hash
      // group is empty. `ownedFiles` are full DB docs (from db.getFiles above).
      await deleteFilesWithDedupAwareness({ req, files: ownedFiles });
      await Promise.all(
        ownedFiles.map((file) => db.deleteChatProjectSourcesByFileId(req.user.id, file.file_id)),
      );
      // End [knauf]

      logger.debug(
        `[/files] Files deleted successfully: ${ownedFiles
          .filter((f) => f.file_id)
          .map((f) => f.file_id)
          .join(', ')}`,
      );
      res.status(200).json({ message: 'Files deleted successfully' });
      return;
    }

    let authorizedFiles = [...ownedFiles];
    let unauthorizedFiles = [];

    if (req.body.agent_id && nonOwnedFiles.length > 0) {
      const nonOwnedFileIds = nonOwnedFiles.map((f) => f.file_id);
      const accessMap = await hasAccessToFilesViaAgent({
        userId: req.user.id,
        role: req.user.role,
        fileIds: nonOwnedFileIds,
        agentId: req.body.agent_id,
        isDelete: true,
        files: nonOwnedFiles,
      });

      for (const file of nonOwnedFiles) {
        if (accessMap.get(file.file_id)) {
          authorizedFiles.push(file);
        } else {
          unauthorizedFiles.push(file);
        }
      }
    } else {
      unauthorizedFiles = nonOwnedFiles;
    }

    if (unauthorizedFiles.length > 0) {
      return res.status(403).json({
        message: 'You can only delete files you have access to',
        unauthorizedFiles: unauthorizedFiles.map((f) => f.file_id),
      });
    }

    /* Handle agent unlinking even if no valid files to delete */
    if (req.body.agent_id && req.body.tool_resource && dbFiles.length === 0) {
      const agent = await db.getAgent({
        id: req.body.agent_id,
      });

      const toolResourceFiles = agent.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const agentFiles = files
        .filter((f) => toolResourceFiles.includes(f.file_id))
        .map((file) => ({ tool_resource: req.body.tool_resource, file_id: file.file_id }));
      const hasAgentEditAccess =
        agent.author?.toString() === req.user.id.toString() ||
        (await checkPermission({
          userId: req.user.id,
          role: req.user.role,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          requiredPermission: PermissionBits.EDIT,
        }));
      const unauthorizedFiles = hasAgentEditAccess ? [] : agentFiles;
      if (unauthorizedFiles.length > 0) {
        return res.status(403).json({
          message: 'You can only delete files you have access to',
          unauthorizedFiles: unauthorizedFiles.map((file) => file.file_id),
        });
      }

      await db.removeAgentResourceFiles({
        agent_id: req.body.agent_id,
        files: agentFiles,
      });
      res.status(200).json({ message: 'File associations removed successfully from agent' });
      return;
    }

    /* Handle assistant unlinking even if no valid files to delete */
    if (req.body.assistant_id && req.body.tool_resource && dbFiles.length === 0) {
      const assistant = await db.getAssistant({
        id: req.body.assistant_id,
      });

      const toolResourceFiles = assistant.tool_resources?.[req.body.tool_resource]?.file_ids ?? [];
      const assistantFiles = files.filter((f) => toolResourceFiles.includes(f.file_id));

      await processDeleteRequest({ req, files: assistantFiles });
      res.status(200).json({ message: 'File associations removed successfully from assistant' });
      return;
    } else if (
      req.body.assistant_id &&
      req.body.files?.[0]?.filepath === EModelEndpoint.azureAssistants
    ) {
      await processDeleteRequest({ req, files: req.body.files });
      return res
        .status(200)
        .json({ message: 'File associations removed successfully from Azure Assistant' });
    }

    // [knauf] KK20-204 — dedup-aware delete for the owned + agent-authorized set
    // (full DB docs); deduped pointers GC the shared asset only when their group
    // is empty. Branches above (agent/assistant unlink with dbFiles.length === 0)
    // stay on processDeleteRequest: they operate on client BatchFiles with no DB
    // row and need the per-agent/assistant unlink scope this dispatcher lacks.
    await deleteFilesWithDedupAwareness({ req, files: authorizedFiles });
    await Promise.all(
      authorizedFiles.map((file) => db.deleteChatProjectSourcesByFileId(req.user.id, file.file_id)),
    );
    // End [knauf]

    logger.debug(
      `[/files] Files deleted successfully: ${authorizedFiles
        .filter((f) => f.file_id)
        .map((f) => f.file_id)
        .join(', ')}`,
    );
    res.status(200).json({ message: 'Files deleted successfully' });
  } catch (error) {
    logger.error('[/files] Error deleting files:', error);
    res.status(400).json({ message: 'Error in request', error: error.message });
  }
});

function isValidID(str) {
  return /^[A-Za-z0-9_-]{21}$/.test(str);
}

router.get('/code/download/:session_id/:fileId', async (req, res) => {
  try {
    const { session_id, fileId } = req.params;
    const logPrefix = `Session ID: ${session_id} | File ID: ${fileId} | Code output download requested by user `;
    logger.debug(logPrefix);

    if (!session_id || !fileId) {
      return res.status(400).send('Bad request');
    }

    if (!isValidID(session_id) || !isValidID(fileId)) {
      logger.debug(`${logPrefix} invalid session_id or fileId`);
      return res.status(400).send('Bad request');
    }

    const { getDownloadStream } = getStrategyFunctions(FileSources.execute_code);
    if (!getDownloadStream) {
      logger.warn(
        `${logPrefix} has no stream method implemented for ${FileSources.execute_code} source`,
      );
      return res.status(501).send('Not Implemented');
    }

    /* Code-output downloads are always user-private — `processCodeOutput`
     * persists every code-execution artifact under
     * `metadata.codeEnvRef.kind === 'user'` regardless of which skill
     * the run invoked. Pass `kind: 'user'` + `id: <userId>` so codeapi's
     * `sessionAuth` resolves the matching `<tenant>:user:<userId>`
     * sessionKey; without these query params it 400s with
     * "kind must be one of: skill, agent, user". */
    /** @type {AxiosResponse<ReadableStream> | undefined} */
    const response = await getDownloadStream(
      `${session_id}/${fileId}`,
      {
        kind: 'user',
        id: req.user.id,
      },
      req,
    );
    res.set(response.headers);
    response.data.pipe(res);
  } catch (error) {
    /* `logAxiosError` redacts buffer/stream response bodies — without
     * it, a stream-typed axios failure dumps the entire `Readable`'s
     * internal state (megabytes of socket + readableState) into the
     * log line. Plain `logger.error(error)` would do that here. */
    logAxiosError({ message: 'Error downloading code-output file', error });
    res.status(500).send('Error downloading file');
  }
});

/* Lazy-sweep cutoff: pending records older than this are marked failed
 * on the next poll. 2min is well past the 60s render ceiling, so any
 * `pending` past it is definitively orphaned. Tighter than the boot
 * sweep (5min) since this runs per-request, not per-instance. */
const PREVIEW_LAZY_SWEEP_CUTOFF_MS = 2 * 60 * 1000;

/**
 * Poll the lifecycle status of a code-execution file's inline preview.
 *
 * Deferred-preview flow: the immediate persist step writes the file
 * record at `status: 'pending'`; the background render transitions
 * it to `'ready'` (with `text` + `textFormat`) or `'failed'` (with
 * `previewError`). The frontend's `useFilePreview` React Query hook
 * polls this endpoint at ~2.5s intervals while `status === 'pending'`,
 * then auto-stops on terminal status.
 *
 * Returns the smallest viable shape:
 *   - `status` always present (defaults to `'ready'` for legacy records
 *     that never had the field — clients treat absent as ready).
 *   - `text` and `textFormat` only when status is 'ready' AND text
 *     is non-null (preserves the security contract from PR #12934 —
 *     office bucket files MUST NOT receive plain-text fallbacks).
 *   - `previewError` only when status is 'failed'.
 *
 * Lazy-sweeps stale `pending` records on the spot — see
 * `PREVIEW_LAZY_SWEEP_CUTOFF_MS` for the rationale.
 *
 * Reuses the `fileAccess` middleware so ACL is identical to download.
 *
 * @route GET /files/:file_id/preview
 */
router.get('/:file_id/preview', fileAccess, async (req, res) => {
  try {
    const { file_id } = req.params;
    /* `fileAccess` already fetched the record (sans `text`, the default
     * projection drops it). Reuse for the lifecycle check; only re-fetch
     * with `text` on a terminal ready response — the typical lifecycle
     * is N pending polls + 1 ready, so this avoids ~N redundant text
     * reads per file. */
    let file = req.fileAccess.file;
    /* Lazy sweep: if stuck `pending` past the cutoff, mark `failed`
     * conditional on the observed `updatedAt` (concurrent legitimate
     * updates win). */
    if (file.status === 'pending' && file.updatedAt instanceof Date) {
      const ageMs = Date.now() - file.updatedAt.getTime();
      if (ageMs > PREVIEW_LAZY_SWEEP_CUTOFF_MS) {
        const swept = await db.updateFile(
          { file_id, status: 'failed', previewError: 'orphaned' },
          { status: 'pending', updatedAt: file.updatedAt },
        );
        if (swept) {
          file = swept;
          logger.info(
            `[/files/:file_id/preview] Lazy-swept orphaned pending record ${file_id} (age ${Math.round(ageMs / 1000)}s)`,
          );
        }
      }
    }
    /* Default to 'ready' for back-compat: legacy records pre-date the
     * field, and non-office files never get a status set on persist. */
    const status = file.status ?? 'ready';
    const payload = { file_id, status };
    if (status === 'ready') {
      const withText = await db.findFileById(file_id);
      if (withText?.text != null) {
        payload.text = withText.text;
        payload.textFormat = withText.textFormat ?? null;
      }
    } else if (status === 'failed' && file.previewError) {
      payload.previewError = file.previewError;
    }
    return res.status(200).json(payload);
  } catch (error) {
    logger.error('[/files/:file_id/preview] Error fetching preview status:', error);
    return res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'Failed to fetch preview status' });
  }
});

/**
 * Returns a strategy-managed signed URL for an already-authorized file record.
 */
const getDirectDownloadURL = async ({
  req,
  file,
  customFilename = cleanFileName(file.filename),
}) => {
  const { getDownloadURL } = getStrategyFunctions(file.source);
  if (!getDownloadURL) {
    return null;
  }

  return getDownloadURL({
    req,
    file,
    customFilename,
    contentType: file.type || 'application/octet-stream',
  });
};

// Security allowlist: excludes internal ids, owner/tenant identifiers, and extracted text.
// `filepath` stays included because cached TFile records need it for previews/deletes.
const DOWNLOAD_METADATA_FIELDS = [
  'conversationId',
  'message',
  'file_id',
  'temp_file_id',
  'bytes',
  'model',
  'embedded',
  'filename',
  'filepath',
  'storageKey',
  'storageRegion',
  'object',
  'type',
  'usage',
  'context',
  'source',
  'filterSource',
  'width',
  'height',
  'expiresAt',
  'preview',
  'textFormat',
  'status',
  'previewError',
  'createdAt',
  'updatedAt',
];

const getDownloadFileMetadata = (file) => {
  const rawFile = typeof file.toObject === 'function' ? file.toObject() : file;
  return DOWNLOAD_METADATA_FIELDS.reduce((metadata, field) => {
    if (rawFile[field] !== undefined) {
      metadata[field] = rawFile[field];
    }
    return metadata;
  }, {});
};

router.get('/download-url/:userId/:file_id', fileAccess, async (req, res) => {
  try {
    const { userId, file_id } = req.params;
    logger.debug(`File download URL requested by user ${userId}: ${file_id}`);

    const file = req.fileAccess.file;
    if (checkOpenAIStorage(file.source) && !file.model) {
      logger.warn(
        `File download URL requested by user ${userId} has no associated model: ${file_id}`,
      );
      return res.status(400).send('The model used when creating this file is not available');
    }

    const filename = cleanFileName(file.filename);
    const downloadURL = checkOpenAIStorage(file.source)
      ? null
      : await getDirectDownloadURL({ req, file, customFilename: filename });

    if (!downloadURL) {
      logger.debug(
        `File download URL requested by user ${userId} is not supported for source: ${file.source}`,
      );
      return res.status(501).send('Not Implemented');
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      url: downloadURL,
      filename,
      type: file.type || 'application/octet-stream',
      metadata: getDownloadFileMetadata(file),
    });
  } catch (error) {
    logger.error('[DOWNLOAD URL ROUTE] Error generating file download URL:', error);
    res.status(500).send('Error generating file download URL');
  }
});

router.get('/download/:userId/:file_id', fileAccess, async (req, res) => {
  try {
    const { userId, file_id } = req.params;
    logger.debug(`File download requested by user ${userId}: ${file_id}`);

    // Access already validated by fileAccess middleware
    const file = req.fileAccess.file;

    if (checkOpenAIStorage(file.source) && !file.model) {
      logger.warn(`File download requested by user ${userId} has no associated model: ${file_id}`);
      return res.status(400).send('The model used when creating this file is not available');
    }

    const { getDownloadStream, getDownloadURL } = getStrategyFunctions(file.source);
    if (!getDownloadStream && !getDownloadURL) {
      logger.warn(
        `File download requested by user ${userId} has no download method implemented: ${file.source}`,
      );
      return res.status(501).send('Not Implemented');
    }

    const setHeaders = () => {
      res.setHeader('Content-Disposition', getContentDisposition(file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'X-File-Metadata',
        encodeURIComponent(JSON.stringify(getDownloadFileMetadata(file))),
      );
    };

    if (checkOpenAIStorage(file.source)) {
      req.body = { model: file.model };
      const endpointMap = {
        [FileSources.openai]: EModelEndpoint.assistants,
        [FileSources.azure]: EModelEndpoint.azureAssistants,
      };
      const { openai } = await getOpenAIClient({
        req,
        res,
        overrideEndpoint: endpointMap[file.source],
      });
      logger.debug(`Downloading file ${file_id} from OpenAI`);
      const passThrough = await getDownloadStream(file_id, openai);
      setHeaders();
      logger.debug(`File ${file_id} downloaded from OpenAI`);

      // Handle both Node.js and Web streams
      const stream =
        passThrough.body && typeof passThrough.body.getReader === 'function'
          ? Readable.fromWeb(passThrough.body)
          : passThrough.body;

      stream.pipe(res);
    } else {
      if (getDownloadURL && req.query.direct === 'true') {
        try {
          const downloadURL = await getDirectDownloadURL({ req, file });
          if (downloadURL) {
            res.setHeader('Cache-Control', 'no-store');
            return res.redirect(302, downloadURL);
          }
        } catch (error) {
          logger.warn(
            '[DOWNLOAD ROUTE] Falling back to stream after URL generation failed:',
            error,
          );
        }
      }

      if (!getDownloadStream) {
        logger.warn(
          `File download requested by user ${userId} has no stream method implemented: ${file.source}`,
        );
        return res.status(501).send('Not Implemented');
      }

      const fileStream = await getDownloadStream(req, file.storageKey || file.filepath);

      fileStream.on('error', (streamError) => {
        logger.error('[DOWNLOAD ROUTE] Stream error:', streamError);
      });

      setHeaders();
      fileStream.pipe(res);
    }
  } catch (error) {
    logger.error('[DOWNLOAD ROUTE] Error downloading file:', error);
    res.status(500).send('Error downloading file');
  }
});

router.post('/', async (req, res) => {
  const metadata = req.body;
  let cleanup = true;

  try {
    filterFile({ req });

    // [knauf] Reject encrypted OOXML containers globally (KK20-190, narrowed by
    // KK20-232). PDF access is classified separately below because an /Encrypt
    // dictionary can still be readable without credentials.
    if (req.file?.path) {
      let encryptionCheck = { encrypted: false };
      try {
        encryptionCheck = await detectEncryptedFileAtPath(req.file.path, req.file.mimetype);
      } catch (encryptionReadError) {
        // Best-effort guard: if the bytes can't be read (e.g. transient fs error),
        // don't hard-fail the upload — log and let downstream processing handle it.
        // The intentional encrypted-file rejection is thrown OUTSIDE this catch so
        // it still propagates to the route handler. KK20-190.
        logger.warn(
          `[/files] encrypted-file check skipped (file unreadable): ${encryptionReadError.message}`,
        );
      }
      if (encryptionCheck.encrypted) {
        throw new Error(encryptionCheck.error);
      }
    }
    // End [knauf]

    // [knauf] KK20-232 — authorize before the CPU-bound PDF classification.
    if (!isAssistantsEndpoint(metadata.endpoint)) {
      let skipUploadAuth = false;
      try {
        skipUploadAuth = await hasCapability(req.user, SystemCapabilities.MANAGE_AGENTS);
      } catch (err) {
        logger.warn(`[/files] capability check failed, denying bypass: ${err.message}`);
      }

      if (!skipUploadAuth) {
        const denied = await verifyAgentUploadPermission({
          req,
          res,
          metadata,
          getAgent: db.getAgent,
          checkPermission,
        });
        if (denied) {
          return;
        }
      }
    }
    // End [knauf]

    // [knauf] KK20-232 — classify PDF access only for non-Assistants File Search.
    // The worker is terminated at a fixed deadline; only a confirmed PDF.js
    // PasswordException becomes password_required. Parser/content failures are
    // invalid input, while worker/read/init/timeout failures remain retryable 503s.
    if (
      req.file?.path &&
      !isAssistantsEndpoint(metadata.endpoint) &&
      metadata.tool_resource === EToolResources.file_search
    ) {
      const isPdf =
        req.file.mimetype === 'application/pdf' || (await isPdfFileAtPath(req.file.path));
      if (isPdf) {
        const access = await probePdfAccess(req.file.path);
        if (access.result !== 'readable') {
          const code =
            access.result === 'password_required'
              ? 'com_knauf_error_pdf_password_required'
              : 'com_knauf_error_pdf_invalid';
          const pdfError = new Error(code);
          pdfError.code = code;
          throw pdfError;
        }
      }
    }
    // End [knauf]

    // [knauf] KK20-195 WP3a — upload idempotency (plan §6.1 steps 3+5).
    // Adopt the CLIENT-generated file_id as THE logical id when it is a valid
    // UUID; multer's server-minted req.file_id stays as the fallback (body
    // fields aren't reliably parsed inside multer's filename callback, so
    // adoption happens here, not there). temp_file_id keeps carrying the
    // client id either way — the client reconciles its row by temp_file_id.
    const knaufClientFileId = metadata.file_id;
    const knaufAdopted = isValidClientFileId(knaufClientFileId);
    metadata.temp_file_id = knaufClientFileId ?? req.file_id;
    metadata.file_id = knaufAdopted ? knaufClientFileId : req.file_id;

    if (knaufAdopted && !isAssistantsEndpoint(metadata.endpoint)) {
      // §6.1 step 5 — an exact retry with the same (owner, file_id) returns
      // the original row; the same id with different content or a different
      // owner is a hard 409. Unscoped lookup on purpose: the cross-user case
      // must be detected, not silently duplicated.
      const [existing] = await db.getFiles({ file_id: metadata.file_id }, null, { text: 0 });
      // KK20-195 review R3 — when the stored row carries a content hash,
      // compare hashes, not just byte length (same-size different content
      // must conflict, never replay). Hashing only happens on the rare
      // same-id path, and only when the row has a hash to compare against.
      let knaufIncomingHash;
      if (existing?.knauf_content_hash != null && req.file?.path != null) {
        const { computeContentHash } = require('~/server/services/Files/knauf/contentDedup');
        knaufIncomingHash = await computeContentHash(req.file.path).catch(() => undefined);
      }
      const verdict = classifyUploadReplay({
        existing,
        userId: req.user.id,
        incomingBytes: req.file?.size,
        incomingHash: knaufIncomingHash,
      });
      if (verdict.outcome === 'replay') {
        logger.info(`[/files] idempotent replay for file_id ${metadata.file_id}`);
        // KK20-195 review R3/F4 — carry the `indexing` projection (and batch id)
        // so a replayed async-accepted upload isn't mistaken for ready by the
        // client, which would open the send gate and then 409 on send.
        // F4 (re-review): use the STRICT projection (attachIndexingCore). If the
        // asset load throws, readiness is UNKNOWN — return 503 rather than a
        // resilient plain row the client would read as "ready" (false readiness).
        let projected;
        try {
          [projected] = await attachIndexingCore({ db, files: [existing] });
        } catch (indexingError) {
          logger.warn(
            `[/files] replay readiness unestablishable for ${metadata.file_id}: ${indexingError?.message}`,
          );
          return res.status(503).json({
            error: 'indexing_status_unavailable',
            file_id: metadata.file_id,
          });
        }
        // R3 — same status semantics as the fresh path: pending work replays
        // as 202, never a 200 the client could read as "ready".
        const knaufReplayPending = projected?.indexing != null && !projected.indexing.ready;
        let recoverStaleSyncReplay = false;
        let recoverIncompleteFinalization = false;
        if (existing.knauf_asset_id) {
          let asset;
          try {
            asset = await db.getAssetByAssetId(existing.knauf_asset_id);
          } catch (indexingError) {
            logger.warn(
              `[/files] replay asset reload failed for ${metadata.file_id}: ${indexingError?.message}`,
            );
            return res.status(503).json({
              error: 'indexing_status_unavailable',
              file_id: metadata.file_id,
            });
          }
          const {
            shouldRecoverStaleSyncReplay,
            shouldRecoverIncompleteFinalization,
          } = require('~/server/services/Files/knauf/fileSearchAssetLifecycle');
          recoverIncompleteFinalization = shouldRecoverIncompleteFinalization({
            asset,
            file: existing,
          });
          if (knaufReplayPending) {
            const {
              isAsyncAcceptedForUser,
              isIndexingWorkerEnabled,
            } = require('~/server/services/Files/knauf/asyncIndexingConfig');
            recoverStaleSyncReplay = shouldRecoverStaleSyncReplay({
              asset,
              asyncAccepted: isAsyncAcceptedForUser(req.user),
              workerEnabled: isIndexingWorkerEnabled(),
            });
          }
        }
        if (!recoverStaleSyncReplay && !recoverIncompleteFinalization) {
          return res.status(knaufReplayPending ? 202 : 200).json({
            message: knaufReplayPending
              ? 'File accepted; indexing in progress'
              : 'File already processed',
            ...(projected ?? existing),
            ...(existing.knauf_upload_batch_id ? { batch_id: existing.knauf_upload_batch_id } : {}),
          });
        }
        if (recoverStaleSyncReplay || recoverIncompleteFinalization) {
          // Server-only handoff. Agent-library uploads have no content dedup
          // key, so processAgentFileUpload must reuse this exact physical asset
          // for stale execution recovery or final metadata repair.
          req.knaufRecoverAssetId = existing.knauf_asset_id;
        }
        logger.warn(`[/files] replay ${metadata.file_id} will re-enter lifecycle recovery`);
      }
      if (verdict.outcome === 'conflict') {
        return res.status(409).json({
          error: 'upload_idempotency_conflict',
          reason: verdict.reason,
          file_id: metadata.file_id,
        });
      }
      if (verdict.outcome === 'indeterminate') {
        // KK20-195 review F4 (re-review) — the stored row is hash-identified but
        // the incoming bytes could not be hashed, so replay-vs-different-content
        // is UNVERIFIABLE. Fail closed with a retryable 503 — never a byte-length
        // guess that could replay a same-size different file onto the original.
        logger.warn(
          `[/files] upload replay indeterminate for ${metadata.file_id}: ${verdict.reason}`,
        );
        return res.status(503).json({
          error: 'upload_idempotency_indeterminate',
          reason: verdict.reason,
          file_id: metadata.file_id,
        });
      }
    }
    // End [knauf]

    if (isAssistantsEndpoint(metadata.endpoint)) {
      return await processFileUpload({ req, res, metadata });
    }

    return await processAgentFileUpload({ req, res, metadata });
  } catch (error) {
    const resolvedMessage = resolveUploadErrorMessage(error);
    // [knauf] KK20-232 — stable PDF validation/infrastructure outcomes. Expected
    // input rejection stays out of 5xx metrics; probe infrastructure failures
    // remain 503 so the existing bounded upload retry path can recover.
    const isProbeUnavailable =
      resolvedMessage === PDF_PROBE_UNAVAILABLE_CODE || error?.code === PDF_PROBE_UNAVAILABLE_CODE;
    const message = isProbeUnavailable ? PDF_PROBE_UNAVAILABLE_CODE : resolvedMessage;
    const inputRejectionCodes = new Set([
      'com_knauf_error_file_encrypted',
      'com_knauf_error_pdf_password_required',
      'com_knauf_error_pdf_invalid',
    ]);
    const isInputRejection = inputRejectionCodes.has(message);
    const logMetadata = {
      operation: 'file_upload',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorCode: error?.code ?? error?.knaufCode,
      status: error?.response?.status ?? error?.status,
      cause: error?.message,
      keyPattern: error?.keyPattern ? JSON.stringify(error.keyPattern) : undefined,
      keyValue: error?.keyValue ? JSON.stringify(error.keyValue) : undefined,
      ...((isInputRejection || isProbeUnavailable) && { code: message }),
    };
    const failureDetail = `type=${logMetadata.errorType ?? 'unknown'} code=${logMetadata.errorCode ?? 'none'} status=${logMetadata.status ?? 'none'} keyPattern=${logMetadata.keyPattern ?? 'none'} keyValue=${logMetadata.keyValue ?? 'none'} cause=${logMetadata.cause ?? 'none'}`;
    logger[isInputRejection ? 'info' : 'error'](
      isInputRejection
        ? `[/files] Rejected invalid file input ${failureDetail}`
        : `[/files] File processing failed ${failureDetail}`,
      logMetadata,
    );

    try {
      await fs.unlink(req.file.path);
      cleanup = false;
    } catch (_error) {
      logger.error('[/files] Upload cleanup failed', { operation: 'file_upload_cleanup' });
    }
    let status = 500;
    if (isInputRejection) {
      status = 422;
    } else if (isProbeUnavailable) {
      status = 503;
    }
    res.status(status).json({
      message,
      ...((isInputRejection || isProbeUnavailable) && { code: message }),
    });
  } finally {
    if (cleanup) {
      try {
        await fs.unlink(req.file.path);
      } catch (_error) {
        logger.error('[/files] Upload cleanup failed', { operation: 'file_upload_cleanup' });
      }
    } else {
      logger.debug('[/files] File processing completed without cleanup');
    }
    // End [knauf]
  }
});

module.exports = router;

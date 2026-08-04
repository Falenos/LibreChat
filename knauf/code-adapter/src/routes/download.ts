import { Router } from 'express';
import { isValidFileId, isValidSessionId, parseIdentity } from '../validate.js';
import { checkOwnership } from './objects.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FilesRepo } from '../store/filesRepo.js';
import type { Logger } from '../logger.js';

interface DownloadDeps {
  blob: BlobStore;
  repo: FilesRepo;
  logger: Logger;
}

/**
 * GET /download/:sessionId/:fileId?kind=&id=[&version=]
 * Streams the staged/captured blob. Serves both crud.js (stream) and
 * process.js (arraybuffer) consumers; both use a 15s client timeout.
 * Touches the TTL on success so actively-used files stay alive.
 */
export function createDownloadRouter(deps: DownloadDeps): Router {
  const router = Router();

  router.get('/download/:sessionId/:fileId', (req, res, next) => {
    void (async () => {
      const { sessionId, fileId } = req.params;
      if (!isValidSessionId(sessionId) || !isValidFileId(fileId)) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      parseIdentity(req.query as Record<string, unknown>);

      const auth = req.auth;
      if (auth == null) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const doc = await deps.repo.find(sessionId, fileId);
      if (doc == null || !checkOwnership(doc, auth)) {
        res
          .status(doc == null ? 404 : 403)
          .json({ error: doc == null ? 'not found' : 'forbidden' });
        return;
      }

      let download;
      try {
        download = await deps.blob.getStream(doc.blobPath);
      } catch (err) {
        deps.logger.warn({ blobPath: doc.blobPath, err: (err as Error).message }, 'blob missing');
        res.status(404).json({ error: 'not found' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', doc.contentType);
      if (download.contentLength != null) {
        res.setHeader('Content-Length', String(download.contentLength));
      }
      const basename = doc.filename.includes('/')
        ? doc.filename.slice(doc.filename.lastIndexOf('/') + 1)
        : doc.filename;
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
      );
      download.stream.pipe(res);
      void deps.repo.touch(sessionId, fileId);
    })().catch(next);
  });

  return router;
}

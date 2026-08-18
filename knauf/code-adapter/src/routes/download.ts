import { pipeline } from 'node:stream/promises';
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
 *
 * Both the transfer and the TTL bump are failure paths that must not reach the
 * process. `pipeline` rather than `stream.pipe` because `pipe` does not forward a
 * source error: a mid-download reset from Blob storage emits `error` on a readable
 * with no listener, which is an uncaught exception, and the adapter installs no
 * `uncaughtException` handler — so one storage blip would restart the pod. Same
 * reason the TTL bump is caught rather than left floating: an unhandled rejection
 * terminates the process on Node >= 15, and a metadata hiccup during a download must
 * not be able to do that.
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
      try {
        await pipeline(download.stream, res);
      } catch (err) {
        // Headers (and probably bytes) are already out, so there is no status left to
        // send. Log it and tear the socket down so the client sees a failed transfer
        // rather than a stalled one; the errorHandler's `headersSent` branch would only
        // call res.end(), which looks like a clean short read.
        deps.logger.warn(
          { blobPath: doc.blobPath, err: (err as Error).message },
          'download stream aborted',
        );
        res.destroy();
        return;
      }
      await deps.repo.touch(sessionId, fileId).catch((err: Error) => {
        // Best-effort TTL bump. The bytes are already delivered, so a failure here is
        // not the caller's problem — it only risks the file expiring earlier.
        deps.logger.warn({ sessionId, fileId, err: err.message }, 'download TTL bump failed');
      });
    })().catch(next);
  });

  return router;
}

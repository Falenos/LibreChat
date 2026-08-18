import { Router } from 'express';
import { isValidFileId, isValidSessionId, parseIdentity } from '../validate.js';
import type { RequestHandler } from 'express';
import type { AuthContext } from '../types/contract.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FileDoc, FilesRepo } from '../store/filesRepo.js';
import type { Logger } from '../logger.js';

interface ObjectsDeps {
  blob: BlobStore;
  repo: FilesRepo;
  logger: Logger;
}

/** Ownership mirror of codeapi sessionAuth: user-kind → same sub; agent/skill → same tenant. */
export function checkOwnership(doc: FileDoc, auth: AuthContext): boolean {
  if (doc.identity.kind === 'user') {
    return doc.userId === auth.userId;
  }
  return doc.tenantId === auth.tenantId;
}

/**
 * GET  /sessions/:sid/objects/:fid — freshness probe; process.js reads
 *      lastModified; any error is treated as cache-miss → re-upload
 *      (that is the designed TTL-recovery path, so a 404 here is normal).
 * DELETE /sessions/:sid/objects/:fid — primary delete.
 * DELETE /files/:sid/:fid            — crud.js fallback alias (same handler).
 * Pure Table/Blob operations — no ACA calls (5s/15s client timeouts).
 */
export function createObjectsRouter(deps: ObjectsDeps): Router {
  const router = Router();

  router.get('/sessions/:sessionId/objects/:fileId', (req, res, next) => {
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
      res.status(200).json({
        id: doc.fileId,
        name: doc.filename,
        session_id: doc.sessionId,
        size: doc.size,
        contentType: doc.contentType,
        lastModified: doc.lastModified.toISOString(),
      });
    })().catch(next);
  });

  const deleteHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const { sessionId, fileId } = req.params as { sessionId: string; fileId: string };
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
      if (doc == null) {
        // crud.js treats a terminal 404 as success — deletion is idempotent.
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!checkOwnership(doc, auth)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const committedBlobPath = await deps.repo.delete(sessionId, fileId);
      if (committedBlobPath != null) {
        await deps.blob.delete(committedBlobPath);
      }
      res.status(200).json({ message: 'success' });
    })().catch(next);
  };

  router.delete('/sessions/:sessionId/objects/:fileId', deleteHandler);
  router.delete('/files/:sessionId/:fileId', deleteHandler);

  return router;
}

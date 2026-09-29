import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Router } from 'express';
import multer from 'multer';
import { mintSessionId, parseIdentity, sanitizeFilename, ValidationError } from '../validate.js';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext, BatchUploadFileResult, CodeEnvIdentity } from '../types/contract.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FilesRepo } from '../store/filesRepo.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../middleware/metrics.js';
import type { Config } from '../config.js';

interface UploadDeps {
  config: Config;
  logger: Logger;
  blob: BlobStore;
  repo: FilesRepo;
  metrics: Metrics;
}

/**
 * POST /upload and /upload/batch. Files are staged to Blob + Table metadata only
 * — no ACA session exists yet (upload-before-exec); the push happens
 * lazily at first /exec referencing them.
 *
 * Multipart field name is `file` (crud.js form.ts contract); identity
 * fields kind/id/version ride alongside; batch adds read_only. The
 * legacy entity_id field is accepted and ignored.
 */
export function createUploadRouter(deps: UploadDeps): Router {
  const router = Router();
  const { batchMaxFiles, batchMaxTotalBytes, preservePaths } = deps.config.upload;
  const upload = multer({
    dest: process.env.UPLOAD_TMP_DIR ?? tmpdir(),
    // Busboy strips the directory part of a multipart filename unless told otherwise, so a
    // skill's `karl-xlsx/references/reading.md` arrived as `reading.md` and collided with
    // every other skill's file of that name. `sanitizeFilename` below still rejects
    // traversal, absolute paths and backslashes, which busboy keeps verbatim in this mode.
    preservePath: preservePaths,
    // `files` matters as much as `fileSize` here. /upload/batch takes an unbounded array,
    // and every item is spooled to the container's writable layer. Without a count cap, one
    // request can exhaust ephemeral storage (which has no request/limit in the GitOps values).
    // It is its own knob: tying it to CAPTURE_MAX_FILES made a skill with 20+ bundled files
    // fail to prime at all (413, and LibreChat then uploads nothing). The worst-case spool is
    // batchMaxFiles × uploadMaxBytes; the declared-length and spooled-total checks below
    // bound the realistic case to batchMaxTotalBytes.
    // Busboy raises LIMIT_FILE_SIZE when the configured byte count is reached, so the
    // parser limit must be one byte beyond the documented inclusive application limit.
    // Files larger than uploadMaxBytes still reach the sentinel and are rejected.
    limits: { fileSize: deps.config.uploadMaxBytes + 1, files: batchMaxFiles },
  });

  /** Refuse a batch whose declared body already exceeds the aggregate budget, unparsed. */
  const rejectDeclaredOversize = (req: Request, _res: Response, next: NextFunction) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > batchMaxTotalBytes) {
      next(new ValidationError('upload batch exceeds the maximum total size', 413));
      return;
    }
    next();
  };

  const stageOne = async (
    file: Express.Multer.File,
    identity: CodeEnvIdentity,
    auth: AuthContext,
    sessionId: string,
    readOnly: boolean,
  ) => {
    const filename = sanitizeFilename(file.originalname);
    const doc = await deps.repo.insertStaged({
      sessionId,
      filename,
      size: file.size,
      contentType: file.mimetype !== '' ? file.mimetype : 'application/octet-stream',
      origin: 'upload',
      readOnly,
      identity,
      userId: auth.userId,
      tenantId: auth.tenantId,
    });
    try {
      await deps.blob.put(doc.blobPath, createReadStream(file.path), doc.contentType, file.size);
    } catch (error) {
      let committedBlobPath: string | null = null;
      try {
        committedBlobPath = await deps.repo.delete(doc.sessionId, doc.fileId);
      } catch (cleanupError) {
        deps.logger.warn(
          { err: cleanupError, fileId: doc.fileId, cleanup: 'metadata' },
          'failed to roll back staged upload',
        );
      }
      await deps.blob.delete(committedBlobPath ?? doc.blobPath).catch((cleanupError) => {
        deps.logger.warn(
          { err: cleanupError, fileId: doc.fileId, cleanup: 'blob' },
          'failed to roll back staged upload',
        );
      });
      throw error;
    }
    deps.metrics.uploadBytes.inc(file.size);
    return doc;
  };

  const cleanup = async (files: Express.Multer.File[]) => {
    await Promise.all(
      files.map((f) =>
        unlink(f.path).catch(() => {
          /* tmp already gone */
        }),
      ),
    );
  };

  router.post('/upload', upload.single('file'), (req, res, next) => {
    void (async () => {
      const file = req.file;
      try {
        if (file == null) {
          res.status(400).json({ error: 'file is required' });
          return;
        }
        const identity = parseIdentity(req.body as Record<string, unknown>);
        const auth = req.auth;
        if (auth == null) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        const sessionId = mintSessionId(auth.userId, deps.config.sessionHintSecret);
        const doc = await stageOne(file, identity, auth, sessionId, false);
        res.status(200).json({
          message: 'success',
          storage_session_id: sessionId,
          files: [{ fileId: doc.fileId, filename: doc.filename }],
        });
      } finally {
        if (file != null) {
          await cleanup([file]);
        }
      }
    })().catch(next);
  });

  router.post('/upload/batch', rejectDeclaredOversize, upload.array('file'), (req, res, next) => {
    void (async () => {
      const files = (req.files ?? []) as Express.Multer.File[];
      try {
        if (files.length === 0) {
          res.status(400).json({ error: 'at least one file is required' });
          return;
        }
        // Chunked bodies (form-data streams have no known length) skip the header check,
        // so the spooled total is checked too, before anything reaches Blob or Table.
        if (files.reduce((sum, f) => sum + f.size, 0) > batchMaxTotalBytes) {
          throw new ValidationError('upload batch exceeds the maximum total size', 413);
        }
        const body = req.body as Record<string, unknown>;
        const identity = parseIdentity(body);
        const auth = req.auth;
        if (auth == null) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        const readOnly = body.read_only === 'true' || body.read_only === true;
        const sessionId = mintSessionId(auth.userId, deps.config.sessionHintSecret);

        const results: BatchUploadFileResult[] = [];
        for (const [itemIndex, file] of files.entries()) {
          try {
            const doc = await stageOne(file, identity, auth, sessionId, readOnly);
            results.push({ status: 'success', fileId: doc.fileId, filename: doc.filename });
          } catch (err) {
            deps.logger.warn(
              { itemIndex, err: (err as Error).message },
              'batch upload item failed',
            );
            results.push({
              status: 'error',
              filename: file.originalname,
              error: (err as Error).message,
            });
          }
        }
        const succeeded = results.filter((r) => r.status === 'success').length;
        const failed = results.length - succeeded;
        res.status(200).json({
          message: failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'error',
          storage_session_id: sessionId,
          files: results,
          succeeded,
          failed,
        });
      } finally {
        await cleanup(files);
      }
    })().catch(next);
  });

  return router;
}

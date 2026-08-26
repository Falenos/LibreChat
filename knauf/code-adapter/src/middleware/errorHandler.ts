import { AcaError } from '../types/aca.js';
import { ValidationError } from '../validate.js';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger.js';

interface MulterLikeError extends Error {
  code?: string;
}

function formatByteLimit(bytes: number): string {
  const mebibyte = 1024 * 1024;
  const kibibyte = 1024;
  if (bytes % mebibyte === 0) {
    return `${bytes / mebibyte} MiB`;
  }
  if (bytes % kibibyte === 0) {
    return `${bytes / kibibyte} KiB`;
  }
  return `${bytes} bytes`;
}

/**
 * Terminal error mapper. Everything the routes did not convert into a
 * contract-shaped 200 lands here: validation → 4xx, pool/infra → 502,
 * multer size cap → 413, unknown → 500.
 */
export function createErrorHandler(logger: Logger, uploadMaxBytes: number) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof ValidationError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    if ((err as MulterLikeError).code === 'LIMIT_FILE_SIZE') {
      res
        .status(413)
        .json({
          error: `file exceeds the configured upload limit of ${formatByteLimit(uploadMaxBytes)}`,
        });
      return;
    }
    if ((err as MulterLikeError).code === 'LIMIT_FILE_COUNT') {
      res.status(413).json({ error: 'too many files in one upload' });
      return;
    }
    if (err instanceof AcaError) {
      logger.error({ err: err.message, acaCode: err.acaCode }, 'pool backend error');
      res.status(err.statusCode >= 500 || err.statusCode === 429 ? 502 : err.statusCode).json({
        error: { code: err.acaCode === 'BACKEND_AUTH' ? 'BACKEND_AUTH' : 'BACKEND_ERROR' },
      });
      return;
    }
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  };
}

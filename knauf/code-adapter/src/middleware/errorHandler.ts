import { AcaError } from '../types/aca.js';
import { ValidationError } from '../validate.js';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger.js';

interface MulterLikeError extends Error {
  code?: string;
}

/**
 * Terminal error mapper. Everything the routes did not convert into a
 * contract-shaped 200 lands here: validation → 4xx, pool/infra → 502,
 * multer size cap → 413, unknown → 500.
 */
export function createErrorHandler(logger: Logger) {
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
      res.status(413).json({ error: 'file exceeds the 128MB upload limit' });
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

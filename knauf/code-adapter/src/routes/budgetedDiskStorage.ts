import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { ValidationError } from '../validate.js';
import type { StorageEngine } from 'multer';

/**
 * Multer disk storage that enforces a request's aggregate byte budget while it parses.
 *
 * Multer's own limits are per file (`fileSize`) and per count (`files`). A batch body streamed
 * without a Content-Length — which is how `form-data` sends files — therefore spooled every
 * file to the container's writable layer before any total could be checked: up to
 * `UPLOAD_BATCH_MAX_FILES` × `UPLOAD_MAX_BYTES` (about 4 GiB) for a 256 MiB budget. Here
 * every chunk is counted against the request's running total, and the write fails the moment
 * it passes `maxTotalBytes`. Multer then removes the files already stored (`_removeFile`) and
 * drains the rest of the body without writing it.
 */
export function budgetedDiskStorage(directory: string, maxTotalBytes: number): StorageEngine {
  mkdirSync(directory, { recursive: true });
  const totals = new WeakMap<object, number>();
  return {
    _handleFile(req, file, callback) {
      const filename = randomBytes(16).toString('hex');
      const path = join(directory, filename);
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          const total = (totals.get(req) ?? 0) + chunk.length;
          totals.set(req, total);
          if (total > maxTotalBytes) {
            done(new ValidationError('upload batch exceeds the maximum total size', 413));
            return;
          }
          size += chunk.length;
          done(null, chunk);
        },
      });
      pipeline(file.stream, meter, createWriteStream(path), (error) => {
        if (error) {
          // A partial file is never handed to multer, so it would not be removed for us.
          void unlink(path)
            .catch(() => undefined)
            .then(() => callback(error));
          return;
        }
        callback(null, { destination: directory, filename, path, size });
      });
    },
    _removeFile(_req, file, callback) {
      void unlink(file.path).then(
        () => callback(null),
        () => callback(null),
      );
    },
  };
}

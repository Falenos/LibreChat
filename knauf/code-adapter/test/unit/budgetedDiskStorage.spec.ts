import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetedDiskStorage } from '../../src/routes/budgetedDiskStorage.js';
import { ValidationError } from '../../src/validate.js';
import type { Request } from 'express';

interface Handled {
  err: unknown;
  info?: { size?: number; path?: string };
}

const dirs: string[] = [];
const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'karl-budget-'));
  dirs.push(dir);
  return dir;
};

const handle = (
  engine: ReturnType<typeof budgetedDiskStorage>,
  req: object,
  chunks: Buffer[],
): Promise<Handled> =>
  new Promise((resolve) => {
    const file = { stream: Readable.from(chunks) } as unknown as Express.Multer.File;
    engine._handleFile(req as Request, file, (err?: unknown, info?: Handled['info']) =>
      resolve({ err: err ?? null, info }),
    );
  });

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review of #386 (P1): a chunked batch has no Content-Length, so the budget must hold while
// parsing, not after every file has been spooled to the container's disk.
describe('budgetedDiskStorage', () => {
  it('stops writing as soon as the batch passes its byte budget and leaves no partial file', async () => {
    const dir = freshDir();
    const engine = budgetedDiskStorage(dir, 1000);
    const req = {};
    const first = await handle(engine, req, [Buffer.alloc(600)]);
    expect(first.err).toBeNull();
    expect(first.info?.size).toBe(600);
    const second = await handle(engine, req, [
      Buffer.alloc(300),
      Buffer.alloc(300),
      Buffer.alloc(300),
    ]);
    expect(second.err).toBeInstanceOf(ValidationError);
    expect((second.err as ValidationError).statusCode).toBe(413);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('accepts files that end exactly at the budget', async () => {
    const engine = budgetedDiskStorage(freshDir(), 1000);
    const req = {};
    expect((await handle(engine, req, [Buffer.alloc(400)])).err).toBeNull();
    expect((await handle(engine, req, [Buffer.alloc(600)])).err).toBeNull();
  });

  it('budgets each request on its own', async () => {
    const engine = budgetedDiskStorage(freshDir(), 1000);
    expect((await handle(engine, {}, [Buffer.alloc(900)])).err).toBeNull();
    expect((await handle(engine, {}, [Buffer.alloc(900)])).err).toBeNull();
  });

  it('removes a stored file when multer aborts the batch', async () => {
    const dir = freshDir();
    const engine = budgetedDiskStorage(dir, 1000);
    const stored = await handle(engine, {}, [Buffer.alloc(10)]);
    await new Promise<void>((resolve) =>
      engine._removeFile({} as Request, stored.info as Express.Multer.File, () => resolve()),
    );
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

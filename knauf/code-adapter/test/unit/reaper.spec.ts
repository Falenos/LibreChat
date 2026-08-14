import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createReaper } from '../../src/store/reaper.js';
import { mintSessionId } from '../../src/validate.js';
import { FakeBlobStore, FakeFilesRepo, testLogger } from '../helpers/fakes.js';

/**
 * [knauf] KK20-257 review finding A1 — staged bytes must not outlive the row that owns them.
 *
 * The Mongo TTL deletes a file's row 24h after last use, and that row holds the blob path
 * and the owner. Before the reaper, the blob itself was never deleted: user spreadsheets
 * stayed in the storage account indefinitely with nothing left to attribute them to. The
 * blobStore docblock claimed a container lifecycle rule covered it; no such rule exists.
 *
 * The tests that matter are the two "does not delete" ones. An age-based rule (the obvious
 * Terraform one-liner) gets those wrong, because `FilesRepo.touch` slides `expiresAt` on
 * every use while the blob's own creation time recedes.
 */
const HOUR = 3_600_000;
const TTL_HOURS = 24;

describe('[knauf] orphaned-blob reaper', () => {
  const build = () => {
    const blob = new FakeBlobStore();
    const repo = new FakeFilesRepo();
    let clock = new Date('2026-08-11T12:00:00Z').getTime();
    const reaper = createReaper({
      blob,
      repo: repo.asRepo(),
      logger: testLogger(),
      ttlHours: TTL_HOURS,
      intervalMs: 60_000,
      now: () => clock,
    });
    return {
      blob,
      repo,
      reaper,
      advance: (ms: number) => {
        clock += ms;
      },
      /** Stage a blob with a matching row, as an upload does. */
      stage: async (ageHours: number) => {
        const doc = await repo.insertStaged({
          sessionId: mintSessionId('user-1', 'secret'),
          filename: 'data.csv',
          size: 3,
          contentType: 'text/csv',
          origin: 'upload',
          readOnly: false,
          identity: { kind: 'user', id: 'user-1' },
          userId: 'user-1',
          tenantId: 'knauf',
        });
        await blob.put(doc.blobPath, Buffer.from('abc'), 'text/csv');
        blob.createdOn.set(doc.blobPath, new Date(clock - ageHours * HOUR));
        return doc;
      },
    };
  };

  it('deletes a blob whose row the TTL already removed', async () => {
    const t = build();
    const doc = await t.stage(30); // past the 24h TTL
    await t.repo.delete(doc.sessionId, doc.fileId); // what the TTL index does

    const result = await t.reaper.runOnce();

    expect(result.deleted).toBe(1);
    expect(t.blob.blobs.has(doc.blobPath)).toBe(false);
  });

  it('does NOT delete a blob whose row is still alive, however old the blob is', async () => {
    // The case an age-based lifecycle rule gets wrong. `touch` slides the row's expiry on
    // every exec push and download, so a file in active use across a long conversation has
    // a valid row and an old blob. Deleting it surfaces as "the file expired" on a file the
    // user just used.
    const t = build();
    const doc = await t.stage(240); // ten days old, still referenced

    const result = await t.reaper.runOnce();

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
  });

  it('does NOT delete a freshly written blob, even with no row yet', async () => {
    // Capture uploads the Blob before committing its path. A sweep landing between those
    // steps must not take the bytes, so young Blobs are skipped without a Mongo lookup.
    const t = build();
    const doc = await t.stage(0);
    await t.repo.delete(doc.sessionId, doc.fileId);

    const result = await t.reaper.runOnce();

    expect(result.deleted).toBe(0);
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
  });

  it('leaves a path it does not recognise alone', async () => {
    // The container is dedicated, but deleting an unrecognised path is not this process's
    // call to make.
    const t = build();
    await t.blob.put('something-else.txt', Buffer.from('x'), 'text/plain');
    t.blob.createdOn.set('something-else.txt', new Date(0));

    const result = await t.reaper.runOnce();

    expect(result.deleted).toBe(0);
    expect(t.blob.blobs.has('something-else.txt')).toBe(true);
  });

  it('keeps sweeping after one delete fails', async () => {
    const t = build();
    const doomed = await t.stage(30);
    const alsoDoomed = await t.stage(30);
    await t.repo.delete(doomed.sessionId, doomed.fileId);
    await t.repo.delete(alsoDoomed.sessionId, alsoDoomed.fileId);

    let first = true;
    const realDelete = t.blob.delete.bind(t.blob);
    t.blob.delete = async (path: string) => {
      if (first) {
        first = false;
        throw new Error('storage 503');
      }
      return realDelete(path);
    };

    const result = await t.reaper.runOnce();

    // One failed, one collected — a transient storage error must not abort the pass.
    expect(result.deleted).toBe(1);
  });

  it('treats a blob with no creation time as sweepable', async () => {
    // Defensive: if the listing omits createdOn we fall through to the reachability check
    // rather than skipping forever.
    const t = build();
    const sessionId = mintSessionId('user-1', 'secret');
    const path = `${sessionId}/${randomUUID()}`;
    await t.blob.put(path, Buffer.from('abc'), 'text/csv');

    const result = await t.reaper.runOnce();

    expect(result.deleted).toBe(1);
  });

  it('stops cleanly', () => {
    const t = build();
    expect(() => t.reaper.stop()).not.toThrow();
    expect(() => t.reaper.stop()).not.toThrow();
  });
});

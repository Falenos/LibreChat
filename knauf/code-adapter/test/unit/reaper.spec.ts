import { randomUUID } from 'node:crypto';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  FILE_SCHEMA_VERSION,
  FilesRepo,
  filenameRowKey,
} from '../../src/store/filesRepo.js';
import { createReaper } from '../../src/store/reaper.js';
import { mintSessionId } from '../../src/validate.js';
import { FakeBlobStore, testLogger, testMetrics } from '../helpers/fakes.js';
import { InMemoryTableClient } from '../helpers/tableFake.js';
import type { InsertFileInput } from '../../src/store/filesRepo.js';

const HOUR = 3_600_000;
const TTL_HOURS = 24;

describe('Table/Blob retention cleanup', () => {
  const build = (overrides: { pageSize?: number; maxPages?: number } = {}) => {
    let clock = new Date('2026-08-18T12:00:00.000Z').getTime();
    const table = new InMemoryTableClient();
    const repo = new FilesRepo(table, TTL_HOURS, undefined, () => new Date(clock));
    const blob = new FakeBlobStore();
    const metrics = testMetrics();
    const reaper = createReaper({
      blob,
      repo,
      logger: testLogger(),
      metrics,
      ttlHours: TTL_HOURS,
      intervalMs: HOUR,
      leaseMs: 60_000,
      reconciliationIntervalMs: 24 * HOUR,
      reconciliationPageSize: overrides.pageSize ?? 100,
      reconciliationMaxPages: overrides.maxPages ?? 10,
      reconciliationMaxMs: 30_000,
      now: () => clock,
      ownerId: 'reaper-a',
    });
    const sessionId = mintSessionId('user-1', 'secret');
    const input = (filename: string): InsertFileInput => ({
      sessionId,
      filename,
      size: 3,
      contentType: 'text/csv',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'user-1' },
      userId: 'user-1',
      tenantId: 'knauf',
    });
    const stage = async (filename = 'data.csv', ageHours = 30) => {
      const doc = await repo.insertStaged(input(filename));
      await blob.put(doc.blobPath, Buffer.from('abc'), 'text/csv');
      blob.createdOn.set(doc.blobPath, new Date(clock - ageHours * HOUR));
      return doc;
    };
    return {
      table,
      repo,
      blob,
      metrics,
      reaper,
      sessionId,
      input,
      stage,
      setClock: (value: number) => {
        clock = value;
      },
      advance: (value: number) => {
        clock += value;
      },
    };
  };

  it('classifies an old active Blob and leaves both metadata and bytes intact', async () => {
    const t = build();
    const doc = await t.stage('active.csv', 240);

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ active: 1, deleted: 0, skipped: 1 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
    expect(await t.repo.find(doc.sessionId, doc.fileId)).not.toBeNull();
  });

  it('repairs a missing Blob index before preserving an active Blob', async () => {
    const t = build();
    const doc = await t.stage('active-missing-index.csv', 240);
    t.table.deleteDirect(doc.sessionId, `b:${doc.fileId}`);

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ active: 1, deleted: 0, skipped: 1 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
    expect(await t.table.get(doc.sessionId, `b:${doc.fileId}`)).toMatchObject({
      fileId: doc.fileId,
      lookupValue: doc.blobPath,
    });
  });

  it('repairs a stale Blob-index target before preserving an active Blob', async () => {
    const t = build();
    const doc = await t.stage('active-corrupt-index.csv', 240);
    const index = await t.table.get(doc.sessionId, `b:${doc.fileId}`);
    t.table.replaceDirect({ ...index!, fileId: randomUUID() });

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ active: 1, deleted: 0, skipped: 1 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
    expect(await t.table.get(doc.sessionId, `b:${doc.fileId}`)).toMatchObject({
      fileId: doc.fileId,
      lookupValue: doc.blobPath,
    });
  });

  it('fails safe when Blob creation time is unavailable', async () => {
    const t = build();
    const blobPath = `${t.sessionId}/${randomUUID()}`;
    await t.blob.put(blobPath, Buffer.from('abc'), 'text/csv');

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(t.blob.blobs.has(blobPath)).toBe(true);
  });

  it('conditionally deletes expired metadata before deleting its Blob', async () => {
    const t = build();
    const doc = await t.stage('expired.csv');
    t.setClock(doc.expiresAt.getTime());
    const realDelete = t.blob.delete.bind(t.blob);
    t.blob.delete = async (path) => {
      expect(await t.table.get(doc.sessionId, `f:${doc.fileId}`)).toBeNull();
      await realDelete(path);
    };

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ expired: 1, deleted: 1, failed: 0 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(false);
  });

  it('leaves expired metadata and Blob for the next pass after an ETag conflict', async () => {
    const t = build();
    const doc = await t.stage('raced.csv');
    t.setClock(doc.expiresAt.getTime());
    const raw = await t.table.get(doc.sessionId, `f:${doc.fileId}`);
    t.table.beforeTransaction = () => {
      t.table.replaceDirect({
        ...raw!,
        expiresAt: new Date(doc.expiresAt.getTime() + HOUR),
      });
    };

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ expired: 1, deleted: 0, skipped: 1 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(true);
    expect(await t.table.get(doc.sessionId, `f:${doc.fileId}`)).not.toBeNull();
  });

  it('deletes an old orphan Blob with no Blob index', async () => {
    const t = build();
    const doc = await t.stage('orphan.csv');
    await t.repo.delete(doc.sessionId, doc.fileId);

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ orphan: 1, deleted: 1 });
    expect(t.blob.blobs.has(doc.blobPath)).toBe(false);
  });

  it('repairs a stale Blob index and deletes the superseded Blob', async () => {
    const t = build();
    const original = await t.stage('stale.csv');
    const currentPath = `${t.sessionId}/${randomUUID()}`;
    await t.repo.upsertCaptured(t.input('stale.csv'), currentPath);
    t.table.seed({
      partitionKey: t.sessionId,
      rowKey: `b:${original.fileId}`,
      entityType: 'blob-index',
      schemaVersion: FILE_SCHEMA_VERSION,
      fileId: original.fileId,
      lookupValue: original.blobPath,
    });

    const result = await t.reaper.runOnce();

    expect(result).toMatchObject({ stale: 1, deleted: 1 });
    expect(t.blob.blobs.has(original.blobPath)).toBe(false);
    expect(await t.table.get(t.sessionId, `b:${original.fileId}`)).toBeNull();
  });

  it('paginates reconciliation and repairs dangling indexes across bounded passes', async () => {
    const t = build({ pageSize: 1, maxPages: 1 });
    for (const filename of ['one.csv', 'two.csv', 'three.csv']) {
      t.table.seed({
        partitionKey: mintSessionId(filename, 'secret'),
        rowKey: filenameRowKey(filename),
        entityType: 'filename-index',
        schemaVersion: FILE_SCHEMA_VERSION,
        fileId: randomUUID(),
        lookupValue: filename,
      });
    }

    const first = await t.reaper.reconcileOnce();
    const second = await t.reaper.reconcileOnce();
    const third = await t.reaper.reconcileOnce();

    expect(first).toMatchObject({ pages: 1, scanned: 1, repaired: 1, continuation: true });
    expect(second).toMatchObject({ pages: 1, scanned: 1, repaired: 1, continuation: true });
    expect(third).toMatchObject({ pages: 1, scanned: 1, repaired: 1, completed: true });
    expect(t.table.allEntities().filter((entity) => entity.rowKey.startsWith('n:'))).toHaveLength(
      0,
    );
  });

  it('continues after entity and Blob failures and emits bounded result metrics', async () => {
    const t = build();
    const first = await t.stage('first.csv');
    const second = await t.stage('second.csv');
    t.setClock(first.expiresAt.getTime());
    let failOnce = true;
    const realDelete = t.blob.delete.bind(t.blob);
    t.blob.delete = async (path) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('storage 503');
      }
      await realDelete(path);
    };

    const result = await t.reaper.reconcileOnce();
    const metrics = await t.metrics.registry.getSingleMetricAsString(
      'code_adapter_cleanup_entities_total',
    );

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(t.blob.blobs.has(first.blobPath) || t.blob.blobs.has(second.blobPath)).toBe(true);
    expect(metrics).toContain('pass="reconciliation"');
    expect(metrics).toContain('outcome="failed"');
  });

  it('preserves the cursor after a page failure and resumes on a later pass', async () => {
    const t = build({ pageSize: 1, maxPages: 1 });
    t.table.seed({
      partitionKey: t.sessionId,
      rowKey: filenameRowKey('dangling.csv'),
      entityType: 'filename-index',
      schemaVersion: FILE_SCHEMA_VERSION,
      fileId: randomUUID(),
      lookupValue: 'dangling.csv',
    });
    t.table.failNextList(503);

    await expect(t.reaper.reconcileOnce()).resolves.toMatchObject({ failed: 1, scanned: 0 });
    await expect(t.repo.readReconciliationCursor()).resolves.toEqual({
      token: null,
      etag: null,
    });
    await expect(t.reaper.reconcileOnce()).resolves.toMatchObject({ repaired: 1 });
  });

  it('fails safe on a corrupt persisted continuation cursor', async () => {
    const t = build();
    t.table.seed({
      partitionKey: '__system__',
      rowKey: 'reconciliation-cursor',
      entityType: 'reconciliation-cursor',
      schemaVersion: FILE_SCHEMA_VERSION,
      continuationToken: 'not-a-valid-token',
      updatedAt: new Date(),
    });
    const dangling = t.table.seed({
      partitionKey: t.sessionId,
      rowKey: filenameRowKey('dangling.csv'),
      entityType: 'filename-index',
      schemaVersion: FILE_SCHEMA_VERSION,
      fileId: randomUUID(),
      lookupValue: 'dangling.csv',
    });

    const result = await t.reaper.reconcileOnce();

    expect(result).toMatchObject({ failed: 1, scanned: 0 });
    expect(await t.table.get(dangling.partitionKey, dangling.rowKey)).not.toBeNull();
  });

  it('uses a renewable single-runner lease and starts an immediate cleanup pass', async () => {
    const t = build();
    const doc = await t.stage('startup-orphan.csv');
    await t.repo.delete(doc.sessionId, doc.fileId);
    await expect(t.repo.acquireCleanupLease('owner-a', 60_000)).resolves.toBe(true);
    await expect(t.repo.acquireCleanupLease('owner-b', 60_000)).resolves.toBe(false);
    await t.repo.releaseCleanupLease('owner-a');

    t.reaper.start();
    await waitImmediate();
    await waitImmediate();
    await t.reaper.stop();

    expect(t.blob.blobs.has(doc.blobPath)).toBe(false);
  });
});

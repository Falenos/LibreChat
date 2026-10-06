import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CapturedOverwriteForbiddenError,
  FILE_SCHEMA_VERSION,
  FilesRepo,
  TableSchemaError,
  deserializeFileEntity,
  filenameRowKey,
  serializeFileEntity,
} from '../../src/store/filesRepo.js';
import { mintSessionId } from '../../src/validate.js';
import { InMemoryTableClient } from '../helpers/tableFake.js';
import type { FileDoc, InsertFileInput } from '../../src/store/filesRepo.js';

const HOUR_MS = 3_600_000;
const START = new Date('2026-08-18T12:00:00.000Z');

describe('Table-backed FilesRepo', () => {
  let clock: Date;
  let table: InMemoryTableClient;
  let repo: FilesRepo;
  let sessionId: string;

  const input = (overrides: Partial<InsertFileInput> = {}): InsertFileInput => ({
    sessionId,
    filename: 'result.csv',
    size: 42,
    contentType: 'text/csv',
    origin: 'exec-output',
    readOnly: false,
    identity: { kind: 'user', id: 'user-1' },
    userId: 'user-1',
    tenantId: 'knauf',
    ...overrides,
  });

  const candidate = (): string => `${sessionId}/${randomUUID()}`;

  beforeEach(() => {
    clock = new Date(START);
    table = new InMemoryTableClient();
    repo = new FilesRepo(table, 24, undefined, () => new Date(clock));
    sessionId = mintSessionId('user-1', 'secret');
  });

  it('serializes and strictly deserializes the flattened file schema', () => {
    const doc: FileDoc = {
      ...input({ identity: { kind: 'skill', id: 'xlsx', version: 3 } }),
      fileId: randomUUID(),
      state: 'captured',
      blobPath: candidate(),
      lastModified: clock,
      expiresAt: new Date(clock.getTime() + 24 * HOUR_MS),
    };

    const entity = {
      ...serializeFileEntity(doc),
      etag: '"etag"',
      timestamp: clock,
      'odata.metadata': 'https://account.table.core.windows.net/$metadata#table/@Element',
    };

    expect(entity).not.toHaveProperty('identity');
    expect(entity).toMatchObject({
      schemaVersion: FILE_SCHEMA_VERSION,
      identityKind: 'skill',
      identityId: 'xlsx',
      identityVersion: 3,
    });
    expect(deserializeFileEntity(entity)).toEqual(doc);
  });

  it('rejects unknown schema versions and malformed entities observably', () => {
    const doc: FileDoc = {
      ...input(),
      fileId: randomUUID(),
      state: 'captured',
      blobPath: candidate(),
      lastModified: clock,
      expiresAt: new Date(clock.getTime() + 24 * HOUR_MS),
    };
    const entity = { ...serializeFileEntity(doc), etag: '"etag"' };

    expect(() =>
      deserializeFileEntity({ ...entity, schemaVersion: FILE_SCHEMA_VERSION + 1 }),
    ).toThrowError(TableSchemaError);
    expect(() => deserializeFileEntity({ ...entity, expiresAt: 'not-a-date' })).toThrow(
      /malformed file entity/,
    );
    expect(() => deserializeFileEntity({ ...entity, surprise: true })).toThrow(
      /unknown properties/,
    );
  });

  it('hashes nested and Unicode filenames without placing them in RowKey', () => {
    const filename = 'résultats/東京/δοκιμή.csv';
    const expected = createHash('sha256').update(filename, 'utf8').digest('hex');

    expect(filenameRowKey(filename)).toBe(`n:${expected}`);
    expect(filenameRowKey(filename)).not.toContain('/');
    expect(filenameRowKey(filename)).not.toContain('東京');
  });

  it('creates file, filename index, and Blob index in one staged transaction', async () => {
    const doc = await repo.insertStaged(input({ origin: 'upload' }));

    expect(table.transactions).toHaveLength(1);
    expect(table.transactions[0]).toHaveLength(3);
    expect(new Set(table.transactions[0]?.map((action) => action.type))).toEqual(
      new Set(['create']),
    );
    expect(table.allEntities()).toHaveLength(3);
    expect(await repo.find(sessionId, doc.fileId)).toEqual(doc);
  });

  it('keeps the public fileId stable and uses a new Blob generation on active capture overwrite', async () => {
    const first = await repo.insertStaged(input());
    const newBlobPath = candidate();

    const result = await repo.upsertCaptured(input({ size: 84 }), newBlobPath);

    expect(result.doc.fileId).toBe(first.fileId);
    expect(result.doc.blobPath).toBe(newBlobPath);
    expect(result.obsoleteBlobPaths).toEqual([first.blobPath]);
    expect(table.allEntities().some((entity) => entity.rowKey === `b:${first.fileId}`)).toBe(false);
    expect(table.allEntities().some((entity) => entity.lookupValue === newBlobPath)).toBe(true);
  });

  // [knauf] KK20-397 (A6) — a capture has no authority over read-only, non-user or
  // foreign files that happen to share its partition and name.
  it('refuses to replace an active read-only, skill or foreign-user file', async () => {
    const readOnly = await repo.insertStaged(input({ filename: 'ro.md', readOnly: true }));
    await expect(repo.upsertCaptured(input({ filename: 'ro.md' }), candidate())).rejects.toThrow(
      CapturedOverwriteForbiddenError,
    );
    expect((await repo.find(sessionId, readOnly.fileId))?.blobPath).toBe(readOnly.blobPath);

    await repo.insertStaged(
      input({ filename: 'skill.md', identity: { kind: 'skill', id: 's', version: 1 } }),
    );
    await expect(repo.upsertCaptured(input({ filename: 'skill.md' }), candidate())).rejects.toThrow(
      CapturedOverwriteForbiddenError,
    );

    await repo.insertStaged(input({ filename: 'theirs.csv', userId: 'user-2' }));
    await expect(
      repo.upsertCaptured(input({ filename: 'theirs.csv' }), candidate()),
    ).rejects.toThrow(CapturedOverwriteForbiddenError);
  });

  it('rereads the concurrent create winner and updates that stable fileId', async () => {
    let winner: FileDoc | null = null;
    table.beforeTransaction = async () => {
      winner = await new FilesRepo(table, 24, undefined, () => new Date(clock)).insertStaged(
        input(),
      );
    };

    const result = await repo.upsertCaptured(input(), candidate());

    expect(winner).not.toBeNull();
    expect(result.doc.fileId).toBe(winner?.fileId);
    expect(result.obsoleteBlobPaths).toContain(winner?.blobPath);
  });

  it('retries 412 conflicts and fails after exactly five attempts', async () => {
    const existing = await repo.insertStaged(input());
    table.failNextTransaction(412);

    await expect(repo.upsertCaptured(input(), candidate())).resolves.toMatchObject({
      doc: { fileId: existing.fileId },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      table.failNextTransaction(412);
    }
    await expect(repo.upsertCaptured(input(), candidate())).rejects.toThrow(
      /exhausted 5 conditional attempts/,
    );
  });

  it('replaces an expired file without duplicate actions on the filename index', async () => {
    const expired = await repo.insertStaged(input());
    clock = new Date(expired.expiresAt);

    const result = await repo.upsertCaptured(input(), candidate());
    const actions = table.transactions.at(-1) ?? [];
    const keys = actions.map((action) =>
      action.type === 'delete'
        ? `${action.partitionKey}:${action.rowKey}`
        : `${action.entity.partitionKey}:${action.entity.rowKey}`,
    );
    const filenameActions = actions.filter((action) =>
      action.type === 'delete'
        ? action.rowKey.startsWith('n:')
        : action.entity.rowKey.startsWith('n:'),
    );

    expect(result.doc.fileId).not.toBe(expired.fileId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(filenameActions).toHaveLength(1);
    expect(filenameActions[0]?.type).toBe('update');
  });

  it('preserves every superseded Blob path encountered across capture retries', async () => {
    const first = await repo.insertStaged(input());
    const concurrentBlob = candidate();
    table.beforeTransaction = async () => {
      await new FilesRepo(table, 24, undefined, () => new Date(clock)).upsertCaptured(
        input(),
        concurrentBlob,
      );
    };

    const result = await repo.upsertCaptured(input(), candidate());

    expect(result.obsoleteBlobPaths).toEqual(
      expect.arrayContaining([first.blobPath, concurrentBlob]),
    );
  });

  it('lists only active file entities and never returns index entities', async () => {
    const active = await repo.insertStaged(input({ filename: 'active.csv' }));
    const expired = await repo.insertStaged(input({ filename: 'expired.csv' }));
    clock = new Date(expired.expiresAt);
    const refreshed = await repo.upsertCaptured(input({ filename: active.filename }), candidate());

    await expect(repo.listBySession(sessionId)).resolves.toEqual([refreshed.doc]);
  });

  it('touch updates only active expiry and never revives expired metadata', async () => {
    const doc = await repo.insertStaged(input());
    const before = table.allEntities().find((entity) => entity.rowKey === `f:${doc.fileId}`);
    clock = new Date(doc.expiresAt);

    await repo.touch(sessionId, doc.fileId);

    const after = table.allEntities().find((entity) => entity.rowKey === `f:${doc.fileId}`);
    expect(after).toEqual(before);
  });

  it('allows owned deletion workflows to locate expired metadata without reviving it', async () => {
    const doc = await repo.insertStaged(input());
    clock = new Date(doc.expiresAt);

    await expect(repo.find(sessionId, doc.fileId)).resolves.toBeNull();
    await expect(repo.findForDeletion(sessionId, doc.fileId)).resolves.toEqual(doc);
    await expect(repo.delete(sessionId, doc.fileId)).resolves.toBe(doc.blobPath);
    await expect(repo.findForDeletion(sessionId, doc.fileId)).resolves.toBeNull();
  });

  it('conditionally deletes metadata first while preserving a retargeted filename index', async () => {
    const doc = await repo.insertStaged(input());
    const filenameIndex = table
      .allEntities()
      .find((entity) => entity.rowKey === filenameRowKey(doc.filename));
    const replacementFileId = randomUUID();
    expect(filenameIndex).toBeDefined();
    table.beforeTransaction = () => {
      table.replaceDirect({ ...filenameIndex!, fileId: replacementFileId });
    };

    await expect(repo.delete(sessionId, doc.fileId)).resolves.toBe(doc.blobPath);

    const remainingIndex = await table.get(sessionId, filenameRowKey(doc.filename));
    expect(remainingIndex?.fileId).toBe(replacementFileId);
    expect(await table.get(sessionId, `f:${doc.fileId}`)).toBeNull();
    expect(table.allEntities().some((entity) => entity.lookupValue === doc.blobPath)).toBe(false);
  });

  it('rejects a filename index whose stored original filename does not match its hash', async () => {
    table.seed({
      partitionKey: sessionId,
      rowKey: filenameRowKey('result.csv'),
      entityType: 'filename-index',
      schemaVersion: FILE_SCHEMA_VERSION,
      fileId: randomUUID(),
      lookupValue: 'different.csv',
    });

    await expect(repo.upsertCaptured(input(), candidate())).rejects.toThrow(/filename index hash/);
  });
});

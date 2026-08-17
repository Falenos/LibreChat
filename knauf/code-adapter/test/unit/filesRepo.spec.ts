import { ObjectId } from 'mongodb';
import type { Collection, WithId } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesRepo } from '../../src/store/filesRepo.js';
import type { FileDoc, InsertFileInput } from '../../src/store/filesRepo.js';

const HOUR_MS = 3_600_000;
const NOW = new Date('2026-08-14T12:00:00.000Z');

function input(): InsertFileInput {
  return {
    sessionId: 'karl-session',
    filename: 'result.csv',
    size: 42,
    contentType: 'text/csv',
    origin: 'exec-output',
    readOnly: true,
    identity: { kind: 'user', id: 'user-1' },
    userId: 'user-1',
    tenantId: 'knauf',
  };
}

function fileDoc(overrides: Partial<WithId<FileDoc>> = {}): WithId<FileDoc> {
  return {
    _id: new ObjectId(),
    ...input(),
    fileId: 'file-1',
    state: 'captured',
    blobPath: 'karl-session/file-1',
    lastModified: NOW,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
    ...overrides,
  };
}

// Covers the compare-and-swap machinery `upsertCaptured`/`touch` need for the
// unique-blob-per-generation streaming design: two concurrent captures of the same
// filename must never lose an update or resurrect an already-expired row.
describe('FilesRepo', () => {
  const collection = {
    insertOne: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  };
  let repo: FilesRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    collection.updateOne.mockResolvedValue({ matchedCount: 1 });
    collection.deleteOne.mockResolvedValue({ deletedCount: 1 });
    repo = new FilesRepo(collection as unknown as Collection<FileDoc>, 24);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the sliding TTL for a newly staged file', async () => {
    const doc = await repo.insertStaged(input());

    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
    expect(collection.insertOne).toHaveBeenCalledWith(doc);
  });

  it('overwrites an active captured file in place, keeping its fileId and superseding its blobPath', async () => {
    const existing = fileDoc();
    collection.findOne.mockResolvedValue(existing);
    collection.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      value: { ...existing, ...update.$set },
    }));

    const { doc, obsoleteBlobPaths } = await repo.upsertCaptured(input(), 'karl-session/new-blob');

    expect(obsoleteBlobPaths).toEqual([existing.blobPath]);
    expect(doc.fileId).toBe(existing.fileId);
    expect(doc.blobPath).toBe('karl-session/new-blob');
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
  });

  it('retries against the current record when a captured-file revision is replaced mid-flight', async () => {
    const stale = fileDoc();
    const current = fileDoc({ lastModified: new Date(NOW.getTime() - HOUR_MS) });
    collection.findOne.mockResolvedValueOnce(stale).mockResolvedValueOnce(current);
    collection.findOneAndUpdate
      .mockResolvedValueOnce({ value: null })
      .mockImplementationOnce(async (_filter, update) => ({
        value: { ...current, ...update.$set },
      }));

    const { doc, obsoleteBlobPaths } = await repo.upsertCaptured(
      input(),
      'karl-session/new-blob',
    );

    expect(obsoleteBlobPaths).toEqual([current.blobPath]);
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: stale._id, lastModified: stale.lastModified, expiresAt: stale.expiresAt },
      expect.anything(),
      { returnDocument: 'after', includeResultMetadata: true },
    );
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
  });

  it('replaces an expired captured-file record with a fresh generation', async () => {
    const expired = fileDoc({ expiresAt: NOW });
    collection.findOne.mockResolvedValueOnce(expired).mockResolvedValueOnce(null);

    const { doc, obsoleteBlobPaths } = await repo.upsertCaptured(
      input(),
      'karl-session/new-blob',
    );

    expect(obsoleteBlobPaths).toEqual([expired.blobPath]);
    expect(collection.deleteOne).toHaveBeenCalledWith({
      _id: expired._id,
      lastModified: expired.lastModified,
      expiresAt: expired.expiresAt,
    });
    expect(doc.fileId).not.toBe(expired.fileId);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
    expect(collection.insertOne).toHaveBeenCalledWith(doc);
  });

  it('retries insertion after a concurrent writer wins the unique filename key', async () => {
    const winner = fileDoc();
    collection.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    collection.insertOne.mockRejectedValueOnce({ code: 11000 });
    collection.findOneAndUpdate.mockImplementationOnce(async (_filter, update) => ({
      value: { ...winner, ...update.$set },
    }));

    const { doc, obsoleteBlobPaths } = await repo.upsertCaptured(
      input(),
      'karl-session/new-blob',
    );

    expect(obsoleteBlobPaths).toEqual([winner.blobPath]);
    expect(doc.fileId).toBe(winner.fileId);
  });

  it('bumps the sliding TTL of an active file on touch', async () => {
    const existing = fileDoc();
    collection.findOne.mockResolvedValue(existing);

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: existing._id, lastModified: existing.lastModified, expiresAt: existing.expiresAt },
      { $set: { expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS) } },
    );
  });

  it('does not revive a file after its sliding TTL expires', async () => {
    collection.findOne.mockResolvedValue(fileDoc({ expiresAt: NOW }));

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it('retries touch against a concurrently updated revision', async () => {
    const stale = fileDoc();
    const current = fileDoc({ lastModified: new Date(NOW.getTime() - HOUR_MS) });
    collection.findOne.mockResolvedValueOnce(stale).mockResolvedValueOnce(current);
    collection.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledTimes(2);
    expect(collection.updateOne.mock.calls[1]?.[0]).toEqual({
      _id: current._id,
      lastModified: current.lastModified,
      expiresAt: current.expiresAt,
    });
  });

  it('does not return an expired file from find()', async () => {
    collection.findOne.mockResolvedValue(fileDoc({ expiresAt: NOW }));

    await expect(repo.find('karl-session', 'file-1')).resolves.toBeNull();
  });

  it('filters expired files out of a session listing', async () => {
    const active = fileDoc({ fileId: 'active' });
    const expired = fileDoc({ fileId: 'expired', expiresAt: NOW });
    collection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([active, expired]) });

    await expect(repo.listBySession('karl-session')).resolves.toEqual([active]);
  });
});

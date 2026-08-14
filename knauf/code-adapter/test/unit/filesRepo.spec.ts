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
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
    ...overrides,
  };
}

describe('FilesRepo absolute retention', () => {
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
    repo = new FilesRepo(collection as unknown as Collection<FileDoc>, 24, 168);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the sliding TTL for a newly staged file', async () => {
    const doc = await repo.insertStaged(input());

    expect(doc.createdAt).toEqual(NOW);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
    expect(collection.insertOne).toHaveBeenCalledWith(doc);
  });

  it('clamps a captured-file overwrite to the original absolute lifetime', async () => {
    const createdAt = new Date(NOW.getTime() - 167 * HOUR_MS);
    const existing = fileDoc({ createdAt });
    collection.findOne.mockResolvedValue(existing);
    collection.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      value: { ...existing, ...update.$set },
      lastErrorObject: { updatedExisting: true },
    }));

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(false);
    expect(doc.createdAt).toEqual(createdAt);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + HOUR_MS));
  });

  it('retries against the current record when a captured-file revision is replaced', async () => {
    const stale = fileDoc({ createdAt: new Date(NOW.getTime() - 167 * HOUR_MS) });
    const current = fileDoc({ createdAt: new Date(NOW.getTime() - 10 * HOUR_MS) });
    collection.findOne.mockResolvedValueOnce(stale).mockResolvedValueOnce(current);
    collection.findOneAndUpdate
      .mockResolvedValueOnce({ value: null })
      .mockImplementationOnce(async (_filter, update) => ({
        value: { ...current, ...update.$set },
      }));

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(false);
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      {
        _id: stale._id,
        lastModified: stale.lastModified,
        expiresAt: stale.expiresAt,
        createdAt: stale.createdAt,
      },
      expect.anything(),
      { returnDocument: 'after', includeResultMetadata: true },
    );
    expect(doc.createdAt).toEqual(current.createdAt);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
  });

  it('replaces an expired captured-file record with a fresh lifetime', async () => {
    const expired = fileDoc({ expiresAt: NOW });
    collection.findOne.mockResolvedValueOnce(expired).mockResolvedValueOnce(null);

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(true);
    expect(collection.deleteOne).toHaveBeenCalledWith({
      _id: expired._id,
      lastModified: expired.lastModified,
      expiresAt: expired.expiresAt,
      createdAt: expired.createdAt,
    });
    expect(doc.fileId).not.toBe(expired.fileId);
    expect(doc.createdAt).toEqual(NOW);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + 24 * HOUR_MS));
    expect(collection.insertOne).toHaveBeenCalledWith(doc);
  });

  it('replaces an absolutely expired record even when its sliding expiry is still future', async () => {
    const expired = fileDoc({
      createdAt: new Date(NOW.getTime() - 168 * HOUR_MS),
      expiresAt: new Date(NOW.getTime() + HOUR_MS),
    });
    collection.findOne.mockResolvedValueOnce(expired).mockResolvedValueOnce(null);

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(true);
    expect(collection.deleteOne).toHaveBeenCalledWith({
      _id: expired._id,
      lastModified: expired.lastModified,
      expiresAt: expired.expiresAt,
      createdAt: expired.createdAt,
    });
    expect(doc.createdAt).toEqual(NOW);
  });

  it('retries insertion after a concurrent writer wins the unique filename key', async () => {
    const winner = fileDoc();
    collection.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    collection.insertOne.mockRejectedValueOnce({ code: 11000 });
    collection.findOneAndUpdate.mockImplementationOnce(async (_filter, update) => ({
      value: { ...winner, ...update.$set },
    }));

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(false);
    expect(doc.fileId).toBe(winner.fileId);
  });

  it('clamps touch to the original absolute lifetime', async () => {
    const createdAt = new Date(NOW.getTime() - 167 * HOUR_MS);
    const existing = fileDoc({ createdAt });
    collection.findOne.mockResolvedValue(existing);

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: existing._id,
        lastModified: existing.lastModified,
        expiresAt: existing.expiresAt,
        createdAt,
      },
      { $set: { expiresAt: new Date(NOW.getTime() + HOUR_MS) } },
    );
  });

  it('does not revive a file after its sliding TTL expires', async () => {
    collection.findOne.mockResolvedValue(fileDoc({ expiresAt: NOW }));

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it('does not revive a file at its absolute lifetime boundary', async () => {
    collection.findOne.mockResolvedValue(
      fileDoc({
        createdAt: new Date(NOW.getTime() - 168 * HOUR_MS),
        expiresAt: new Date(NOW.getTime() + HOUR_MS),
      }),
    );

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
      createdAt: current.createdAt,
    });
  });

  it('does not return a file beyond its absolute lifetime', async () => {
    collection.findOne.mockResolvedValue(
      fileDoc({
        createdAt: new Date(NOW.getTime() - 169 * HOUR_MS),
        expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
      }),
    );

    await expect(repo.find('karl-session', 'file-1')).resolves.toBeNull();
  });

  it('filters absolutely expired files from session execution', async () => {
    const active = fileDoc({ fileId: 'active' });
    const expired = fileDoc({
      fileId: 'expired',
      createdAt: new Date(NOW.getTime() - 169 * HOUR_MS),
    });
    collection.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([active, expired]) });

    await expect(repo.listBySession('karl-session')).resolves.toEqual([active]);
  });

  it('anchors legacy rows to lastModified instead of granting an unbounded refresh', async () => {
    const lastModified = new Date(NOW.getTime() - 167 * HOUR_MS);
    const legacy = fileDoc({ lastModified });
    delete legacy.createdAt;
    collection.findOne.mockResolvedValue(legacy);

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: legacy._id,
        lastModified,
        expiresAt: legacy.expiresAt,
        createdAt: { $exists: false },
      },
      {
        $set: {
          expiresAt: new Date(NOW.getTime() + HOUR_MS),
          createdAt: lastModified,
        },
      },
    );
  });
});

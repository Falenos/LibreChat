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

function fileDoc(overrides: Partial<FileDoc> = {}): FileDoc {
  return {
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
  };
  let repo: FilesRepo;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
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
    collection.findOne.mockResolvedValue(existing as WithId<FileDoc>);
    collection.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      value: { ...existing, ...update.$set },
      lastErrorObject: { updatedExisting: true },
    }));

    const { doc, inserted } = await repo.upsertCaptured(input());

    expect(inserted).toBe(false);
    expect(doc.createdAt).toEqual(createdAt);
    expect(doc.expiresAt).toEqual(new Date(NOW.getTime() + HOUR_MS));
  });

  it('clamps touch to the original absolute lifetime', async () => {
    const createdAt = new Date(NOW.getTime() - 167 * HOUR_MS);
    collection.findOne.mockResolvedValue(fileDoc({ createdAt }) as WithId<FileDoc>);

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      { sessionId: 'karl-session', fileId: 'file-1' },
      { $set: { expiresAt: new Date(NOW.getTime() + HOUR_MS) } },
    );
  });

  it('does not return a file beyond its absolute lifetime', async () => {
    collection.findOne.mockResolvedValue(
      fileDoc({
        createdAt: new Date(NOW.getTime() - 169 * HOUR_MS),
        expiresAt: new Date(NOW.getTime() + 24 * HOUR_MS),
      }) as WithId<FileDoc>,
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
    delete (legacy as Partial<FileDoc>).createdAt;
    collection.findOne.mockResolvedValue(legacy as WithId<FileDoc>);

    await repo.touch('karl-session', 'file-1');

    expect(collection.updateOne).toHaveBeenCalledWith(
      { sessionId: 'karl-session', fileId: 'file-1' },
      {
        $set: {
          expiresAt: new Date(NOW.getTime() + HOUR_MS),
          createdAt: lastModified,
        },
      },
    );
  });
});

import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import type { CodeEnvIdentity } from '../types/contract.js';

export interface FileDoc {
  sessionId: string;
  fileId: string;
  filename: string;
  size: number;
  contentType: string;
  state: 'staged' | 'captured';
  origin: 'upload' | 'exec-output';
  readOnly: boolean;
  identity: CodeEnvIdentity;
  userId: string;
  tenantId: string;
  blobPath: string;
  lastModified: Date;
  createdAt: Date;
  expiresAt: Date;
}

export interface InsertFileInput {
  sessionId: string;
  filename: string;
  size: number;
  contentType: string;
  origin: 'upload' | 'exec-output';
  readOnly: boolean;
  identity: CodeEnvIdentity;
  userId: string;
  tenantId: string;
}

export class FilesRepo {
  constructor(
    private readonly collection: Collection<FileDoc>,
    private readonly ttlHours: number,
    private readonly maxLifetimeHours: number,
  ) {}

  private createdAt(doc: FileDoc, fallback: Date): Date {
    return doc.createdAt instanceof Date
      ? doc.createdAt
      : doc.lastModified instanceof Date
        ? doc.lastModified
        : fallback;
  }

  private expiry(from: Date, createdAt: Date): Date {
    const slidingExpiry = from.getTime() + this.ttlHours * 3_600_000;
    const absoluteExpiry = createdAt.getTime() + this.maxLifetimeHours * 3_600_000;
    return new Date(Math.min(slidingExpiry, absoluteExpiry));
  }

  private isActive(doc: FileDoc, now: Date): boolean {
    const absoluteExpiry =
      this.createdAt(doc, now).getTime() + this.maxLifetimeHours * 3_600_000;
    return doc.expiresAt.getTime() > now.getTime() && absoluteExpiry > now.getTime();
  }

  async insertStaged(input: InsertFileInput): Promise<FileDoc> {
    const now = new Date();
    const doc: FileDoc = {
      sessionId: input.sessionId,
      fileId: randomUUID(),
      filename: input.filename,
      size: input.size,
      contentType: input.contentType,
      state: input.origin === 'upload' ? 'staged' : 'captured',
      origin: input.origin,
      readOnly: input.readOnly,
      identity: input.identity,
      userId: input.userId,
      tenantId: input.tenantId,
      blobPath: '',
      lastModified: now,
      createdAt: now,
      expiresAt: this.expiry(now, now),
    };
    doc.blobPath = `${doc.sessionId}/${doc.fileId}`;
    await this.collection.insertOne(doc);
    return doc;
  }

  /**
   * Capture upsert keyed on (sessionId, filename) so a re-run of the same
   * code refreshes the row and keeps the fileId (and thus the blobPath /
   * download link) stable across overwrites. Returns `inserted` so the caller
   * can roll back a *fresh* row if the subsequent blob write fails — without
   * deleting a row whose blob from a prior turn is still valid.
   */
  async upsertCaptured(input: InsertFileInput): Promise<{ doc: FileDoc; inserted: boolean }> {
    const now = new Date();
    const fileId = randomUUID();
    const existing = await this.collection.findOne({
      sessionId: input.sessionId,
      filename: input.filename,
    });
    const createdAt = existing == null ? now : this.createdAt(existing, now);
    const result = await this.collection.findOneAndUpdate(
      { sessionId: input.sessionId, filename: input.filename },
      {
        $set: {
          size: input.size,
          contentType: input.contentType,
          state: 'captured',
          origin: input.origin,
          readOnly: input.readOnly,
          identity: input.identity,
          userId: input.userId,
          tenantId: input.tenantId,
          lastModified: now,
          expiresAt: this.expiry(now, createdAt),
          ...(existing != null && !(existing.createdAt instanceof Date) ? { createdAt } : {}),
        },
        $setOnInsert: {
          sessionId: input.sessionId,
          fileId,
          filename: input.filename,
          blobPath: `${input.sessionId}/${fileId}`,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
    );
    if (result.value == null) {
      throw new Error('upsertCaptured returned no document');
    }
    return { doc: result.value, inserted: result.lastErrorObject?.updatedExisting === false };
  }

  async find(sessionId: string, fileId: string): Promise<FileDoc | null> {
    const doc = await this.collection.findOne({ sessionId, fileId });
    return doc != null && this.isActive(doc, new Date()) ? doc : null;
  }

  async listBySession(sessionId: string): Promise<FileDoc[]> {
    const now = new Date();
    return (await this.collection.find({ sessionId }).toArray()).filter((doc) =>
      this.isActive(doc, now),
    );
  }

  /** Bump TTL on active use (exec push, download). */
  async touch(sessionId: string, fileId: string): Promise<void> {
    const now = new Date();
    const existing = await this.collection.findOne({ sessionId, fileId });
    if (existing == null) {
      return;
    }
    const createdAt = this.createdAt(existing, now);
    await this.collection.updateOne(
      { sessionId, fileId },
      {
        $set: {
          expiresAt: this.expiry(now, createdAt),
          ...(!(existing.createdAt instanceof Date) ? { createdAt } : {}),
        },
      },
    );
  }

  async delete(sessionId: string, fileId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ sessionId, fileId });
    return result.deletedCount === 1;
  }
}

import { randomUUID } from 'node:crypto';
import type { Collection, Filter, WithId } from 'mongodb';
import type { CodeEnvIdentity } from '../types/contract.js';

const MAX_WRITE_ATTEMPTS = 5;

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
  ) {}

  /**
   * CAS guard for touch()/upsertCaptured(): match the exact revision just read, so a
   * concurrent write in between never gets silently clobbered or lost.
   */
  private revisionFilter(doc: WithId<FileDoc>): Filter<FileDoc> {
    return { _id: doc._id, lastModified: doc.lastModified, expiresAt: doc.expiresAt };
  }

  private expiry(from = new Date()): Date {
    return new Date(from.getTime() + this.ttlHours * 3_600_000);
  }

  private isActive(doc: FileDoc, now: Date): boolean {
    return doc.expiresAt.getTime() > now.getTime();
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
      expiresAt: this.expiry(now),
    };
    doc.blobPath = `${doc.sessionId}/${doc.fileId}`;
    await this.collection.insertOne(doc);
    return doc;
  }

  /**
   * Commit an already-uploaded capture. The fileId/download link remains stable
   * across active overwrites, while blobPath changes for every upload so Mongo
   * always points to one complete Blob generation.
   */
  async upsertCaptured(
    input: InsertFileInput,
    blobPath: string,
  ): Promise<{ doc: FileDoc; obsoleteBlobPaths: string[] }> {
    const obsoleteBlobPaths = new Set<string>();
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const existing = await this.collection.findOne({
        sessionId: input.sessionId,
        filename: input.filename,
      });
      if (existing == null) {
        const fileId = randomUUID();
        const doc: FileDoc = {
          sessionId: input.sessionId,
          fileId,
          filename: input.filename,
          size: input.size,
          contentType: input.contentType,
          state: 'captured',
          origin: input.origin,
          readOnly: input.readOnly,
          identity: input.identity,
          userId: input.userId,
          tenantId: input.tenantId,
          blobPath,
          lastModified: now,
          expiresAt: this.expiry(now),
        };
        try {
          await this.collection.insertOne(doc);
          return { doc, obsoleteBlobPaths: [...obsoleteBlobPaths] };
        } catch (error) {
          if (
            typeof error === 'object' &&
            error != null &&
            'code' in error &&
            error.code === 11000
          ) {
            continue;
          }
          throw error;
        }
      }

      const revision = this.revisionFilter(existing);
      if (!this.isActive(existing, now)) {
        const result = await this.collection.deleteOne(revision);
        if (result.deletedCount === 1) {
          obsoleteBlobPaths.add(existing.blobPath);
        }
        continue;
      }

      const result = await this.collection.findOneAndUpdate(
        revision,
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
            blobPath,
            lastModified: now,
            expiresAt: this.expiry(now),
          },
        },
        { returnDocument: 'after', includeResultMetadata: true },
      );
      if (result.value != null) {
        if (existing.blobPath !== blobPath) {
          obsoleteBlobPaths.add(existing.blobPath);
        }
        return { doc: result.value, obsoleteBlobPaths: [...obsoleteBlobPaths] };
      }
    }
    throw new Error('upsertCaptured could not obtain a stable file revision');
  }

  async find(sessionId: string, fileId: string): Promise<FileDoc | null> {
    const doc = await this.collection.findOne({ sessionId, fileId });
    return doc != null && this.isActive(doc, new Date()) ? doc : null;
  }

  async findByBlobPath(blobPath: string): Promise<FileDoc | null> {
    const doc = await this.collection.findOne({ blobPath });
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
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const now = new Date();
      const existing = await this.collection.findOne({ sessionId, fileId });
      if (existing == null || !this.isActive(existing, now)) {
        return;
      }
      const result = await this.collection.updateOne(this.revisionFilter(existing), {
        $set: { expiresAt: this.expiry(now) },
      });
      if (result.matchedCount === 1) {
        return;
      }
    }
    throw new Error('touch could not obtain a stable file revision');
  }

  async delete(sessionId: string, fileId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ sessionId, fileId });
    return result.deletedCount === 1;
  }
}

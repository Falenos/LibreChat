import { BlobServiceClient } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

/**
 * Staging blob store. Every key is `<sessionId>/<fileId>` with both
 * segments adapter-minted, in a dedicated container. Blob cleanup is a
 * container lifecycle-management rule (>2 days) — Mongo rows are the
 * source of truth for validity, so an orphan blob is harmless.
 */
export interface BlobStore {
  put(blobPath: string, data: Buffer | Readable, contentType: string, size?: number): Promise<void>;
  getStream(
    blobPath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number | undefined }>;
  getBuffer(blobPath: string): Promise<Buffer>;
  delete(blobPath: string): Promise<void>;
}

export async function createBlobStore(config: Config): Promise<BlobStore> {
  const service = BlobServiceClient.fromConnectionString(config.blob.connectionString);
  const container: ContainerClient = service.getContainerClient(config.blob.container);
  await container.createIfNotExists();

  return {
    async put(blobPath, data, contentType, size) {
      const client = container.getBlockBlobClient(blobPath);
      const options = { blobHTTPHeaders: { blobContentType: contentType } };
      if (Buffer.isBuffer(data)) {
        await client.uploadData(data, options);
      } else {
        await client.uploadStream(data as Readable, undefined, undefined, options);
        void size;
      }
    },

    async getStream(blobPath) {
      const client = container.getBlockBlobClient(blobPath);
      const response = await client.download();
      if (response.readableStreamBody == null) {
        throw new Error(`blob ${blobPath} has no readable body`);
      }
      return {
        stream: response.readableStreamBody,
        contentLength: response.contentLength,
      };
    },

    async getBuffer(blobPath) {
      const client = container.getBlockBlobClient(blobPath);
      return client.downloadToBuffer();
    },

    async delete(blobPath) {
      const client = container.getBlockBlobClient(blobPath);
      await client.deleteIfExists();
    },
  };
}

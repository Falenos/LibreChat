import { BlobServiceClient } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

/**
 * Staging blob store. Every key is `<sessionId>/<fileId>` with both segments
 * adapter-minted, in a dedicated container.
 *
 * RETENTION (review finding A1). This docblock used to assert that cleanup was "a
 * container lifecycle-management rule (>2 days)". No such rule exists — agk-infrastructure
 * #73 explicitly defers it — and the claim made the gap invisible: the Mongo TTL removes
 * the row at 24h, and that row is the *only* thing holding the blob's path and its owner,
 * so the bytes stayed in the account forever with nothing left to attribute them to. User
 * spreadsheets, retained indefinitely and unattributable, is not a cost-tidiness item.
 *
 * Cleanup is therefore done here rather than left to infrastructure — see `store/reaper.ts`.
 * It deletes by reachability, not by age: the Mongo TTL *slides* on `touch`, so a blob's
 * own creation time is not a safe proxy for expiry, and an age-only rule (in Terraform or
 * anywhere else) would delete blobs that are still referenced. A lifecycle rule remains
 * worth adding as a backstop for bytes written by a build that crashed before its row
 * landed, but it cannot be the primary mechanism.
 */
export interface BlobStore {
  put(blobPath: string, data: Buffer | Readable, contentType: string, size?: number): Promise<void>;
  getStream(
    blobPath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number | undefined }>;
  getBuffer(blobPath: string): Promise<Buffer>;
  delete(blobPath: string): Promise<void>;
  /** Every staged blob with its creation time, for the reaper. */
  list(): AsyncIterable<{ name: string; createdOn?: Date | undefined }>;
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

    list() {
      return (async function* () {
        // Paged under the hood by the SDK, so a large container does not land in memory.
        for await (const blob of container.listBlobsFlat()) {
          yield { name: blob.name, createdOn: blob.properties.createdOn };
        }
      })();
    },
  };
}

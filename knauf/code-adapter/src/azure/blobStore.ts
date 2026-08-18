import { BlobServiceClient } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';
import type { TokenCredential } from '@azure/identity';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

const STREAM_UPLOAD_BUFFER_BYTES = 4 * 1024 * 1024;
const STREAM_UPLOAD_CONCURRENCY = 2;

/**
 * Staging blob store. Every key is `<sessionId>/<fileId>` with both segments
 * adapter-minted, in a dedicated container.
 *
 * RETENTION (review finding A1). This docblock used to assert that cleanup was "a
 * container lifecycle-management rule (>2 days)". No such rule exists — agk-infrastructure
 * #73 explicitly defers it — and the claim made the gap invisible. Table metadata has no
 * native TTL, so the adapter owns both Blob-led cleanup and bounded metadata reconciliation.
 *
 * Cleanup is therefore done here rather than left to infrastructure — see `store/reaper.ts`.
 * It deletes by reachability, not by age: metadata expiry *slides* on `touch`, so a blob's
 * own creation time is not a safe proxy for expiry, and an age-only rule (in Terraform or
 * anywhere else) would delete blobs that are still referenced. A lifecycle rule remains
 * worth adding as a backstop for bytes written by a build that crashed before its row
 * landed, but it cannot be the primary mechanism.
 */
export interface BlobStore {
  put(blobPath: string, data: Buffer | Readable, contentType: string, size?: number): Promise<void>;
  head(blobPath: string): Promise<{ contentLength: number } | null>;
  getStream(
    blobPath: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentLength?: number | undefined }>;
  getBuffer(blobPath: string): Promise<Buffer>;
  delete(blobPath: string): Promise<void>;
  /** Every staged blob with its creation time, for the reaper. */
  list(): AsyncIterable<{ name: string; createdOn?: Date | undefined }>;
}

/**
 * Build the service client. **Workload identity wins when both are configured**, so a
 * deployment migrating away from the key can add `AZURE_STORAGE_ACCOUNT_NAME` and drop the
 * connection string in either order without a window where the key is still in use.
 *
 * Why this exists (review finding B2): `agentic-karl-BLOB-STORAGE-CONNECTION-STRING` is the
 * storage account's *primary key* — literally
 * `module.storage_blob_dev.storage_primary_connection_string` in agk-infrastructure. Handing
 * it to this pod grants full control of every container on the account, including the app's
 * own `files`, which is the opposite of the compartmentalisation this service is supposed to
 * provide. With workload identity the pod's reach is exactly its role assignments, and those
 * can be scoped to `code-adapter-staging` alone.
 */
function createServiceClient(config: Config, credential?: TokenCredential): BlobServiceClient {
  if (config.blob.accountUrl != null) {
    if (credential == null) {
      throw new Error(
        'Blob workload-identity auth requires a credential; pass one to createBlobStore',
      );
    }
    return new BlobServiceClient(config.blob.accountUrl, credential);
  }
  if (config.blob.connectionString == null) {
    // loadConfig enforces one-of, so reaching here means the config was constructed by hand.
    throw new Error('Blob store needs AZURE_STORAGE_ACCOUNT_NAME or a connection string');
  }
  return BlobServiceClient.fromConnectionString(config.blob.connectionString);
}

export async function createBlobStore(
  config: Config,
  credential?: TokenCredential,
): Promise<BlobStore> {
  const service = createServiceClient(config, credential);
  const container: ContainerClient = service.getContainerClient(config.blob.container);
  // Creating the container needs a broader permission than using it. A container-scoped role
  // assignment — the tightest, and the point of moving off the account key — cannot create
  // containers, so this call 403s even though everything the adapter actually does would work.
  // Tolerate that ONLY when the container already exists; anything else is still fatal, so a
  // genuinely missing container or a wrong account still fails at boot rather than at first
  // upload.
  try {
    await container.createIfNotExists();
  } catch (err) {
    if (config.blob.accountUrl == null || !(await container.exists())) {
      throw err;
    }
  }

  return {
    async put(blobPath, data, contentType, size) {
      const client = container.getBlockBlobClient(blobPath);
      const options = { blobHTTPHeaders: { blobContentType: contentType } };
      if (Buffer.isBuffer(data)) {
        await client.uploadData(data, options);
      } else {
        // Keep each streaming upload's SDK buffers bounded to roughly 8 MiB.
        await client.uploadStream(
          data as Readable,
          STREAM_UPLOAD_BUFFER_BYTES,
          STREAM_UPLOAD_CONCURRENCY,
          options,
        );
        void size;
      }
    },

    async head(blobPath) {
      const client = container.getBlockBlobClient(blobPath);
      try {
        const properties = await client.getProperties();
        if (properties.contentLength == null) {
          throw new Error(`blob ${blobPath} has no content length`);
        }
        return { contentLength: properties.contentLength };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error != null &&
          'statusCode' in error &&
          error.statusCode === 404
        ) {
          return null;
        }
        throw error;
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

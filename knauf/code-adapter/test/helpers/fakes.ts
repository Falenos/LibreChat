import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import type { KeyLike } from 'jose';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/middleware/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import type { AcaClient } from '../../src/azure/acaClient.js';
import type { BlobStore } from '../../src/azure/blobStore.js';
import type { FileDoc, FilesRepo, InsertFileInput } from '../../src/store/filesRepo.js';
import type { AcaExecOutcome, AcaSessionFile } from '../../src/types/aca.js';

export const TEST_ENV_BASE = {
  CODE_ADAPTER_LOCAL_MODE: 'true',
  ACA_POOL_ENDPOINT: 'https://code-pool.example.test',
  MONGO_URI: 'mongodb://unused.example.test/karl',
  AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...process.env, ...TEST_ENV_BASE, ...overrides });
}

export const testLogger = () => createLogger('silent');
export const testMetrics = () => createMetrics();

/** In-memory FilesRepo — same public surface as the Mongo-backed class. */
export class FakeFilesRepo {
  docs = new Map<string, FileDoc>();

  private key(sessionId: string, fileId: string): string {
    return `${sessionId}:${fileId}`;
  }

  async insertStaged(input: InsertFileInput): Promise<FileDoc> {
    const now = new Date();
    const fileId = randomUUID();
    const doc: FileDoc = {
      ...input,
      fileId,
      state: input.origin === 'upload' ? 'staged' : 'captured',
      blobPath: `${input.sessionId}/${fileId}`,
      lastModified: now,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
    };
    this.docs.set(this.key(doc.sessionId, doc.fileId), doc);
    return doc;
  }

  async upsertCaptured(input: InsertFileInput): Promise<{ doc: FileDoc; inserted: boolean }> {
    for (const doc of this.docs.values()) {
      if (doc.sessionId === input.sessionId && doc.filename === input.filename) {
        Object.assign(doc, {
          size: input.size,
          contentType: input.contentType,
          state: 'captured',
          lastModified: new Date(),
        });
        return { doc, inserted: false };
      }
    }
    return { doc: await this.insertStaged({ ...input, origin: 'exec-output' }), inserted: true };
  }

  async find(sessionId: string, fileId: string): Promise<FileDoc | null> {
    return this.docs.get(this.key(sessionId, fileId)) ?? null;
  }

  async listBySession(sessionId: string): Promise<FileDoc[]> {
    return [...this.docs.values()].filter((d) => d.sessionId === sessionId);
  }

  async touch(): Promise<void> {
    /* no-op */
  }

  async delete(sessionId: string, fileId: string): Promise<boolean> {
    return this.docs.delete(this.key(sessionId, fileId));
  }

  asRepo(): FilesRepo {
    return this as unknown as FilesRepo;
  }
}

/** In-memory blob store. */
export class FakeBlobStore implements BlobStore {
  blobs = new Map<string, { data: Buffer; contentType: string }>();

  async put(blobPath: string, data: Buffer | Readable, contentType: string): Promise<void> {
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.concat(
          await (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of data) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
            }
            return chunks;
          })(),
        );
    this.blobs.set(blobPath, { data: buf, contentType });
  }

  async getStream(blobPath: string) {
    const entry = this.blobs.get(blobPath);
    if (entry == null) {
      throw new Error(`blob not found: ${blobPath}`);
    }
    return { stream: Readable.from(entry.data), contentLength: entry.data.length };
  }

  async getBuffer(blobPath: string): Promise<Buffer> {
    const entry = this.blobs.get(blobPath);
    if (entry == null) {
      throw new Error(`blob not found: ${blobPath}`);
    }
    return entry.data;
  }

  async delete(blobPath: string): Promise<void> {
    this.blobs.delete(blobPath);
  }
}

/** Programmable ACA client (single code-interpreter pool). */
export class FakeAcaClient implements AcaClient {
  executeImpl: (identifier: string, code: string) => Promise<AcaExecOutcome> = async () => ({
    succeeded: true,
    stdout: '',
    stderr: '',
    raw: {},
  });
  pushed: { identifier: string; name: string; data: Buffer }[] = [];
  sessionFiles: AcaSessionFile[] = [];
  fileContents = new Map<string, Buffer>();
  /** Peak number of pushFile calls in flight at once (ACA uploads must not overlap). */
  maxConcurrentPushes = 0;
  private activePushes = 0;

  async execute(identifier: string, code: string): Promise<AcaExecOutcome> {
    return this.executeImpl(identifier, code);
  }

  async pushFile(identifier: string, name: string, data: Buffer): Promise<void> {
    this.activePushes += 1;
    this.maxConcurrentPushes = Math.max(this.maxConcurrentPushes, this.activePushes);
    // Yield so any overlapping caller is observed before this one resolves.
    await new Promise((r) => setImmediate(r));
    this.pushed.push({ identifier, name, data });
    this.activePushes -= 1;
  }

  async listFiles(): Promise<AcaSessionFile[]> {
    return this.sessionFiles;
  }

  async fetchFileContent(_identifier: string, name: string): Promise<Buffer> {
    const content = this.fileContents.get(name);
    if (content == null) {
      throw new Error(`no fixture content for ${name}`);
    }
    return content;
  }
}

/** Mint a JWT shaped exactly like packages/api/src/auth/codeapi.ts. */
export async function mintLibreChatJwt(params: {
  privateKey: KeyLike;
  kid?: string;
  issuer?: string;
  audience?: string;
  sub?: string;
  tenantId?: string;
  role?: string;
  expiresIn?: string;
}): Promise<string> {
  return new SignJWT({
    tenant_id: params.tenantId ?? 'knauf',
    role: params.role ?? 'USER',
    principal_source: 'librechat_jwt',
    auth_context_hash: 'test-hash',
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: params.kid ?? 'lc-codeapi-test' })
    .setSubject(params.sub ?? 'user-1')
    .setIssuer(params.issuer ?? 'librechat')
    .setAudience(params.audience ?? 'codeapi')
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime(params.expiresIn ?? '2m')
    .setJti(randomUUID())
    .sign(params.privateKey);
}

export async function generateJwtKeypair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  return { publicKeyPem: await exportSPKI(publicKey), privateKey };
}

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import type { KeyLike } from 'jose';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/middleware/metrics.js';
import { loadConfig } from '../../src/config.js';
import { mintSessionId } from '../../src/validate.js';
import { deserializeFileEntity, FilesRepo } from '../../src/store/filesRepo.js';
import { InMemoryTableClient } from './tableFake.js';
import type { Config } from '../../src/config.js';
import type { AcaClient } from '../../src/azure/acaClient.js';
import type { BlobStore } from '../../src/azure/blobStore.js';
import type { FileDoc, InsertFileInput } from '../../src/store/filesRepo.js';
import type { AcaExecOutcome, AcaSessionFile } from '../../src/types/aca.js';

export const TEST_ENV_BASE = {
  CODE_ADAPTER_LOCAL_MODE: 'true',
  ACA_POOL_ENDPOINT: 'https://code-pool.example.test',
  AZURE_TABLE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  const env = { ...process.env, ...TEST_ENV_BASE, ...overrides };
  if (env.CODE_ADAPTER_LOCAL_MODE === 'false') {
    delete env.AZURE_TABLE_CONNECTION_STRING;
    env.AZURE_TABLE_ACCOUNT_NAME ??= 'table-test-account';
  }
  return loadConfig(env);
}

export const testLogger = () => createLogger('silent');
export const testMetrics = () => createMetrics();

/**
 * A session id the caller actually owns.
 *
 * `/exec` ignores a supplied `session_id` that does not bear the caller's owner tag, so a
 * hand-written `karl-<32 d's>` no longer exercises the reuse path — it exercises the
 * rejection path. Tests that mean to reuse a session must mint through the same helper the
 * adapter does. `'local'` is the LOCAL_MODE subject (see verifyJwt).
 */
export function ownedSessionId(config: Config, userId = 'local'): string {
  return mintSessionId(userId, config.sessionHintSecret);
}

/** Real FilesRepo over the purpose-built in-memory Table implementation. */
export class FakeFilesRepo {
  readonly table = new InMemoryTableClient();
  private readonly repo = new FilesRepo(this.table, 24);

  get docs(): Map<string, FileDoc> {
    return new Map(
      this.table
        .allEntities()
        .filter((entity) => entity.entityType === 'file')
        .map((entity) => {
          const doc = deserializeFileEntity(entity);
          return [`${doc.sessionId}:${doc.fileId}`, doc];
        }),
    );
  }

  insertStaged(input: InsertFileInput): Promise<FileDoc> {
    return this.repo.insertStaged(input);
  }

  async upsertCaptured(
    input: InsertFileInput,
    blobPath: string,
  ): Promise<{ doc: FileDoc; obsoleteBlobPaths: string[] }> {
    return this.repo.upsertCaptured(input, blobPath);
  }

  find(sessionId: string, fileId: string): Promise<FileDoc | null> {
    return this.repo.find(sessionId, fileId);
  }

  listBySession(sessionId: string): Promise<FileDoc[]> {
    return this.repo.listBySession(sessionId);
  }

  touch(sessionId: string, fileId: string): Promise<void> {
    return this.repo.touch(sessionId, fileId);
  }

  delete(sessionId: string, fileId: string): Promise<string | null> {
    return this.repo.delete(sessionId, fileId);
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

  /** Creation times, for the reaper. Absent unless a test sets one. */
  createdOn = new Map<string, Date>();

  list() {
    const entries = [...this.blobs.keys()];
    const createdOn = this.createdOn;
    return (async function* () {
      for (const name of entries) {
        yield { name, createdOn: createdOn.get(name) };
      }
    })();
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

  async fetchFileStream(identifier: string, name: string) {
    const content = await this.fetchFileContent(identifier, name);
    return { stream: Readable.from(content), contentLength: content.length };
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

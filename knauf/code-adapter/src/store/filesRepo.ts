import { createHash, randomUUID } from 'node:crypto';
import { CODE_ENV_KINDS } from '../types/contract.js';
import { isValidFileId, isValidSessionId } from '../validate.js';
import { isEntityNotFound, isTableConflict } from './tableStore.js';
import type { CodeEnvIdentity } from '../types/contract.js';
import type { Metrics } from '../middleware/metrics.js';
import type {
  RepositoryTableClient,
  StoredTableEntity,
  TableEntityRecord,
  TableMutation,
  TablePage,
} from './tableStore.js';

export const FILE_SCHEMA_VERSION = 1;
export const MAX_WRITE_ATTEMPTS = 5;

const FILE_ROW_PREFIX = 'f:';
const FILE_ROW_UPPER = 'f;';
const FILENAME_ROW_PREFIX = 'n:';
const BLOB_ROW_PREFIX = 'b:';
const SYSTEM_PARTITION = '__system__';
const LEASE_ROW = 'cleanup-lease';
const CURSOR_ROW = 'reconciliation-cursor';

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

export type FileImportResult = 'created' | 'existing';

interface FileRevision {
  doc: FileDoc;
  etag: string;
}

interface IndexRevision {
  entityType: 'filename-index' | 'blob-index';
  fileId: string;
  lookupValue: string;
  partitionKey: string;
  rowKey: string;
  etag: string;
}

interface LeaseRevision {
  ownerId: string;
  leaseUntil: Date;
  etag: string;
}

export type BlobLookup =
  | { state: 'active'; revision: FileRevision }
  | { state: 'expired'; revision: FileRevision }
  | { state: 'orphan'; safeToDelete: boolean }
  | { state: 'stale'; safeToDelete: boolean };

export interface ReconciliationCursor {
  token: string | null;
  etag: string | null;
}

export type ReconciliationOutcome =
  | { outcome: 'skipped' }
  | { outcome: 'conflict' }
  | { outcome: 'repaired' }
  | { outcome: 'deleted'; blobPath: string };

export class TableSchemaError extends Error {
  constructor(
    public readonly entity: 'file' | 'filename-index' | 'blob-index' | 'lease' | 'cursor' | 'unknown',
    public readonly reason: 'schema_version' | 'shape' | 'key_mismatch' | 'unknown_type',
    message: string,
  ) {
    super(message);
    this.name = 'TableSchemaError';
  }
}

export function filenameRowKey(filename: string): string {
  return `${FILENAME_ROW_PREFIX}${createHash('sha256').update(filename, 'utf8').digest('hex')}`;
}

export function fileRowKey(fileId: string): string {
  return `${FILE_ROW_PREFIX}${fileId}`;
}

export function blobRowKey(blobId: string): string {
  return `${BLOB_ROW_PREFIX}${blobId}`;
}

export function parseBlobPath(blobPath: string): { sessionId: string; blobId: string } | null {
  const slash = blobPath.indexOf('/');
  if (slash <= 0 || blobPath.indexOf('/', slash + 1) !== -1) {
    return null;
  }
  const sessionId = blobPath.slice(0, slash);
  const blobId = blobPath.slice(slash + 1);
  return isValidSessionId(sessionId) && isValidFileId(blobId) ? { sessionId, blobId } : null;
}

function schemaError(
  entity: TableSchemaError['entity'],
  reason: TableSchemaError['reason'],
  message: string,
): never {
  throw new TableSchemaError(entity, reason, message);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validateSchemaVersion(entity: TableEntityRecord, expected: TableSchemaError['entity']): void {
  if (entity.schemaVersion !== FILE_SCHEMA_VERSION) {
    schemaError(expected, 'schema_version', `unsupported ${expected} schema version`);
  }
}

function validateKnownKeys(
  entity: TableEntityRecord,
  expected: TableSchemaError['entity'],
  keys: readonly string[],
): void {
  const allowed = new Set(['partitionKey', 'rowKey', 'etag', 'timestamp', ...keys]);
  if (Object.keys(entity).some((key) => !allowed.has(key))) {
    schemaError(expected, 'shape', `${expected} entity contains unknown properties`);
  }
}

function validateIdentity(
  kind: unknown,
  id: unknown,
  version: unknown,
): CodeEnvIdentity {
  if (
    typeof kind !== 'string' ||
    !CODE_ENV_KINDS.includes(kind as (typeof CODE_ENV_KINDS)[number]) ||
    !isString(id)
  ) {
    schemaError('file', 'shape', 'invalid flattened identity');
  }
  if (kind === 'skill') {
    if (!Number.isInteger(version) || (version as number) < 0) {
      schemaError('file', 'shape', 'skill identity is missing a valid version');
    }
    return { kind, id, version: version as number };
  }
  if (version != null) {
    schemaError('file', 'shape', 'non-skill identity has a version');
  }
  return { kind: kind as 'agent' | 'user', id };
}

export function serializeFileEntity(doc: FileDoc): TableEntityRecord {
  return {
    partitionKey: doc.sessionId,
    rowKey: fileRowKey(doc.fileId),
    entityType: 'file',
    schemaVersion: FILE_SCHEMA_VERSION,
    fileId: doc.fileId,
    filename: doc.filename,
    size: doc.size,
    contentType: doc.contentType,
    state: doc.state,
    origin: doc.origin,
    readOnly: doc.readOnly,
    identityKind: doc.identity.kind,
    identityId: doc.identity.id,
    ...(doc.identity.version != null ? { identityVersion: doc.identity.version } : {}),
    userId: doc.userId,
    tenantId: doc.tenantId,
    blobPath: doc.blobPath,
    lastModified: doc.lastModified,
    expiresAt: doc.expiresAt,
  };
}

export function deserializeFileEntity(entity: StoredTableEntity): FileDoc {
  validateSchemaVersion(entity, 'file');
  validateKnownKeys(entity, 'file', [
    'entityType',
    'schemaVersion',
    'fileId',
    'filename',
    'size',
    'contentType',
    'state',
    'origin',
    'readOnly',
    'identityKind',
    'identityId',
    'identityVersion',
    'userId',
    'tenantId',
    'blobPath',
    'lastModified',
    'expiresAt',
  ]);
  if (
    entity.entityType !== 'file' ||
    !isValidSessionId(entity.partitionKey) ||
    !isValidFileId(entity.fileId) ||
    entity.rowKey !== fileRowKey(entity.fileId) ||
    !isString(entity.filename) ||
    !Number.isInteger(entity.size) ||
    (entity.size as number) < 0 ||
    !isString(entity.contentType) ||
    (entity.state !== 'staged' && entity.state !== 'captured') ||
    (entity.origin !== 'upload' && entity.origin !== 'exec-output') ||
    typeof entity.readOnly !== 'boolean' ||
    !isString(entity.userId) ||
    !isString(entity.tenantId) ||
    !isString(entity.blobPath) ||
    !isDate(entity.lastModified) ||
    !isDate(entity.expiresAt) ||
    (entity.state === 'staged' && entity.origin !== 'upload') ||
    (entity.state === 'captured' && entity.origin !== 'exec-output')
  ) {
    schemaError('file', 'shape', 'malformed file entity');
  }
  const parsedBlob = parseBlobPath(entity.blobPath);
  if (parsedBlob == null || parsedBlob.sessionId !== entity.partitionKey) {
    schemaError('file', 'key_mismatch', 'file Blob path does not match its partition');
  }
  return {
    sessionId: entity.partitionKey,
    fileId: entity.fileId,
    filename: entity.filename,
    size: entity.size as number,
    contentType: entity.contentType,
    state: entity.state,
    origin: entity.origin,
    readOnly: entity.readOnly,
    identity: validateIdentity(entity.identityKind, entity.identityId, entity.identityVersion),
    userId: entity.userId,
    tenantId: entity.tenantId,
    blobPath: entity.blobPath,
    lastModified: entity.lastModified,
    expiresAt: entity.expiresAt,
  };
}

function serializeFilenameIndex(doc: FileDoc): TableEntityRecord {
  return {
    partitionKey: doc.sessionId,
    rowKey: filenameRowKey(doc.filename),
    entityType: 'filename-index',
    schemaVersion: FILE_SCHEMA_VERSION,
    fileId: doc.fileId,
    lookupValue: doc.filename,
  };
}

function serializeBlobIndex(doc: FileDoc): TableEntityRecord {
  const parsed = parseBlobPath(doc.blobPath);
  if (parsed == null) {
    schemaError('file', 'shape', 'cannot index an invalid Blob path');
  }
  return {
    partitionKey: doc.sessionId,
    rowKey: blobRowKey(parsed.blobId),
    entityType: 'blob-index',
    schemaVersion: FILE_SCHEMA_VERSION,
    fileId: doc.fileId,
    lookupValue: doc.blobPath,
  };
}

function fileDocsEqual(left: FileDoc, right: FileDoc): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.fileId === right.fileId &&
    left.filename === right.filename &&
    left.size === right.size &&
    left.contentType === right.contentType &&
    left.state === right.state &&
    left.origin === right.origin &&
    left.readOnly === right.readOnly &&
    left.identity.kind === right.identity.kind &&
    left.identity.id === right.identity.id &&
    left.identity.version === right.identity.version &&
    left.userId === right.userId &&
    left.tenantId === right.tenantId &&
    left.blobPath === right.blobPath &&
    left.lastModified.getTime() === right.lastModified.getTime() &&
    left.expiresAt.getTime() === right.expiresAt.getTime()
  );
}

function deserializeIndexEntity(
  entity: StoredTableEntity,
  expected: 'filename-index' | 'blob-index',
): IndexRevision {
  validateSchemaVersion(entity, expected);
  validateKnownKeys(entity, expected, [
    'entityType',
    'schemaVersion',
    'fileId',
    'lookupValue',
  ]);
  if (
    entity.entityType !== expected ||
    !isValidSessionId(entity.partitionKey) ||
    !isValidFileId(entity.fileId) ||
    !isString(entity.lookupValue)
  ) {
    schemaError(expected, 'shape', `malformed ${expected} entity`);
  }
  if (expected === 'filename-index') {
    if (entity.rowKey !== filenameRowKey(entity.lookupValue)) {
      schemaError(expected, 'key_mismatch', 'filename index hash does not match its filename');
    }
  } else {
    const parsed = parseBlobPath(entity.lookupValue);
    if (
      parsed == null ||
      parsed.sessionId !== entity.partitionKey ||
      entity.rowKey !== blobRowKey(parsed.blobId)
    ) {
      schemaError(expected, 'key_mismatch', 'Blob index key does not match its Blob path');
    }
  }
  return {
    entityType: expected,
    fileId: entity.fileId,
    lookupValue: entity.lookupValue,
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    etag: entity.etag,
  };
}

function serializeLease(ownerId: string, leaseUntil: Date, updatedAt: Date): TableEntityRecord {
  return {
    partitionKey: SYSTEM_PARTITION,
    rowKey: LEASE_ROW,
    entityType: 'cleanup-lease',
    schemaVersion: FILE_SCHEMA_VERSION,
    ownerId,
    leaseUntil,
    updatedAt,
  };
}

function deserializeLease(entity: StoredTableEntity): LeaseRevision {
  validateSchemaVersion(entity, 'lease');
  validateKnownKeys(entity, 'lease', [
    'entityType',
    'schemaVersion',
    'ownerId',
    'leaseUntil',
    'updatedAt',
  ]);
  if (
    entity.partitionKey !== SYSTEM_PARTITION ||
    entity.rowKey !== LEASE_ROW ||
    entity.entityType !== 'cleanup-lease' ||
    !isString(entity.ownerId) ||
    !isDate(entity.leaseUntil) ||
    !isDate(entity.updatedAt)
  ) {
    schemaError('lease', 'shape', 'malformed cleanup lease');
  }
  return { ownerId: entity.ownerId, leaseUntil: entity.leaseUntil, etag: entity.etag };
}

function serializeCursor(token: string | null, updatedAt: Date): TableEntityRecord {
  return {
    partitionKey: SYSTEM_PARTITION,
    rowKey: CURSOR_ROW,
    entityType: 'reconciliation-cursor',
    schemaVersion: FILE_SCHEMA_VERSION,
    continuationToken: token ?? '',
    updatedAt,
  };
}

function deserializeCursor(entity: StoredTableEntity): ReconciliationCursor {
  validateSchemaVersion(entity, 'cursor');
  validateKnownKeys(entity, 'cursor', [
    'entityType',
    'schemaVersion',
    'continuationToken',
    'updatedAt',
  ]);
  if (
    entity.partitionKey !== SYSTEM_PARTITION ||
    entity.rowKey !== CURSOR_ROW ||
    entity.entityType !== 'reconciliation-cursor' ||
    typeof entity.continuationToken !== 'string' ||
    !isDate(entity.updatedAt)
  ) {
    schemaError('cursor', 'shape', 'malformed reconciliation cursor');
  }
  return {
    token: entity.continuationToken === '' ? null : entity.continuationToken,
    etag: entity.etag,
  };
}

export class FilesRepo {
  constructor(
    private readonly table: RepositoryTableClient,
    private readonly ttlHours: number,
    private readonly metrics?: Metrics,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private expiry(from: Date): Date {
    return new Date(from.getTime() + this.ttlHours * 3_600_000);
  }

  private isActive(doc: FileDoc, now = this.now()): boolean {
    return doc.expiresAt.getTime() > now.getTime();
  }

  private observeSchemaFailure(error: unknown): void {
    if (error instanceof TableSchemaError) {
      this.metrics?.tableSchemaFailures.inc({ entity: error.entity, reason: error.reason });
    }
  }

  private fileRevision(entity: StoredTableEntity): FileRevision {
    try {
      return { doc: deserializeFileEntity(entity), etag: entity.etag };
    } catch (error) {
      this.observeSchemaFailure(error);
      throw error;
    }
  }

  private indexRevision(
    entity: StoredTableEntity,
    expected: 'filename-index' | 'blob-index',
  ): IndexRevision {
    try {
      return deserializeIndexEntity(entity, expected);
    } catch (error) {
      this.observeSchemaFailure(error);
      throw error;
    }
  }

  private async readFile(sessionId: string, fileId: string): Promise<FileRevision | null> {
    const entity = await this.table.get(sessionId, fileRowKey(fileId));
    return entity == null ? null : this.fileRevision(entity);
  }

  private async readFilenameIndex(
    sessionId: string,
    filename: string,
  ): Promise<IndexRevision | null> {
    const entity = await this.table.get(sessionId, filenameRowKey(filename));
    if (entity == null) {
      return null;
    }
    const index = this.indexRevision(entity, 'filename-index');
    if (index.lookupValue !== filename) {
      schemaError('filename-index', 'key_mismatch', 'filename hash collision detected');
    }
    return index;
  }

  private async readBlobIndex(blobPath: string): Promise<IndexRevision | null> {
    const parsed = parseBlobPath(blobPath);
    if (parsed == null) {
      return null;
    }
    const entity = await this.table.get(parsed.sessionId, blobRowKey(parsed.blobId));
    return entity == null ? null : this.indexRevision(entity, 'blob-index');
  }

  private async findFileByBlobPath(
    sessionId: string,
    blobPath: string,
  ): Promise<FileRevision | null> {
    let continuationToken: string | undefined;
    let match: FileRevision | null = null;
    do {
      const page = await this.table.listPage({
        partitionKey: sessionId,
        rowKeyLower: FILE_ROW_PREFIX,
        rowKeyUpper: FILE_ROW_UPPER,
        ...(continuationToken != null ? { continuationToken } : {}),
        maxPageSize: 100,
      });
      for (const entity of page.entities) {
        const revision = this.fileRevision(entity);
        if (revision.doc.blobPath !== blobPath) {
          continue;
        }
        if (match != null && match.doc.fileId !== revision.doc.fileId) {
          const error = new TableSchemaError(
            'file',
            'key_mismatch',
            'multiple file entities reference the same Blob generation',
          );
          this.observeSchemaFailure(error);
          throw error;
        }
        match = revision;
      }
      continuationToken = page.continuationToken ?? undefined;
    } while (continuationToken != null);
    return match;
  }

  private async repairBlobIndex(
    current: IndexRevision | null,
    revision: FileRevision,
  ): Promise<boolean> {
    try {
      await this.table.submitTransaction([
        current == null
          ? { type: 'create', entity: serializeBlobIndex(revision.doc) }
          : {
              type: 'update',
              entity: serializeBlobIndex(revision.doc),
              etag: current.etag,
              mode: 'Replace',
            },
      ]);
      return true;
    } catch (error) {
      if (isEntityNotFound(error) || isTableConflict(error)) {
        return false;
      }
      throw error;
    }
  }

  private newDoc(input: InsertFileInput, fileId: string, blobPath: string, now: Date): FileDoc {
    return {
      sessionId: input.sessionId,
      fileId,
      filename: input.filename,
      size: input.size,
      contentType: input.contentType,
      state: input.origin === 'upload' ? 'staged' : 'captured',
      origin: input.origin,
      readOnly: input.readOnly,
      identity: input.identity,
      userId: input.userId,
      tenantId: input.tenantId,
      blobPath,
      lastModified: now,
      expiresAt: this.expiry(now),
    };
  }

  private recordRetryExhaustion(op: string): void {
    this.metrics?.tableConflicts.inc({ op, status: 'exhausted' });
  }

  async insertStaged(input: InsertFileInput): Promise<FileDoc> {
    const now = this.now();
    const fileId = randomUUID();
    const doc = this.newDoc(input, fileId, `${input.sessionId}/${fileId}`, now);
    await this.table.submitTransaction([
      { type: 'create', entity: serializeFileEntity(doc) },
      { type: 'create', entity: serializeFilenameIndex(doc) },
      { type: 'create', entity: serializeBlobIndex(doc) },
    ]);
    return doc;
  }

  private validateImportedFile(doc: FileDoc): FileDoc {
    return deserializeFileEntity({
      ...serializeFileEntity(doc),
      etag: '"migration-validation"',
    });
  }

  async checkImportFile(doc: FileDoc): Promise<'absent' | 'existing'> {
    const validated = this.validateImportedFile(doc);
    const [file, filenameRaw, blobRaw] = await Promise.all([
      this.readFile(validated.sessionId, validated.fileId),
      this.table.get(validated.sessionId, filenameRowKey(validated.filename)),
      this.readBlobIndex(validated.blobPath),
    ]);
    if (file == null && filenameRaw == null && blobRaw == null) {
      return 'absent';
    }
    if (file == null || filenameRaw == null || blobRaw == null) {
      throw new TableSchemaError(
        'file',
        'key_mismatch',
        'migration target contains a partial file/index set',
      );
    }
    const filename = this.indexRevision(filenameRaw, 'filename-index');
    if (
      fileDocsEqual(file.doc, validated) &&
      filename.fileId === validated.fileId &&
      filename.lookupValue === validated.filename &&
      blobRaw.fileId === validated.fileId &&
      blobRaw.lookupValue === validated.blobPath
    ) {
      return 'existing';
    }
    throw new TableSchemaError(
      'file',
      'key_mismatch',
      'migration target conflicts with the source document',
    );
  }

  async importFile(doc: FileDoc): Promise<FileImportResult> {
    const validated = deserializeFileEntity({
      ...serializeFileEntity(doc),
      etag: '"migration-validation"',
    });
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const target = await this.checkImportFile(validated);
      if (target === 'existing') {
        return 'existing';
      }
      if (target === 'absent') {
        try {
          await this.table.submitTransaction([
            { type: 'create', entity: serializeFileEntity(validated) },
            { type: 'create', entity: serializeFilenameIndex(validated) },
            { type: 'create', entity: serializeBlobIndex(validated) },
          ]);
          return 'created';
        } catch (error) {
          if (isTableConflict(error)) {
            continue;
          }
          throw error;
        }
      }
    }
    this.recordRetryExhaustion('import_file');
    throw new Error(`importFile exhausted ${MAX_WRITE_ATTEMPTS} conditional attempts`);
  }

  async upsertCaptured(
    input: InsertFileInput,
    blobPath: string,
  ): Promise<{ doc: FileDoc; obsoleteBlobPaths: string[] }> {
    const parsedCandidate = parseBlobPath(blobPath);
    if (parsedCandidate == null || parsedCandidate.sessionId !== input.sessionId) {
      throw new Error('captured Blob path must be a valid generation in the target session');
    }
    const obsoleteBlobPaths = new Set<string>();

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const now = this.now();
      const filenameIndex = await this.readFilenameIndex(input.sessionId, input.filename);
      const existing =
        filenameIndex == null ? null : await this.readFile(input.sessionId, filenameIndex.fileId);

      if (filenameIndex == null) {
        const fileId = randomUUID();
        const doc = this.newDoc(input, fileId, blobPath, now);
        try {
          await this.table.submitTransaction([
            { type: 'create', entity: serializeFileEntity(doc) },
            { type: 'create', entity: serializeFilenameIndex(doc) },
            { type: 'create', entity: serializeBlobIndex(doc) },
          ]);
          return { doc, obsoleteBlobPaths: [...obsoleteBlobPaths] };
        } catch (error) {
          if (isTableConflict(error)) {
            continue;
          }
          throw error;
        }
      }

      if (existing == null) {
        const fileId = randomUUID();
        const doc = this.newDoc(input, fileId, blobPath, now);
        try {
          await this.table.submitTransaction([
            {
              type: 'update',
              entity: serializeFilenameIndex(doc),
              etag: filenameIndex.etag,
              mode: 'Replace',
            },
            { type: 'create', entity: serializeFileEntity(doc) },
            { type: 'create', entity: serializeBlobIndex(doc) },
          ]);
          return { doc, obsoleteBlobPaths: [...obsoleteBlobPaths] };
        } catch (error) {
          if (isTableConflict(error)) {
            continue;
          }
          throw error;
        }
      }

      obsoleteBlobPaths.add(existing.doc.blobPath);
      const oldBlobIndex = await this.readBlobIndex(existing.doc.blobPath);
      const fileId = this.isActive(existing.doc) ? existing.doc.fileId : randomUUID();
      const doc = this.newDoc(input, fileId, blobPath, now);
      const actions: TableMutation[] = [];

      if (this.isActive(existing.doc)) {
        actions.push(
          {
            type: 'update',
            entity: serializeFileEntity(doc),
            etag: existing.etag,
            mode: 'Replace',
          },
          {
            type: 'update',
            entity: serializeFilenameIndex(doc),
            etag: filenameIndex.etag,
            mode: 'Replace',
          },
          { type: 'create', entity: serializeBlobIndex(doc) },
        );
      } else {
        actions.push(
          {
            type: 'update',
            entity: serializeFilenameIndex(doc),
            etag: filenameIndex.etag,
            mode: 'Replace',
          },
          { type: 'delete', partitionKey: input.sessionId, rowKey: fileRowKey(existing.doc.fileId), etag: existing.etag },
          { type: 'create', entity: serializeFileEntity(doc) },
          { type: 'create', entity: serializeBlobIndex(doc) },
        );
      }

      if (
        oldBlobIndex != null &&
        oldBlobIndex.fileId === existing.doc.fileId &&
        oldBlobIndex.lookupValue === existing.doc.blobPath
      ) {
        actions.push({
          type: 'delete',
          partitionKey: oldBlobIndex.partitionKey,
          rowKey: oldBlobIndex.rowKey,
          etag: oldBlobIndex.etag,
        });
      }

      try {
        await this.table.submitTransaction(actions);
        return { doc, obsoleteBlobPaths: [...obsoleteBlobPaths] };
      } catch (error) {
        if (isTableConflict(error)) {
          continue;
        }
        throw error;
      }
    }

    this.recordRetryExhaustion('upsert_captured');
    throw new Error(`upsertCaptured exhausted ${MAX_WRITE_ATTEMPTS} conditional attempts`);
  }

  async find(sessionId: string, fileId: string): Promise<FileDoc | null> {
    const revision = await this.readFile(sessionId, fileId);
    return revision != null && this.isActive(revision.doc) ? revision.doc : null;
  }

  async lookupBlob(blobPath: string): Promise<BlobLookup> {
    const parsed = parseBlobPath(blobPath);
    if (parsed == null) {
      return { state: 'orphan', safeToDelete: false };
    }
    const rawIndex = await this.table.get(parsed.sessionId, blobRowKey(parsed.blobId));
    if (rawIndex == null) {
      const referenced = await this.findFileByBlobPath(parsed.sessionId, blobPath);
      if (referenced == null) {
        return { state: 'orphan', safeToDelete: true };
      }
      if (!(await this.repairBlobIndex(null, referenced))) {
        return { state: 'stale', safeToDelete: false };
      }
      return this.isActive(referenced.doc)
        ? { state: 'active', revision: referenced }
        : { state: 'expired', revision: referenced };
    }
    const index = this.indexRevision(rawIndex, 'blob-index');
    const file = await this.readFile(parsed.sessionId, index.fileId);
    if (index.lookupValue === blobPath && file?.doc.blobPath === blobPath) {
      return this.isActive(file.doc)
        ? { state: 'active', revision: file }
        : { state: 'expired', revision: file };
    }

    const referenced = await this.findFileByBlobPath(parsed.sessionId, blobPath);
    if (referenced != null) {
      if (!(await this.repairBlobIndex(index, referenced))) {
        return { state: 'stale', safeToDelete: false };
      }
      return this.isActive(referenced.doc)
        ? { state: 'active', revision: referenced }
        : { state: 'expired', revision: referenced };
    }

    return {
      state: file == null && index.lookupValue === blobPath ? 'orphan' : 'stale',
      safeToDelete: await this.deleteIndexOnce(index),
    };
  }

  async listBySession(sessionId: string): Promise<FileDoc[]> {
    const docs: FileDoc[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.table.listPage({
        partitionKey: sessionId,
        rowKeyLower: FILE_ROW_PREFIX,
        rowKeyUpper: FILE_ROW_UPPER,
        ...(continuationToken != null ? { continuationToken } : {}),
        maxPageSize: 100,
      });
      for (const entity of page.entities) {
        const doc = this.fileRevision(entity).doc;
        if (this.isActive(doc)) {
          docs.push(doc);
        }
      }
      continuationToken = page.continuationToken ?? undefined;
    } while (continuationToken != null);
    return docs;
  }

  async touch(sessionId: string, fileId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const existing = await this.readFile(sessionId, fileId);
      const now = this.now();
      if (existing == null || !this.isActive(existing.doc, now)) {
        return;
      }
      try {
        await this.table.submitTransaction([
          {
            type: 'update',
            entity: {
              partitionKey: sessionId,
              rowKey: fileRowKey(fileId),
              expiresAt: this.expiry(now),
            },
            etag: existing.etag,
            mode: 'Merge',
          },
        ]);
        return;
      } catch (error) {
        if (isEntityNotFound(error)) {
          return;
        }
        if (isTableConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    this.recordRetryExhaustion('touch');
    throw new Error(`touch exhausted ${MAX_WRITE_ATTEMPTS} conditional attempts`);
  }

  async delete(sessionId: string, fileId: string): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const revision = await this.readFile(sessionId, fileId);
      if (revision == null) {
        return null;
      }
      try {
        return await this.deleteRevision(revision);
      } catch (error) {
        if (isEntityNotFound(error) || isTableConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    this.recordRetryExhaustion('delete');
    throw new Error(`delete exhausted ${MAX_WRITE_ATTEMPTS} conditional attempts`);
  }

  async deleteExpired(revision: FileRevision): Promise<string | null> {
    if (this.isActive(revision.doc)) {
      return null;
    }
    try {
      return await this.deleteRevision(revision);
    } catch (error) {
      if (isEntityNotFound(error) || isTableConflict(error)) {
        return null;
      }
      throw error;
    }
  }

  private async deleteRevision(revision: FileRevision): Promise<string> {
    const { doc } = revision;
    const [filenameRaw, blobRaw] = await Promise.all([
      this.table.get(doc.sessionId, filenameRowKey(doc.filename)),
      this.readBlobIndex(doc.blobPath),
    ]);
    const actions: TableMutation[] = [
      {
        type: 'delete',
        partitionKey: doc.sessionId,
        rowKey: fileRowKey(doc.fileId),
        etag: revision.etag,
      },
    ];
    if (filenameRaw != null) {
      const filenameIndex = this.indexRevision(filenameRaw, 'filename-index');
      if (filenameIndex.fileId === doc.fileId && filenameIndex.lookupValue === doc.filename) {
        actions.push({
          type: 'delete',
          partitionKey: filenameIndex.partitionKey,
          rowKey: filenameIndex.rowKey,
          etag: filenameIndex.etag,
        });
      }
    }
    if (
      blobRaw != null &&
      blobRaw.fileId === doc.fileId &&
      blobRaw.lookupValue === doc.blobPath
    ) {
      actions.push({
        type: 'delete',
        partitionKey: blobRaw.partitionKey,
        rowKey: blobRaw.rowKey,
        etag: blobRaw.etag,
      });
    }
    await this.table.submitTransaction(actions);
    return doc.blobPath;
  }

  private async deleteIndexOnce(index: IndexRevision): Promise<boolean> {
    try {
      await this.table.submitTransaction([
        {
          type: 'delete',
          partitionKey: index.partitionKey,
          rowKey: index.rowKey,
          etag: index.etag,
        },
      ]);
      return true;
    } catch (error) {
      if (isEntityNotFound(error) || isTableConflict(error)) {
        return false;
      }
      throw error;
    }
  }

  async listReconciliationPage(
    continuationToken: string | null,
    maxPageSize: number,
  ): Promise<TablePage> {
    return this.table.listPage({
      ...(continuationToken != null ? { continuationToken } : {}),
      maxPageSize,
    });
  }

  async reconcileEntity(entity: StoredTableEntity): Promise<ReconciliationOutcome> {
    if (entity.partitionKey === SYSTEM_PARTITION) {
      return { outcome: 'skipped' };
    }
    if (entity.entityType === 'file') {
      const revision = this.fileRevision(entity);
      if (this.isActive(revision.doc)) {
        return { outcome: 'skipped' };
      }
      const blobPath = await this.deleteExpired(revision);
      return blobPath == null ? { outcome: 'conflict' } : { outcome: 'deleted', blobPath };
    }
    if (entity.entityType !== 'filename-index' && entity.entityType !== 'blob-index') {
      const error = new TableSchemaError('unknown', 'unknown_type', 'unknown metadata entity type');
      this.observeSchemaFailure(error);
      throw error;
    }

    const index = this.indexRevision(entity, entity.entityType);
    const target = await this.readFile(index.partitionKey, index.fileId);
    let valid = target != null;
    if (target != null && index.entityType === 'filename-index') {
      valid =
        target.doc.filename === index.lookupValue &&
        index.rowKey === filenameRowKey(target.doc.filename);
    } else if (target != null) {
      valid =
        target.doc.blobPath === index.lookupValue &&
        index.rowKey === blobRowKey(parseBlobPath(target.doc.blobPath)?.blobId ?? '');
    }
    if (valid) {
      return { outcome: 'skipped' };
    }
    return (await this.deleteIndexOnce(index))
      ? { outcome: 'repaired' }
      : { outcome: 'conflict' };
  }

  async acquireCleanupLease(ownerId: string, leaseMs: number): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const now = this.now();
      const raw = await this.table.get(SYSTEM_PARTITION, LEASE_ROW);
      if (raw == null) {
        try {
          await this.table.submitTransaction([
            {
              type: 'create',
              entity: serializeLease(ownerId, new Date(now.getTime() + leaseMs), now),
            },
          ]);
          return true;
        } catch (error) {
          if (isTableConflict(error)) {
            continue;
          }
          throw error;
        }
      }
      let lease: LeaseRevision;
      try {
        lease = deserializeLease(raw);
      } catch (error) {
        this.observeSchemaFailure(error);
        throw error;
      }
      if (lease.ownerId !== ownerId && lease.leaseUntil.getTime() > now.getTime()) {
        return false;
      }
      try {
        await this.table.submitTransaction([
          {
            type: 'update',
            entity: serializeLease(ownerId, new Date(now.getTime() + leaseMs), now),
            etag: lease.etag,
            mode: 'Replace',
          },
        ]);
        return true;
      } catch (error) {
        if (isTableConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    this.recordRetryExhaustion('cleanup_lease');
    return false;
  }

  async holdsCleanupLease(ownerId: string): Promise<boolean> {
    const raw = await this.table.get(SYSTEM_PARTITION, LEASE_ROW);
    if (raw == null) {
      return false;
    }
    try {
      const lease = deserializeLease(raw);
      return lease.ownerId === ownerId && lease.leaseUntil.getTime() > this.now().getTime();
    } catch (error) {
      this.observeSchemaFailure(error);
      throw error;
    }
  }

  async releaseCleanupLease(ownerId: string): Promise<void> {
    const raw = await this.table.get(SYSTEM_PARTITION, LEASE_ROW);
    if (raw == null) {
      return;
    }
    let lease: LeaseRevision;
    try {
      lease = deserializeLease(raw);
    } catch (error) {
      this.observeSchemaFailure(error);
      throw error;
    }
    if (lease.ownerId !== ownerId) {
      return;
    }
    try {
      await this.table.submitTransaction([
        {
          type: 'delete',
          partitionKey: SYSTEM_PARTITION,
          rowKey: LEASE_ROW,
          etag: lease.etag,
        },
      ]);
    } catch (error) {
      if (!isEntityNotFound(error) && !isTableConflict(error)) {
        throw error;
      }
    }
  }

  async readReconciliationCursor(): Promise<ReconciliationCursor> {
    const raw = await this.table.get(SYSTEM_PARTITION, CURSOR_ROW);
    if (raw == null) {
      return { token: null, etag: null };
    }
    try {
      return deserializeCursor(raw);
    } catch (error) {
      this.observeSchemaFailure(error);
      throw error;
    }
  }

  async saveReconciliationCursor(token: string | null, etag: string | null): Promise<void> {
    const entity = serializeCursor(token, this.now());
    await this.table.submitTransaction([
      etag == null
        ? { type: 'create', entity }
        : { type: 'update', entity, etag, mode: 'Replace' },
    ]);
  }
}

import { CODE_ENV_KINDS } from '../types/contract.js';
import { deserializeFileEntity, serializeFileEntity } from '../store/filesRepo.js';
import type { CodeEnvIdentity } from '../types/contract.js';
import type { FileDoc } from '../store/filesRepo.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`legacy file field ${key} is invalid`);
  }
  return value;
}

function requiredDate(source: Record<string, unknown>, key: string): Date {
  const value = source[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`legacy file field ${key} is invalid`);
  }
  return value;
}

function parseIdentity(value: unknown): CodeEnvIdentity {
  if (!isRecord(value)) {
    throw new Error('legacy file identity is invalid');
  }
  const kind = value.kind;
  const id = value.id;
  const version = value.version;
  if (
    typeof kind !== 'string' ||
    !CODE_ENV_KINDS.includes(kind as (typeof CODE_ENV_KINDS)[number]) ||
    typeof id !== 'string' ||
    id === '' ||
    (version != null && (!Number.isInteger(version) || (version as number) < 0))
  ) {
    throw new Error('legacy file identity is invalid');
  }
  return {
    kind: kind as CodeEnvIdentity['kind'],
    id,
    ...(version != null ? { version: version as number } : {}),
  };
}

export function parseLegacyFileDoc(value: unknown): FileDoc {
  if (!isRecord(value)) {
    throw new Error('legacy file document is invalid');
  }
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('legacy file field size is invalid');
  }
  const state = value.state;
  const origin = value.origin;
  const readOnly = value.readOnly;
  if (
    (state !== 'staged' && state !== 'captured') ||
    (origin !== 'upload' && origin !== 'exec-output') ||
    typeof readOnly !== 'boolean'
  ) {
    throw new Error('legacy file state is invalid');
  }

  const doc: FileDoc = {
    sessionId: requiredString(value, 'sessionId'),
    fileId: requiredString(value, 'fileId'),
    filename: requiredString(value, 'filename'),
    size,
    contentType: requiredString(value, 'contentType'),
    state,
    origin,
    readOnly,
    identity: parseIdentity(value.identity),
    userId: requiredString(value, 'userId'),
    tenantId: requiredString(value, 'tenantId'),
    blobPath: requiredString(value, 'blobPath'),
    lastModified: requiredDate(value, 'lastModified'),
    expiresAt: requiredDate(value, 'expiresAt'),
  };

  return deserializeFileEntity({
    ...serializeFileEntity(doc),
    etag: '"legacy-validation"',
  });
}

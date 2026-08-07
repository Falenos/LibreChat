import { randomBytes } from 'node:crypto';
import { CODE_ENV_KINDS } from './types/contract.js';
import type { CodeEnvIdentity, CodeEnvKind } from './types/contract.js';

/**
 * Validation helpers. The identity rules and the 400 wording mirror
 * codeapi / packages/api/src/files/code/identity.ts so LibreChat's
 * client-side pre-validation and our server-side validation agree.
 */

/** Adapter-minted session ids double as ACA identifiers (4-128 chars). */
export const SESSION_ID_RE = /^karl-[0-9a-f]{32}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function mintSessionId(): string {
  return `karl-${randomBytes(16).toString('hex')}`;
}

export const SUPPORTED_LANGS = ['py', 'bash'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export function isSupportedLang(lang: unknown): lang is SupportedLang {
  return lang === 'py' || lang === 'bash';
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

const KIND_SET = new Set<string>(CODE_ENV_KINDS);

/**
 * Parse kind/id/version from multipart fields or query params.
 * Error wording mirrors codeapi ("kind must be one of: skill, agent, user").
 */
export function parseIdentity(input: {
  kind?: unknown;
  id?: unknown;
  version?: unknown;
}): CodeEnvIdentity {
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!KIND_SET.has(kind)) {
    throw new ValidationError(`kind must be one of: ${CODE_ENV_KINDS.join(', ')}`);
  }
  const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : null;
  if (id == null) {
    throw new ValidationError(`missing id for kind "${kind}"`);
  }
  let version: number | undefined;
  if (input.version != null && input.version !== '') {
    version = Number(input.version);
    if (!Number.isInteger(version) || version < 0) {
      throw new ValidationError('version must be a non-negative integer');
    }
  }
  if (kind === 'skill' && version == null) {
    throw new ValidationError('kind "skill" requires a numeric version');
  }
  if (kind !== 'skill' && version != null) {
    throw new ValidationError('version is only valid for kind "skill"');
  }
  return { kind: kind as CodeEnvKind, id, ...(version != null ? { version } : {}) };
}

/**
 * Filename safety, mirroring packages/api/src/files/code/form.ts rules:
 * relative, no `..`/empty segments, no control chars, no backslashes.
 * Nested paths (e.g. `reports/out.png`) are allowed.
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError('filename is required');
  }
  const name = raw.trim();
  if (name.length > 512) {
    throw new ValidationError('filename is too long');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\"]/.test(name)) {
    throw new ValidationError('filename contains invalid characters');
  }
  if (name.startsWith('/') || name.startsWith('~')) {
    throw new ValidationError('filename must be a relative path');
  }
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ValidationError('filename contains invalid path segments');
    }
  }
  return segments.join('/');
}

/** File ids are adapter-minted UUIDs; validate inbound path params. */
export const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID_RE.test(value);
}

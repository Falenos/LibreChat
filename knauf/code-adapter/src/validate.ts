import { createHmac, randomBytes } from 'node:crypto';
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

/**
 * Every session id carries an owner tag in its first 8 hex characters.
 *
 * WHY. An ACA session identifier *is* the isolation boundary between conversations —
 * posting to one gives you that sandbox and everything in its /mnt/data. `/exec` honours
 * a caller-supplied `session_id`, and nothing else in the request ties that id to the
 * caller: file *refs* are ownership-checked against metadata, the sandbox never was. So an
 * authenticated user could name another user's session and read their data by running
 * code in it. That it is unreachable today rests entirely on `@librechat/agents` choosing
 * not to put the field on the wire — a property of a third-party package, not of our auth.
 *
 * Tagging closes it with no new storage and no format change: the check is whether a
 * supplied id bears the *caller's* own tag, so another user's id is rejected whatever its
 * contents. 32 bits is ample here — an attacker cannot benefit from colliding their own
 * tag, only from matching the victim's, and the tag they must match is not theirs to
 * choose. The remaining 24 hex keeps 96 bits of entropy for minted ids, and the
 * `karl-<32hex>` shape is preserved so every existing regex, log line and test still holds.
 *
 * The secret's secrecy is NOT what makes this work — it only affects whether a
 * hint-derived id is predictable (see `deriveSessionId`). Ownership holds even if the
 * secret is public, because the comparison is against the caller's own identity.
 */
const OWNER_TAG_HEX = 8;

function ownerTag(userId: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`owner:${userId}`)
    .digest('hex')
    .slice(0, OWNER_TAG_HEX);
}

/** Does this session id belong to the authenticated caller? */
export function sessionBelongsTo(sessionId: string, userId: string, secret: string): boolean {
  return (
    sessionId.slice('karl-'.length, 'karl-'.length + OWNER_TAG_HEX) === ownerTag(userId, secret)
  );
}

export function mintSessionId(userId: string, secret: string): string {
  return `karl-${ownerTag(userId, secret)}${randomBytes(12).toString('hex')}`;
}

/**
 * Derive a stable session id from the caller's `runtime_session_hint`.
 *
 * `@librechat/agents` (3.2.65) sends that hint — the conversation's `thread_id`, or an
 * explicit host override — but only when the host sets
 * `toolExecution.sandbox.statefulSessions = true`. Same hint ⇒ same sandbox, which is how
 * a conversation gets continuity rather than a fresh sandbox per execution.
 *
 * The hint is NOT used as the ACA identifier directly, for two reasons: it is a LibreChat
 * conversation id (sending it to Azure would leak an internal identifier into a
 * third-party resource name and into ACA logs), and it is guessable, whereas identifiers
 * double as the isolation boundary between conversations. Hashing with a per-deployment
 * secret gives a stable, unguessable id inside our own `karl-<32hex>` namespace, so every
 * existing validation and log line keeps working unchanged.
 *
 * `userId` is mixed in for the same reason it is in the owner tag: a hint is a
 * conversation id, and two users on one shared conversation would otherwise derive the
 * same sandbox and see each other's files. Note this is the one place the secret's
 * secrecy matters — with a guessable secret, a known conversation id yields a predictable
 * session id. `SESSION_HINT_SECRET` should be set to a real secret before
 * `statefulSessions` is ever enabled; see the boot warning in index.ts.
 */
export function deriveSessionId(hint: string, secret: string, userId: string): string {
  const digest = createHmac('sha256', secret).update(`hint:${userId}:${hint}`).digest('hex');
  return `karl-${ownerTag(userId, secret)}${digest.slice(0, 32 - OWNER_TAG_HEX)}`;
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

// [knauf] KK20-328 — signatures for the retention ledger. Pure; no Mongo.
//
// HMAC-SHA256 with a key that lives OUTSIDE Mongo (`KNAUF_AUDIT_CHECKPOINT_HMAC_KEY`,
// injected from Key Vault). Two things are signed:
//   - the purge INTENT, at `begin`, before any delete — so recovery can refuse to
//     act on an intent written by someone holding only the database credential;
//   - the committed CHECKPOINT — so a moved boundary is detected by admin verify.
// Unset key ⇒ everything is `unsigned` and reported as such; it never pretends.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignableAuditCheckpoint {
  scopeKey: string;
  throughSeq: number;
  prevHash: string;
}

export interface SignableAuditIntent extends SignableAuditCheckpoint {
  cutoff: Date;
  startedAt: Date;
  owner: string;
  fence: number;
}

/**
 * `unsigned`  — no key configured; nothing to check against.
 * `missing`   — a key is configured but the record carries no signature: written before
 *               the key was activated, or stripped. NOT trusted, but distinguishable from
 *               tampering so operators can tell activation from an attack.
 * `valid`     — matches the current key, or the previous key during rotation.
 * `invalid`   — a signature is present and matches neither key: the record was edited.
 */
export type AuditCheckpointSignatureStatus = 'unsigned' | 'missing' | 'valid' | 'invalid';

/** Current key signs; previous key (rotation window) only verifies. */
export interface AuditSigningKeys {
  current?: string;
  previous?: string;
}

/** What callers may pass: a single key, a key ring, or nothing (unsigned mode). */
export type AuditSigningKeyInput = string | AuditSigningKeys | undefined;

function normalizeKeys(keys: AuditSigningKeyInput): AuditSigningKeys {
  if (typeof keys === 'string') {
    return { current: keys };
  }
  return keys ?? {};
}

export function canonicalAuditCheckpoint(c: SignableAuditCheckpoint): string {
  return ['knauf-audit-checkpoint-v1', c.scopeKey, String(c.throughSeq), c.prevHash].join('|');
}

export function canonicalAuditIntent(i: SignableAuditIntent): string {
  return [
    'knauf-audit-intent-v1',
    i.scopeKey,
    String(i.throughSeq),
    i.prevHash,
    new Date(i.cutoff).toISOString(),
    new Date(i.startedAt).toISOString(),
    i.owner,
    String(i.fence),
  ].join('|');
}

function hmac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function compare(
  payload: string,
  keys: AuditSigningKeys,
  actual: string | undefined,
): AuditCheckpointSignatureStatus {
  const candidates = [keys.current, keys.previous].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  if (candidates.length === 0) {
    return 'unsigned';
  }
  if (typeof actual !== 'string' || actual.length === 0) {
    return 'missing';
  }
  const given = Buffer.from(actual, 'hex');
  for (const key of candidates) {
    const expected = Buffer.from(hmac(payload, key), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return 'valid';
    }
  }
  return 'invalid';
}

export function signAuditCheckpoint(c: SignableAuditCheckpoint, key: string): string {
  return hmac(canonicalAuditCheckpoint(c), key);
}

export function signAuditIntent(i: SignableAuditIntent, key: string): string {
  return hmac(canonicalAuditIntent(i), key);
}

export function verifyAuditCheckpointSignature(
  c: SignableAuditCheckpoint & { signature?: string },
  keys: AuditSigningKeyInput,
): AuditCheckpointSignatureStatus {
  return compare(canonicalAuditCheckpoint(c), normalizeKeys(keys), c.signature);
}

export function verifyAuditIntentSignature(
  i: SignableAuditIntent & { signature?: string },
  keys: AuditSigningKeyInput,
): AuditCheckpointSignatureStatus {
  return compare(canonicalAuditIntent(i), normalizeKeys(keys), i.signature);
}
// End [knauf]

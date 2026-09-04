// [knauf] KK20-328 — checkpoint signature. Pure; no Mongo.
//
// HMAC-SHA256 over the canonical committed fields. The key lives OUTSIDE Mongo
// (`KNAUF_AUDIT_CHECKPOINT_HMAC_KEY`, injected from Key Vault), so a party holding
// only the application database credential cannot mint a checkpoint that
// legitimizes a prefix they deleted. Unset key ⇒ checkpoints are unsigned and the
// admin verify response says so explicitly; it never pretends.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignableAuditCheckpoint {
  scopeKey: string;
  generation: number;
  throughSeq: number;
  prevHash: string;
  terminal: boolean;
}

export function canonicalAuditCheckpoint(c: SignableAuditCheckpoint): string {
  return [
    'knauf-audit-checkpoint-v1',
    c.scopeKey,
    String(c.generation),
    String(c.throughSeq),
    c.prevHash,
    c.terminal ? 'terminal' : 'active',
  ].join('|');
}

export function signAuditCheckpoint(c: SignableAuditCheckpoint, key: string): string {
  return createHmac('sha256', key).update(canonicalAuditCheckpoint(c)).digest('hex');
}

export type AuditCheckpointSignatureStatus = 'unsigned' | 'valid' | 'invalid';

/**
 * `unsigned` when no key is configured (nothing to check against), `invalid` when
 * a key is configured and the stored signature is missing or wrong.
 */
export function verifyAuditCheckpointSignature(
  c: SignableAuditCheckpoint & { signature?: string },
  key: string | undefined,
): AuditCheckpointSignatureStatus {
  if (key == null || key.length === 0) {
    return 'unsigned';
  }
  if (typeof c.signature !== 'string' || c.signature.length === 0) {
    return 'invalid';
  }
  const expected = Buffer.from(signAuditCheckpoint(c, key), 'hex');
  const actual = Buffer.from(c.signature, 'hex');
  if (expected.length !== actual.length) {
    return 'invalid';
  }
  return timingSafeEqual(expected, actual) ? 'valid' : 'invalid';
}
// End [knauf]

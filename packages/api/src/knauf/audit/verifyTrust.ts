// [knauf] KK20-328 — retention-trust policy for the admin chain-verify endpoint.
//
// Kept OUT of upstream's `verifyAuditLogHandler` so the seam there stays a few lines:
// upstream evolves that handler, and a 50-line Knauf block inside it conflicts on every
// sync. Everything about "may this checkpoint be trusted, and what do we tell the
// operator" lives here and is unit-tested here.
import { verifyAuditIntentSignature } from '@librechat/data-schemas';
import { auditRetentionScopeKey, verifyAuditCheckpointSignature } from '@librechat/data-schemas';
import type {
  AuditCheckpoint,
  AuditCheckpointSignatureStatus,
  AuditRetentionCheckpointState,
  AuditSigningKeys,
} from '@librechat/data-schemas';

export interface AuditRetentionTrustReport {
  /** `never-purged`: no commit has ever happened for this scope (a pending intent may
   *  exist). `active`: a boundary is committed. `recovery-pending`: set by the handler
   *  when the committed boundary did not verify but the announced (pending) one did —
   *  a purge ran and its commit is still owed to the next sweep pass. */
  state: 'never-purged' | 'active' | 'recovery-pending';
  throughSeq?: number;
  totalDeleted?: number;
  recoveredCommits?: number;
  purgedAt?: Date;
  pendingIntent: boolean;
  /** Only present when a checkpoint exists. `missing` ⇒ committed before the key was
   *  activated (or stripped): not trusted, but not tampering either. */
  signature?: AuditCheckpointSignatureStatus;
}

export interface AuditRetentionTrust {
  /** Passed to `verifyAuditChain` only when the checkpoint may be trusted. */
  trustedCheckpoint?: AuditCheckpoint;
  /** The announced-but-uncommitted boundary, offered only if its intent signature is
   *  trustworthy under the same rule. The handler tries it when the committed one does
   *  not verify, so a purge caught between delete and commit is not a tamper alarm. */
  pendingCheckpoint?: AuditCheckpoint;
  retention: AuditRetentionTrustReport;
}

export interface ResolveAuditRetentionTrustParams {
  tenantId?: string;
  getAuditRetentionCheckpoint: (
    scopeKey: string,
  ) => Promise<AuditRetentionCheckpointState | undefined>;
  signingKeys?: AuditSigningKeys;
}

function trustworthy(status: AuditCheckpointSignatureStatus): boolean {
  return status === 'valid' || status === 'unsigned';
}

/**
 * A checkpoint is trusted when (a) a commit has actually happened for the scope and
 * (b) its signature is `valid`, or `unsigned` because no key is configured. `missing`
 * and `invalid` are both refused: the chain is then verified WITHOUT the checkpoint, so
 * a purged prefix surfaces as a break the operator has to explain — and the report
 * says which of the two it was.
 */
export async function resolveAuditRetentionTrust(
  params: ResolveAuditRetentionTrustParams,
): Promise<AuditRetentionTrust> {
  const scopeKey = auditRetentionScopeKey(params.tenantId);
  const state = await params.getAuditRetentionCheckpoint(scopeKey);
  const pending = state?.pending ?? null;
  const pendingCheckpoint =
    pending && trustworthy(verifyAuditIntentSignature({ scopeKey, ...pending }, params.signingKeys))
      ? { throughSeq: pending.throughSeq, prevHash: pending.prevHash }
      : undefined;

  if (!state || !state.purgedAt) {
    return {
      ...(pendingCheckpoint ? { pendingCheckpoint } : {}),
      retention: { state: 'never-purged', pendingIntent: pending != null },
    };
  }
  const signature = verifyAuditCheckpointSignature(state, params.signingKeys);
  return {
    ...(trustworthy(signature)
      ? { trustedCheckpoint: { throughSeq: state.throughSeq, prevHash: state.prevHash } }
      : {}),
    ...(pendingCheckpoint ? { pendingCheckpoint } : {}),
    retention: {
      state: 'active',
      throughSeq: state.throughSeq,
      totalDeleted: state.totalDeleted,
      recoveredCommits: state.recoveredCommits,
      purgedAt: state.purgedAt,
      pendingIntent: pending != null,
      signature,
    },
  };
}

/** Env → key ring. `KNAUF_AUDIT_CHECKPOINT_HMAC_KEY` signs; `…_PREVIOUS` only verifies
 *  during a rotation window. The ONE place both the sweep and verify read the keys. */
export function getAuditCheckpointSigningKeys(
  env: NodeJS.ProcessEnv = process.env,
): AuditSigningKeys {
  const current = env.KNAUF_AUDIT_CHECKPOINT_HMAC_KEY;
  const previous = env.KNAUF_AUDIT_CHECKPOINT_HMAC_KEY_PREVIOUS;
  return {
    ...(typeof current === 'string' && current.length > 0 ? { current } : {}),
    ...(typeof previous === 'string' && previous.length > 0 ? { previous } : {}),
  };
}
// End [knauf]

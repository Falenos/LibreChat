// [knauf] KK20-328 — audit-log retention sweep.
//
// The audit log is append-only and had no retention of any kind. GDPR Art. 5(1)(e)
// compels a justified, *enforced* period rather than a specific number; 12 months
// is the ISO 27001 A.8.15 / SOC 2 auditor convention, double the AI Act Art. 26(6)
// floor, and matches Microsoft Purview's E5 default for the estate's other admin
// trails. Explicitly NOT the §257 HGB / §147 AO 6–10 year periods — this log is
// neither Handelsbuch, Handelsbrief nor Buchungsbeleg, and importing those periods
// creates an Art. 5(1)(e)/§26 BDSG problem instead of compliance.
// Rationale: knauf/docs/privacy/workstream.md §3.4.
//
// Shape of one pass (per scope), designed so a crash at ANY point is recoverable:
//   1. finalize   — commit or drop any intent a previous pass left behind
//   2. boundary   — compute what the purge will delete through (read-only; always
//                   retains the newest row, so the chain is never emptied)
//   3. begin      — persist and sign that intent (write-ahead, fenced)
//   4. purge      — re-confirm the lease, then upstream `purgeAuditLogEntries`
//                   bounded by the boundary's own `purgeBefore` (the only delete)
//   5. finalize   — read the chain, commit the boundary it actually has
// The whole pass runs under a renewable distributed lease so 2–10 API replicas cannot
// purge the same chain concurrently. The lease grants a FENCING TOKEN carried into
// every ledger write (a lapsed holder's writes are rejected as stale, which aborts the
// pass), renewal failure ABORTS before any further delete, and a dry run is READ-ONLY.
// Ships INERT: with no retention configured this module does nothing at all.
//
// Deliberate duplication, do not converge on an upstream sync: `startAuditRetentionSweep`
// mirrors `files/sweep.ts`'s runner shape (isSweeping guard, unref'd interval) rather
// than extracting a shared runner from the upstream file; the fenced Mongo lease lives
// in data-schemas `knauf/audit` rather than reusing `api/knauf/db/meiliSyncLock.js`
// (no fence) or upstream's Redis `LeaderElection` (Redis-only) — the fence is the point.
import type {
  AuditRetentionBoundary,
  AuditRetentionFinalizeOutcome,
  AuditRetentionLeaseGrant,
} from '@librechat/data-schemas';

/** 12 months — the §3.4 recommendation, used only once retention is switched on. */
export const DEFAULT_AUDIT_RETENTION_DAYS: number = 365;
/** Six hours. The log is low-volume (admin/security events), so this is about
 *  bounding lag after a period change, not about throughput. */
export const DEFAULT_AUDIT_SWEEP_INTERVAL_MS: number = 6 * 60 * 60 * 1000;
/** Ten minutes. A pass over a low-volume log takes seconds; the lease is renewed
 *  at a third of this while the pass runs, so only a dead holder lets it lapse. */
export const DEFAULT_AUDIT_SWEEP_LEASE_MS: number = 10 * 60 * 1000;
/** Floor for the lease TTL: the heartbeat runs at TTL/3, so anything shorter than this
 *  would let a healthy holder's own lease lapse between renewals. */
export const MIN_AUDIT_SWEEP_LEASE_MS: number = 30 * 1000;

export interface AuditScope {
  scopeKey: string;
  tenantId?: string;
}

export interface AuditPurgeOutcome {
  scopeKey: string;
  /** Rows actually removed by this pass. Always 0 in a dry run. */
  deletedCount: number;
  /** Dry-run only: rows older than the cutoff (an upper-bound estimate). */
  wouldDelete?: number;
  /** A boundary was committed to the ledger (this pass or by recovery). */
  checkpointAdvanced: boolean;
  /** A leftover intent from an earlier crashed pass was finalized first. */
  recoveredPending?: AuditRetentionFinalizeOutcome;
}

export interface AuditRetentionSweepResult {
  /** False when retention is unset — the sweep did not run at all. */
  enabled: boolean;
  dryRun: boolean;
  /** Set when the pass did not run: another replica holds the lease, or a pass
   *  completed too recently (boot-storm guard). */
  skipped?: 'lease-held' | 'recently-completed';
  /** Set when the lease was lost mid-pass: remaining scopes were NOT touched. */
  aborted?: 'lease-lost';
  /** Fencing token this pass ran under. */
  fence?: number;
  cutoff?: Date;
  chains: AuditPurgeOutcome[];
  totalDeleted: number;
  totalWouldDelete?: number;
}

export interface AuditRetentionSweepDependencies {
  listAuditScopes(): Promise<AuditScope[]>;
  computeBoundary(scope: AuditScope, before: Date): Promise<AuditRetentionBoundary | null>;
  /** Write-ahead + signature. False ⇒ our fence is stale: do NOT delete. */
  beginPurge(params: {
    scopeKey: string;
    boundary: AuditRetentionBoundary;
    cutoff: Date;
    now: Date;
    fence: number;
  }): Promise<boolean>;
  /** The only delete. `confirm:false` makes upstream a no-op that reports 0. */
  purgeScope(
    scope: AuditScope,
    options: { before: Date; confirm: boolean },
  ): Promise<{ deletedCount: number }>;
  finalizePurge(params: {
    scope: AuditScope;
    fence: number;
    deletedCount?: number;
    now: Date;
    recovered?: boolean;
  }): Promise<AuditRetentionFinalizeOutcome>;
  /** Rows older than `before`. Dry-run only — upstream reports 0 on `confirm:false`. */
  countPurgeable(scope: AuditScope, before: Date): Promise<number>;
  lease: {
    owner: string;
    ttlMs: number;
    /** Refuse a pass that would start less than this long after the previous one
     *  completed. 0 disables the guard (one-shot / CronJob mode). */
    minGapMs: number;
    acquire(now: Date): Promise<AuditRetentionLeaseGrant>;
    /** False ⇒ the lease is no longer ours (expired or taken over). */
    renew(fence: number, now: Date): Promise<boolean>;
    release(fence: number, now: Date): Promise<void>;
  };
  now(): Date;
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, meta?: unknown): void;
  };
}

/**
 * Retention period in days. Unset/blank/0/invalid ⇒ `undefined`, which disables
 * the sweep entirely. There is deliberately no fallback to the 365-day default:
 * a retention period is a DPO decision, and silently adopting one because an env
 * var was missing is exactly the failure mode that makes a deletion job dangerous.
 */
export function getAuditRetentionDays(
  raw: string | undefined = process.env.KNAUF_AUDIT_RETENTION_DAYS,
): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function getAuditSweepIntervalMs(
  raw: string | undefined = process.env.KNAUF_AUDIT_SWEEP_INTERVAL_MS,
): number {
  if (raw == null || raw.trim() === '') return DEFAULT_AUDIT_SWEEP_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_AUDIT_SWEEP_INTERVAL_MS;
  return value;
}

export function getAuditSweepLeaseMs(
  raw: string | undefined = process.env.KNAUF_AUDIT_SWEEP_LEASE_MS,
): number {
  if (raw == null || raw.trim() === '') return DEFAULT_AUDIT_SWEEP_LEASE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_AUDIT_SWEEP_LEASE_MS) {
    return DEFAULT_AUDIT_SWEEP_LEASE_MS;
  }
  return value;
}

/**
 * Dry-run unless explicitly disabled. Defaults to ON so that merging this and
 * setting a retention period still deletes nothing — an operator has to opt into
 * destruction twice, and can read the would-delete counts first.
 */
export function isAuditSweepDryRun(
  raw: string | undefined = process.env.KNAUF_AUDIT_SWEEP_DRY_RUN,
): boolean {
  return raw?.trim().toLowerCase() !== 'false';
}

export function computeAuditCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

class AuditSweepAbortedError extends Error {
  constructor() {
    super('audit retention sweep aborted: lease lost');
    this.name = 'AuditSweepAbortedError';
  }
}

interface SweepContext {
  fence: number;
  /** True once a renewal failed or rejected. Checked before every destructive phase. */
  isLeaseLost(): boolean;
}

async function sweepScope(
  scope: AuditScope,
  cutoff: Date,
  dryRun: boolean,
  deps: AuditRetentionSweepDependencies,
  ctx: SweepContext,
): Promise<AuditPurgeOutcome> {
  const outcome: AuditPurgeOutcome = {
    scopeKey: scope.scopeKey,
    deletedCount: 0,
    checkpointAdvanced: false,
  };

  /* Dry run is READ-ONLY — it does not even recover leftover intents, because that is
   * a ledger write (and may sign). It reports what a real pass would remove. */
  if (dryRun) {
    outcome.wouldDelete = await deps.countPurgeable(scope, cutoff);
    return outcome;
  }

  /* 1. Recovery. A previous pass may have announced an intent and died before
   *    (or during, or after) the delete. The chain says what actually happened;
   *    the ledger verifies the intent's signature and fence before believing it. */
  const recovered = await deps.finalizePurge({
    scope,
    fence: ctx.fence,
    now: deps.now(),
    recovered: true,
  });
  if (recovered.action !== 'none') {
    outcome.recoveredPending = recovered;
    if (recovered.action === 'dropped' && recovered.reason === 'stale-fence') {
      throw new AuditSweepAbortedError(); // a higher fence has written: we lost the lease
    }
    const level =
      recovered.action === 'dropped' && recovered.reason === 'untrusted-intent' ? 'error' : 'warn';
    deps.logger[level]('[auditRetention] finalized a leftover purge intent', {
      scopeKey: scope.scopeKey,
      recovered,
    });
    if (recovered.action === 'committed') {
      outcome.checkpointAdvanced = true;
    }
  }

  /* 2–3. Announce before deleting. */
  const boundary = await deps.computeBoundary(scope, cutoff);
  if (!boundary) {
    return outcome;
  }
  const announced = await deps.beginPurge({
    scopeKey: scope.scopeKey,
    boundary,
    cutoff,
    now: deps.now(),
    fence: ctx.fence,
  });
  if (!announced) {
    throw new AuditSweepAbortedError(); // stale fence at announce: we lost the lease
  }

  /* 4. The only delete — preceded by a synchronous lease re-confirmation, because
   *    the heartbeat is periodic and this is the one step that cannot be undone. The
   *    `before` handed to upstream is the boundary's own, so the delete is bounded by
   *    the retained row even when every row is older than the cutoff. */
  if (ctx.isLeaseLost()) {
    throw new AuditSweepAbortedError();
  }
  let stillOurs = false;
  try {
    stillOurs = await deps.lease.renew(ctx.fence, deps.now());
  } catch {
    stillOurs = false; // cannot prove we hold it ⇒ treat as lost
  }
  if (!stillOurs) {
    throw new AuditSweepAbortedError();
  }
  const purge = await deps.purgeScope(scope, { before: boundary.purgeBefore, confirm: true });
  outcome.deletedCount = purge.deletedCount ?? 0;

  /* 5. Commit what the chain actually shows. If this throws or is rejected, the
   *    intent stays and step 1 of the next pass finishes the job. */
  const result = await deps.finalizePurge({
    scope,
    fence: ctx.fence,
    deletedCount: outcome.deletedCount,
    now: deps.now(),
  });
  if (result.action === 'committed') {
    outcome.checkpointAdvanced = true;
  } else if (result.action === 'dropped' && result.reason === 'stale-fence') {
    throw new AuditSweepAbortedError();
  } else if (outcome.deletedCount > 0) {
    deps.logger.error('[auditRetention] rows deleted but boundary not committed', {
      scopeKey: scope.scopeKey,
      result,
    });
  }
  return outcome;
}

/**
 * One pass over every audit chain, under the distributed lease. A chain that
 * throws is logged and skipped so a single bad chain cannot stall retention for
 * the rest — the next pass retries it (and recovers its intent first). Losing
 * the lease is different: it aborts the pass, and the remaining scopes are left
 * untouched for whoever holds the lease now.
 */
export async function sweepAuditRetention(
  options: { retentionDays?: number; dryRun?: boolean },
  deps: AuditRetentionSweepDependencies,
): Promise<AuditRetentionSweepResult> {
  const retentionDays = options.retentionDays ?? getAuditRetentionDays();
  const dryRun = options.dryRun ?? isAuditSweepDryRun();
  if (retentionDays == null) {
    return { enabled: false, dryRun, chains: [], totalDeleted: 0 };
  }

  const grant = await deps.lease.acquire(deps.now());
  if (!grant.ok) {
    const skipped = grant.reason === 'recently-completed' ? 'recently-completed' : 'lease-held';
    deps.logger.info(
      skipped === 'lease-held'
        ? '[auditRetention] another replica holds the sweep lease; skipping this pass'
        : '[auditRetention] a pass completed recently; skipping this pass',
      { owner: deps.lease.owner },
    );
    return { enabled: true, dryRun, skipped, chains: [], totalDeleted: 0 };
  }
  const fence = grant.fence;
  let leaseLost = false;
  const markLost = (why: string, meta?: unknown) => {
    if (!leaseLost) {
      leaseLost = true;
      deps.logger.error(
        `[auditRetention] lease lost (${why}) — aborting before any further deletion`,
        { owner: deps.lease.owner, fence, ...(meta ? { meta } : {}) },
      );
    }
  };
  const heartbeat = setInterval(
    () => {
      deps.lease
        .renew(fence, deps.now())
        .then((ok) => {
          if (!ok) markLost('renewal refused');
        })
        .catch((error) => markLost('renewal failed', error));
    },
    Math.max(1000, Math.floor(deps.lease.ttlMs / 3)),
  );
  heartbeat.unref?.();
  const ctx: SweepContext = { fence, isLeaseLost: () => leaseLost };

  try {
    const cutoff = computeAuditCutoff(deps.now(), retentionDays);
    const scopes = await deps.listAuditScopes();
    const chains: AuditPurgeOutcome[] = [];
    let totalDeleted = 0;
    let totalWouldDelete = 0;
    let aborted: 'lease-lost' | undefined;

    for (const scope of scopes) {
      if (leaseLost) {
        aborted = 'lease-lost';
        break;
      }
      try {
        const outcome = await sweepScope(scope, cutoff, dryRun, deps, ctx);
        totalDeleted += outcome.deletedCount;
        totalWouldDelete += outcome.wouldDelete ?? 0;
        chains.push(outcome);
      } catch (error) {
        if (error instanceof AuditSweepAbortedError) {
          markLost('re-confirmation before delete failed, or a higher fence has written');
          aborted = 'lease-lost';
          break;
        }
        deps.logger.error('[auditRetention] scope sweep failed', {
          scopeKey: scope.scopeKey,
          error,
        });
      }
    }

    if (totalDeleted > 0 || dryRun || aborted || chains.some((c) => c.recoveredPending)) {
      deps.logger.info('[auditRetention] sweep complete', {
        dryRun,
        retentionDays,
        fence,
        cutoff: cutoff.toISOString(),
        chains: chains.length,
        scopes: scopes.length,
        totalDeleted,
        recovered: chains.filter((c) => c.recoveredPending).length,
        ...(aborted ? { aborted } : {}),
        ...(dryRun ? { totalWouldDelete } : {}),
      });
    }
    return {
      enabled: true,
      dryRun,
      fence,
      cutoff,
      chains,
      totalDeleted,
      ...(aborted ? { aborted } : {}),
      ...(dryRun ? { totalWouldDelete } : {}),
    };
  } finally {
    clearInterval(heartbeat);
    if (!leaseLost) {
      await deps.lease
        .release(fence, deps.now())
        .catch((error) => deps.logger.warn('[auditRetention] lease release failed', { error }));
    }
  }
}

export interface StartAuditRetentionSweepDependencies {
  sweepAuditRetention(options: {
    retentionDays?: number;
    dryRun?: boolean;
  }): Promise<AuditRetentionSweepResult>;
  runAsSystem<T>(fn: () => Promise<T>): Promise<T>;
  logger: { info(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
}

/**
 * Start the periodic in-process sweep, or return null when it should not run.
 * The process-local `isSweeping` guard only prevents self-overlap; cross-replica
 * exclusion is the lease inside `sweepAuditRetention`. Deployments that prefer a
 * singleton CronJob run `api/knauf/audit/sweepOnce.js` and set the interval to 0.
 */
export function startAuditRetentionSweep(
  deps: StartAuditRetentionSweepDependencies,
): NodeJS.Timeout | null {
  const retentionDays = getAuditRetentionDays();
  if (retentionDays == null) {
    deps.logger.info(
      '[auditRetention] Disabled — set KNAUF_AUDIT_RETENTION_DAYS to enable (see knauf/docs/privacy/workstream.md §3.4)',
    );
    return null;
  }
  const intervalMs = getAuditSweepIntervalMs();
  if (intervalMs === 0) {
    deps.logger.info(
      '[auditRetention] In-process scheduler disabled by KNAUF_AUDIT_SWEEP_INTERVAL_MS=0 (run sweepOnce.js from a CronJob)',
    );
    return null;
  }
  const dryRun = isAuditSweepDryRun();
  deps.logger.info(
    `[auditRetention] Enabled: ${retentionDays}d retention, ${intervalMs}ms interval, dryRun=${dryRun}`,
  );

  let isSweeping = false;
  const runSweep = async () => {
    if (isSweeping) return;
    isSweeping = true;
    try {
      await deps.runAsSystem(() => deps.sweepAuditRetention({ retentionDays, dryRun }));
    } catch (error) {
      deps.logger.error('[auditRetention] Background sweep failed:', error);
    } finally {
      isSweeping = false;
    }
  };
  void runSweep();
  const timer = setInterval(runSweep, intervalMs);
  timer.unref?.();
  return timer;
}
// End [knauf]

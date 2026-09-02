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
// The heavy lifting already existed: `purgeAuditLogEntries` is chain-safe (it
// translates the date into a contiguous `seq` prefix so clock skew can never punch
// a hole mid-chain) and gated on `confirm`. What was missing is a caller — and a
// place to keep the checkpoint it mints, without which `verifyAuditChain` reports
// `ok: false` on every purged chain.
//
// Ships INERT: with no retention configured this module does nothing at all.
import type { AuditCheckpoint } from '@librechat/data-schemas';

/** 12 months — the §3.4 recommendation, used only once retention is switched on. */
export const DEFAULT_AUDIT_RETENTION_DAYS: number = 365;
/** Six hours. The log is low-volume (admin/security events), so this is about
 *  bounding lag after a period change, not about throughput. */
export const DEFAULT_AUDIT_SWEEP_INTERVAL_MS: number = 6 * 60 * 60 * 1000;

/** One audit scope to sweep. `tenantId` is undefined for the platform chain;
 *  `scopeKey` is the stable key used for the checkpoint store and for logs. */
export interface AuditScope {
  scopeKey: string;
  tenantId?: string;
}

export interface AuditPurgeOutcome {
  scopeKey: string;
  /** Rows actually removed. Always 0 in a dry run. */
  deletedCount: number;
  /** Dry-run only: rows older than the cutoff. An estimate — the real purge
   *  deletes a contiguous `seq` prefix and may retain a few extra rows under
   *  clock skew, so this is an upper bound, never an undercount. */
  wouldDelete?: number;
  checkpointAdvanced: boolean;
  /** True when the purge emptied the chain and the stale boundary was dropped. */
  checkpointCleared?: boolean;
}

export interface AuditRetentionSweepResult {
  /** False when retention is unset — the sweep did not run at all. */
  enabled: boolean;
  dryRun: boolean;
  cutoff?: Date;
  chains: AuditPurgeOutcome[];
  totalDeleted: number;
  /** Dry-run only: total rows a real run would remove. */
  totalWouldDelete?: number;
}

export interface AuditRetentionSweepDependencies {
  listAuditScopes(): Promise<AuditScope[]>;
  purgeScope(
    scope: AuditScope,
    options: { before: Date; confirm: boolean },
  ): Promise<{ deletedCount: number; checkpoint?: AuditCheckpoint }>;
  advanceCheckpoint(params: {
    scopeKey: string;
    checkpoint: AuditCheckpoint;
    purgedAt: Date;
    deletedCount: number;
  }): Promise<void>;
  /** Drop a scope's boundary after a purge emptied its chain — see the sweep. */
  clearCheckpoint(scopeKey: string): Promise<void>;
  /** Rows older than `before` for a scope. Used only in dry-run: the upstream
   *  purge short-circuits on `confirm:false` and reports 0, so without this a dry
   *  run could never tell an operator what enabling deletion would remove. */
  countPurgeable(scope: AuditScope, before: Date): Promise<number>;
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

/**
 * One pass over every audit chain. A chain that throws is logged and skipped so a
 * single bad chain cannot stall retention for the rest — the next pass retries it.
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

  const cutoff = computeAuditCutoff(deps.now(), retentionDays);
  const scopes = await deps.listAuditScopes();
  const chains: AuditPurgeOutcome[] = [];
  let totalDeleted = 0;
  let totalWouldDelete = 0;

  for (const scope of scopes) {
    try {
      /* `confirm: false` makes the upstream purge a no-op that reports nothing, so
       * a dry run cannot delete even if everything below is wrong. */
      /* A dry run cannot learn anything from the purge itself: upstream returns
       * `{ deletedCount: 0 }` on its first line when `confirm` is false. Count
       * separately so "read the counts, then enable" is a real workflow. */
      if (dryRun) {
        const wouldDelete = await deps.countPurgeable(scope, cutoff);
        totalWouldDelete += wouldDelete;
        chains.push({
          scopeKey: scope.scopeKey,
          deletedCount: 0,
          wouldDelete,
          checkpointAdvanced: false,
        });
        continue;
      }

      const result = await deps.purgeScope(scope, { before: cutoff, confirm: true });
      const deletedCount = result.deletedCount ?? 0;
      let checkpointAdvanced = false;
      let checkpointCleared = false;

      /* Upstream only mints a checkpoint when rows actually went away — a no-op
       * purge returning one would let a caller legitimize a prefix it never
       * authorized. Persist it before counting the purge as done: if this throws,
       * the rows are gone but the boundary is not recorded, and verification
       * would report a break. Logged loudly for exactly that reason. */
      if (result.checkpoint && deletedCount > 0) {
        await deps.advanceCheckpoint({
          scopeKey: scope.scopeKey,
          checkpoint: result.checkpoint,
          purgedAt: deps.now(),
          deletedCount,
        });
        checkpointAdvanced = true;
      } else if (deletedCount > 0) {
        /* Rows went but no checkpoint came back: the purge emptied the chain.
         * `recordAuditEntry` restarts an empty chain at seq 1 from GENESIS, which
         * verifies on its own — but a leftover far-ahead boundary would fail the
         * forward-only advance guard on every later purge and pin this scope at
         * ok:false forever. Drop it. */
        await deps.clearCheckpoint(scope.scopeKey);
        checkpointCleared = true;
      }

      totalDeleted += deletedCount;
      chains.push({
        scopeKey: scope.scopeKey,
        deletedCount,
        checkpointAdvanced,
        checkpointCleared,
      });
    } catch (error) {
      deps.logger.error('[auditRetention] scope sweep failed', { scopeKey: scope.scopeKey, error });
    }
  }

  if (totalDeleted > 0 || dryRun) {
    deps.logger.info('[auditRetention] sweep complete', {
      dryRun,
      retentionDays,
      cutoff: cutoff.toISOString(),
      chains: chains.length,
      totalDeleted,
      ...(dryRun ? { totalWouldDelete } : {}),
    });
  }

  return {
    enabled: true,
    dryRun,
    cutoff,
    chains,
    totalDeleted,
    ...(dryRun ? { totalWouldDelete } : {}),
  };
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
 * Start the periodic sweep, or return null when it should not run. Mirrors
 * `startExpiredFileSweep`: an `isSweeping` guard so a slow pass cannot overlap
 * itself, and an unref'd timer so it never holds the process open.
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
    deps.logger.info('[auditRetention] Disabled by KNAUF_AUDIT_SWEEP_INTERVAL_MS=0');
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

import { randomUUID } from 'node:crypto';
import { parseBlobPath } from './filesRepo.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FilesRepo } from './filesRepo.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../middleware/metrics.js';

export interface BlobReaperResult {
  scanned: number;
  deleted: number;
  skipped: number;
  failed: number;
  active: number;
  expired: number;
  orphan: number;
  stale: number;
}

export interface ReconciliationResult {
  pages: number;
  scanned: number;
  repaired: number;
  deleted: number;
  failed: number;
  completed: boolean;
  continuation: boolean;
}

export interface Reaper {
  start(): void;
  runOnce(): Promise<BlobReaperResult>;
  reconcileOnce(): Promise<ReconciliationResult>;
  stop(): Promise<void>;
}

export interface ReaperDeps {
  blob: BlobStore;
  repo: FilesRepo;
  logger: Logger;
  metrics: Metrics;
  ttlHours: number;
  intervalMs: number;
  leaseMs: number;
  reconciliationIntervalMs: number;
  reconciliationPageSize: number;
  reconciliationMaxPages: number;
  reconciliationMaxMs: number;
  now?: () => number;
  ownerId?: string;
}

function emptyBlobResult(): BlobReaperResult {
  return {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    active: 0,
    expired: 0,
    orphan: 0,
    stale: 0,
  };
}

function emptyReconciliationResult(): ReconciliationResult {
  return {
    pages: 0,
    scanned: 0,
    repaired: 0,
    deleted: 0,
    failed: 0,
    completed: false,
    continuation: false,
  };
}

export function createReaper(deps: ReaperDeps): Reaper {
  const now = deps.now ?? Date.now;
  const ownerId = deps.ownerId ?? randomUUID();
  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;
  let stopped = false;
  let leaseHeld = false;
  let leaseRenewAt = 0;
  let nextBlobPassAt = 0;
  let nextReconciliationAt = 0;

  const recordBlobResult = (result: BlobReaperResult, durationMs: number): void => {
    const outcome = result.failed === 0 ? 'success' : 'partial';
    deps.metrics.cleanupRuns.inc({ pass: 'blob', outcome });
    deps.metrics.cleanupDuration.observe({ pass: 'blob', outcome }, durationMs / 1000);
    for (const key of [
      'scanned',
      'deleted',
      'skipped',
      'failed',
      'active',
      'expired',
      'orphan',
      'stale',
    ] as const) {
      if (result[key] > 0) {
        deps.metrics.cleanupEntities.inc({ pass: 'blob', outcome: key }, result[key]);
      }
    }
    if (result.failed === 0) {
      deps.metrics.cleanupLastSuccess.set({ pass: 'blob' }, Math.floor(now() / 1000));
    }
  };

  const recordReconciliationResult = (
    result: ReconciliationResult,
    durationMs: number,
  ): void => {
    const outcome = result.failed === 0 ? 'success' : 'partial';
    deps.metrics.cleanupRuns.inc({ pass: 'reconciliation', outcome });
    deps.metrics.cleanupDuration.observe(
      { pass: 'reconciliation', outcome },
      durationMs / 1000,
    );
    for (const key of ['scanned', 'repaired', 'deleted', 'failed', 'pages'] as const) {
      if (result[key] > 0) {
        deps.metrics.cleanupEntities.inc(
          { pass: 'reconciliation', outcome: key },
          result[key],
        );
      }
    }
    if (result.failed === 0) {
      deps.metrics.cleanupLastSuccess.set(
        { pass: 'reconciliation' },
        Math.floor(now() / 1000),
      );
    }
  };

  const hasLease = async (): Promise<boolean> => {
    if (stopped || !leaseHeld) {
      return false;
    }
    if (now() < leaseRenewAt) {
      return true;
    }
    try {
      leaseHeld = await deps.repo.acquireCleanupLease(ownerId, deps.leaseMs);
      if (leaseHeld) {
        leaseRenewAt = now() + Math.floor(deps.leaseMs / 3);
      }
      return leaseHeld;
    } catch (error) {
      leaseHeld = false;
      deps.logger.warn({ err: (error as Error).message }, 'cleanup lease validation failed');
      return false;
    }
  };

  const runBlobPass = async (requireLease: boolean): Promise<BlobReaperResult> => {
    const startedAt = now();
    const result = emptyBlobResult();
    const minAgeMs = deps.ttlHours * 3_600_000 + 3_600_000;

    try {
      for await (const blob of deps.blob.list()) {
        result.scanned += 1;
        if (requireLease && !(await hasLease())) {
          result.failed += 1;
          break;
        }
        if (blob.createdOn == null) {
          result.skipped += 1;
          deps.logger.warn('reaper skipped a Blob without a creation timestamp');
          continue;
        }
        if (now() - blob.createdOn.getTime() < minAgeMs) {
          result.skipped += 1;
          continue;
        }
        if (parseBlobPath(blob.name) == null) {
          result.skipped += 1;
          deps.logger.warn('reaper skipped an unrecognised Blob path');
          continue;
        }

        try {
          const lookup = await deps.repo.lookupBlob(blob.name);
          if (lookup.state === 'active') {
            result.active += 1;
            result.skipped += 1;
            continue;
          }
          if (lookup.state === 'expired') {
            result.expired += 1;
            const committedPath = await deps.repo.deleteExpired(lookup.revision);
            if (committedPath == null) {
              result.skipped += 1;
              continue;
            }
            await deps.blob.delete(committedPath);
            result.deleted += 1;
            continue;
          }

          result[lookup.state] += 1;
          if (!lookup.safeToDelete) {
            result.skipped += 1;
            continue;
          }
          await deps.blob.delete(blob.name);
          result.deleted += 1;
        } catch (error) {
          result.failed += 1;
          deps.logger.warn({ err: (error as Error).message }, 'Blob reaper item failed');
        }
      }
    } finally {
      recordBlobResult(result, now() - startedAt);
    }
    return result;
  };

  const runReconciliation = async (
    requireLease: boolean,
  ): Promise<ReconciliationResult> => {
    const startedAt = now();
    const result = emptyReconciliationResult();
    let cursor;
    try {
      cursor = await deps.repo.readReconciliationCursor();
    } catch (error) {
      result.failed += 1;
      deps.logger.warn(
        { err: (error as Error).message },
        'metadata reconciliation cursor is invalid',
      );
      recordReconciliationResult(result, now() - startedAt);
      return result;
    }

    let continuation = cursor.token;
    let cursorEtag = cursor.etag;
    try {
      while (
        result.pages < deps.reconciliationMaxPages &&
        now() - startedAt < deps.reconciliationMaxMs
      ) {
        if (requireLease && !(await hasLease())) {
          result.failed += 1;
          break;
        }

        let page;
        try {
          page = await deps.repo.listReconciliationPage(
            continuation,
            deps.reconciliationPageSize,
          );
        } catch (error) {
          result.failed += 1;
          deps.logger.warn(
            { err: (error as Error).message },
            'metadata reconciliation page failed',
          );
          break;
        }

        result.pages += 1;
        for (const entity of page.entities) {
          result.scanned += 1;
          if (requireLease && !(await hasLease())) {
            result.failed += 1;
            break;
          }
          try {
            const outcome = await deps.repo.reconcileEntity(entity);
            if (outcome.outcome === 'repaired') {
              result.repaired += 1;
            } else if (outcome.outcome === 'deleted') {
              try {
                await deps.blob.delete(outcome.blobPath);
                result.deleted += 1;
              } catch (error) {
                result.failed += 1;
                deps.logger.warn(
                  { err: (error as Error).message },
                  'reconciliation Blob delete failed',
                );
              }
            }
          } catch (error) {
            result.failed += 1;
            deps.logger.warn(
              { err: (error as Error).message },
              'metadata reconciliation entity failed',
            );
          }
        }
        if (requireLease && !leaseHeld) {
          break;
        }

        continuation = page.continuationToken;
        try {
          await deps.repo.saveReconciliationCursor(continuation, cursorEtag);
          const saved = await deps.repo.readReconciliationCursor();
          cursorEtag = saved.etag;
        } catch (error) {
          result.failed += 1;
          deps.logger.warn(
            { err: (error as Error).message },
            'metadata reconciliation cursor update failed',
          );
          break;
        }
        if (continuation == null) {
          result.completed = true;
          break;
        }
      }
    } finally {
      result.continuation = continuation != null;
      recordReconciliationResult(result, now() - startedAt);
    }
    return result;
  };

  const schedulerTick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    let acquired = false;
    try {
      acquired = await deps.repo.acquireCleanupLease(ownerId, deps.leaseMs);
    } catch (error) {
      leaseHeld = false;
      deps.metrics.cleanupRuns.inc({ pass: 'lease', outcome: 'error' });
      deps.logger.warn({ err: (error as Error).message }, 'cleanup lease acquisition failed');
      return;
    }
    if (!acquired) {
      if (leaseHeld) {
        deps.metrics.cleanupRuns.inc({ pass: 'lease', outcome: 'lost' });
        deps.logger.warn('cleanup lease lost');
      }
      leaseHeld = false;
      return;
    }
    const newlyAcquired = !leaseHeld;
    leaseHeld = true;
    leaseRenewAt = now() + Math.floor(deps.leaseMs / 3);
    if (newlyAcquired) {
      deps.metrics.cleanupRuns.inc({ pass: 'lease', outcome: 'acquired' });
      nextBlobPassAt = 0;
      nextReconciliationAt = 0;
    }

    const current = now();
    if (current >= nextBlobPassAt) {
      await runBlobPass(true);
      nextBlobPassAt = now() + deps.intervalMs;
    }
    if (current >= nextReconciliationAt) {
      await runReconciliation(true);
      nextReconciliationAt = now() + deps.reconciliationIntervalMs;
    }
  };

  const triggerTick = (): void => {
    if (activeRun != null || stopped) {
      return;
    }
    activeRun = schedulerTick().finally(() => {
      activeRun = null;
    });
  };

  return {
    start() {
      if (timer != null || stopped) {
        return;
      }
      triggerTick();
      timer = setInterval(triggerTick, Math.max(1_000, Math.floor(deps.leaseMs / 3)));
      timer.unref();
    },
    runOnce: () => runBlobPass(false),
    reconcileOnce: () => runReconciliation(false),
    async stop() {
      stopped = true;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      await activeRun;
      if (leaseHeld) {
        await deps.repo.releaseCleanupLease(ownerId).catch((error: Error) => {
          deps.logger.warn({ err: error.message }, 'cleanup lease release failed');
        });
        leaseHeld = false;
      }
    },
  };
}

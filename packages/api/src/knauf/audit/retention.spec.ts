// [knauf] KK20-328 — seam test for the audit-retention sweep.
import {
  getAuditRetentionDays,
  getAuditSweepIntervalMs,
  isAuditSweepDryRun,
  computeAuditCutoff,
  sweepAuditRetention,
  startAuditRetentionSweep,
  DEFAULT_AUDIT_SWEEP_INTERVAL_MS,
} from './retention';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const NOW = new Date('2027-01-01T00:00:00.000Z');

function makeDeps(overrides: Partial<Parameters<typeof sweepAuditRetention>[1]> = {}) {
  return {
    listAuditScopes: jest.fn(async () => [
      { scopeKey: '__platform__', tenantId: undefined },
      { scopeKey: 'abc', tenantId: 'abc' },
    ]),
    purgeScope: jest.fn(async () => ({ deletedCount: 0 })),
    advanceCheckpoint: jest.fn(async () => undefined),
    clearCheckpoint: jest.fn(async () => undefined),
    countPurgeable: jest.fn(async () => 4),
    now: () => NOW,
    logger: silentLogger,
    ...overrides,
  } as Parameters<typeof sweepAuditRetention>[1];
}

beforeEach(() => jest.clearAllMocks());

describe('configuration — safe by default', () => {
  it('treats unset/blank/zero/invalid retention as disabled, never as a default', () => {
    // The 365-day recommendation is NOT a fallback: a retention period is a DPO
    // decision, and silently adopting one because an env var was missing is how a
    // deletion job destroys data nobody agreed to delete.
    for (const raw of [undefined, '', '   ', '0', '-1', 'abc', 'NaN']) {
      expect(getAuditRetentionDays(raw)).toBeUndefined();
    }
    expect(getAuditRetentionDays('365')).toBe(365);
  });

  it('defaults dry-run ON so enabling retention still deletes nothing', () => {
    for (const raw of [undefined, '', 'true', 'TRUE', 'anything']) {
      expect(isAuditSweepDryRun(raw)).toBe(true);
    }
    expect(isAuditSweepDryRun('false')).toBe(false);
    expect(isAuditSweepDryRun('FALSE')).toBe(false);
  });

  it('falls back to the default interval on junk, and honours 0 as disable', () => {
    expect(getAuditSweepIntervalMs(undefined)).toBe(DEFAULT_AUDIT_SWEEP_INTERVAL_MS);
    expect(getAuditSweepIntervalMs('abc')).toBe(DEFAULT_AUDIT_SWEEP_INTERVAL_MS);
    expect(getAuditSweepIntervalMs('-5')).toBe(DEFAULT_AUDIT_SWEEP_INTERVAL_MS);
    expect(getAuditSweepIntervalMs('0')).toBe(0);
  });

  it('computes the cutoff as now minus the retention window', () => {
    expect(computeAuditCutoff(NOW, 365).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sweep', () => {
  it('does nothing at all when retention is unset — the inert default', async () => {
    const deps = makeDeps();
    const result = await sweepAuditRetention({ retentionDays: undefined }, deps);

    expect(result.enabled).toBe(false);
    expect(deps.listAuditScopes).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
  });

  it('dry-run never calls the purge at all and reports would-delete counts', async () => {
    // Upstream short-circuits on `confirm:false` and returns 0, so asking it during
    // a dry run tells an operator nothing. Count separately instead, or "read the
    // counts, then enable" is a workflow that cannot actually be followed.
    const deps = makeDeps();
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: true }, deps);

    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(deps.advanceCheckpoint).not.toHaveBeenCalled();
    expect(deps.clearCheckpoint).not.toHaveBeenCalled();
    expect(deps.countPurgeable).toHaveBeenCalledTimes(2);
    expect(result.totalWouldDelete).toBe(8);
    expect(result.totalDeleted).toBe(0);
    expect(result.chains.every((c) => c.wouldDelete === 4)).toBe(true);
  });

  it('sweeps every scope including the platform chain', async () => {
    const deps = makeDeps();
    await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    const scopes = (deps.purgeScope as jest.Mock).mock.calls.map((c) => c[0]);
    expect(scopes).toEqual([
      { scopeKey: '__platform__', tenantId: undefined },
      { scopeKey: 'abc', tenantId: 'abc' },
    ]);
    expect((deps.purgeScope as jest.Mock).mock.calls[0][1].before.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('persists the checkpoint when rows were deleted — without it, verification breaks', async () => {
    const checkpoint = { throughSeq: 41, prevHash: 'abc123' };
    const deps = makeDeps({
      listAuditScopes: jest.fn(async () => [{ scopeKey: 'abc', tenantId: 'abc' }]),
      purgeScope: jest.fn(async () => ({ deletedCount: 7, checkpoint })),
    });

    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    expect(deps.advanceCheckpoint).toHaveBeenCalledWith({
      scopeKey: 'abc',
      checkpoint,
      purgedAt: NOW,
      deletedCount: 7,
    });
    expect(result.totalDeleted).toBe(7);
    expect(result.chains[0].checkpointAdvanced).toBe(true);
  });

  it('does not persist a checkpoint when nothing was deleted', async () => {
    // A no-op purge that still minted a boundary would let a caller legitimize a
    // prefix this purge never authorized — e.g. one an attacker removed.
    const deps = makeDeps({
      listAuditScopes: jest.fn(async () => [{ scopeKey: 'abc', tenantId: 'abc' }]),
      purgeScope: jest.fn(async () => ({
        deletedCount: 0,
        checkpoint: { throughSeq: 9, prevHash: 'x' },
      })),
    });

    await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.advanceCheckpoint).not.toHaveBeenCalled();
  });

  it('clears the boundary when a purge empties the chain', async () => {
    // Rows deleted but no checkpoint returned means the chain is now empty.
    // `recordAuditEntry` restarts an empty chain at seq 1 from GENESIS, which
    // verifies alone — but a leftover far-ahead boundary would fail the
    // forward-only advance guard on every later purge and pin the scope at
    // ok:false with no self-heal.
    const deps = makeDeps({
      listAuditScopes: jest.fn(async () => [{ scopeKey: 'scope:tenant:abc', tenantId: 'abc' }]),
      purgeScope: jest.fn(async () => ({ deletedCount: 12, checkpoint: undefined })),
    });

    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    expect(deps.clearCheckpoint).toHaveBeenCalledWith('scope:tenant:abc');
    expect(deps.advanceCheckpoint).not.toHaveBeenCalled();
    expect(result.chains[0].checkpointCleared).toBe(true);
    expect(result.totalDeleted).toBe(12);
  });

  it('does not clear the boundary when nothing was deleted', async () => {
    const deps = makeDeps({
      listAuditScopes: jest.fn(async () => [{ scopeKey: 'scope:tenant:abc', tenantId: 'abc' }]),
      purgeScope: jest.fn(async () => ({ deletedCount: 0 })),
    });

    await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.clearCheckpoint).not.toHaveBeenCalled();
  });

  it('a failing scope is skipped, not fatal — the rest still sweep', async () => {
    const deps = makeDeps({
      listAuditScopes: jest.fn(async () => [
        { scopeKey: 'bad', tenantId: 'bad' },
        { scopeKey: 'good', tenantId: 'good' },
      ]),
      purgeScope: jest.fn(async (scope: { scopeKey: string }) => {
        if (scope.scopeKey === 'bad') throw new Error('boom');
        return { deletedCount: 3, checkpoint: { throughSeq: 2, prevHash: 'h' } };
      }),
    });

    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    expect(result.totalDeleted).toBe(3);
    expect(result.chains.map((c) => c.scopeKey)).toEqual(['good']);
    expect(silentLogger.error).toHaveBeenCalled();
  });
});

describe('scheduler', () => {
  const startDeps = (over = {}) =>
    ({
      sweepAuditRetention: jest.fn(async () => ({
        enabled: true,
        dryRun: true,
        chains: [],
        totalDeleted: 0,
      })),
      runAsSystem: jest.fn(async (fn: () => Promise<unknown>) => fn()),
      logger: silentLogger,
      ...over,
    }) as Parameters<typeof startAuditRetentionSweep>[0];

  afterEach(() => {
    delete process.env.KNAUF_AUDIT_RETENTION_DAYS;
    delete process.env.KNAUF_AUDIT_SWEEP_INTERVAL_MS;
  });

  it('returns null and never sweeps when retention is unset', () => {
    const deps = startDeps();
    expect(startAuditRetentionSweep(deps)).toBeNull();
    expect(deps.sweepAuditRetention).not.toHaveBeenCalled();
  });

  it('returns null when the interval is explicitly 0', () => {
    process.env.KNAUF_AUDIT_RETENTION_DAYS = '365';
    process.env.KNAUF_AUDIT_SWEEP_INTERVAL_MS = '0';
    const deps = startDeps();
    expect(startAuditRetentionSweep(deps)).toBeNull();
    expect(deps.sweepAuditRetention).not.toHaveBeenCalled();
  });

  it('runs an immediate pass under runAsSystem and returns an unref-ed timer', async () => {
    process.env.KNAUF_AUDIT_RETENTION_DAYS = '365';
    process.env.KNAUF_AUDIT_SWEEP_INTERVAL_MS = '60000';
    const deps = startDeps();

    const timer = startAuditRetentionSweep(deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(timer).not.toBeNull();
    expect(deps.runAsSystem).toHaveBeenCalled();
    expect(deps.sweepAuditRetention).toHaveBeenCalledWith({ retentionDays: 365, dryRun: true });
    if (timer) clearInterval(timer);
  });
});
// End [knauf]

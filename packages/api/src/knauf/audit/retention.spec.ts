// [knauf] KK20-328 — seam test for the audit-retention sweep (pure logic, injected deps).
// The ledger's own behaviour (recovery, fencing, leases, signatures, never emptying a
// chain) is covered against a real Mongo in packages/data-schemas/src/knauf/audit/
// checkpoint.spec.ts; this spec pins how the sweep DRIVES it: recover first, announce
// before delete, re-confirm the lease, delete bounded by the boundary, finalize after,
// fence every write, abort on lease loss or stale fence, dry run read-only, inert default.
import {
  getAuditRetentionDays,
  getAuditSweepIntervalMs,
  getAuditSweepLeaseMs,
  isAuditSweepDryRun,
  computeAuditCutoff,
  sweepAuditRetention,
  startAuditRetentionSweep,
  DEFAULT_AUDIT_SWEEP_INTERVAL_MS,
  DEFAULT_AUDIT_SWEEP_LEASE_MS,
} from './retention';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const NOW = new Date('2027-01-01T00:00:00.000Z');
const PURGE_BEFORE = new Date('2026-01-01T00:00:00.000Z');
const BOUNDARY = { throughSeq: 10, prevHash: 'h10', purgeBefore: PURGE_BEFORE };
const COMMITTED = {
  action: 'committed',
  boundary: { throughSeq: 10, prevHash: 'h10' },
  recovered: false,
} as const;
const NO_PENDING = { action: 'none', reason: 'no-pending' } as const;

type Deps = Parameters<typeof sweepAuditRetention>[1];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const lease = {
    owner: 'me',
    ttlMs: 60_000,
    minGapMs: 0,
    acquire: jest.fn(async () => ({ ok: true as const, fence: 7 })),
    renew: jest.fn(async () => true),
    release: jest.fn(async () => undefined),
  };
  return {
    listAuditScopes: jest.fn(async () => [
      { scopeKey: '__platform__', tenantId: undefined },
      { scopeKey: 'tenant:abc', tenantId: 'abc' },
    ]),
    computeBoundary: jest.fn(async () => BOUNDARY),
    beginPurge: jest.fn(async () => true),
    purgeScope: jest.fn(async () => ({ deletedCount: 10 })),
    finalizePurge: jest.fn(async ({ recovered }) => (recovered ? NO_PENDING : COMMITTED)),
    countPurgeable: jest.fn(async () => 4),
    lease,
    now: () => NOW,
    logger: silentLogger,
    ...overrides,
  } as Deps;
}

/** Order of calls across all mocks, by name — the invariant under test. */
function callOrder(deps: Deps): string[] {
  const named: Array<[string, jest.Mock]> = [
    ['acquire', deps.lease.acquire as jest.Mock],
    ['computeBoundary', deps.computeBoundary as jest.Mock],
    ['beginPurge', deps.beginPurge as jest.Mock],
    ['renew', deps.lease.renew as jest.Mock],
    ['purgeScope', deps.purgeScope as jest.Mock],
    ['finalizePurge', deps.finalizePurge as jest.Mock],
    ['release', deps.lease.release as jest.Mock],
  ];
  return named
    .flatMap(([name, m]) => m.mock.invocationCallOrder.map((o) => [o, name] as [number, string]))
    .sort((a, b) => a[0] - b[0])
    .map(([, name]) => name);
}

beforeEach(() => jest.clearAllMocks());

describe('configuration — safe by default', () => {
  it('treats unset/blank/zero/invalid retention as disabled, never as a default', () => {
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

  it('lease TTL falls back to the default below the 30 s floor or on junk', () => {
    expect(getAuditSweepLeaseMs(undefined)).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
    expect(getAuditSweepLeaseMs('1000')).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS); // heartbeat would equal TTL
    expect(getAuditSweepLeaseMs('29999')).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
    expect(getAuditSweepLeaseMs('abc')).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
    expect(getAuditSweepLeaseMs('30000')).toBe(30_000);
    expect(getAuditSweepLeaseMs('120000')).toBe(120_000);
  });

  it('computes the cutoff as now minus the retention window', () => {
    expect(computeAuditCutoff(NOW, 365).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sweep', () => {
  it('does nothing at all when retention is unset — not even the lease', async () => {
    const deps = makeDeps();
    const result = await sweepAuditRetention({ retentionDays: undefined }, deps);
    expect(result).toEqual({ enabled: false, dryRun: true, chains: [], totalDeleted: 0 });
    expect(deps.lease.acquire).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
  });

  it('skips the whole pass when another replica holds the lease, or a pass just completed', async () => {
    const deps = makeDeps();
    (deps.lease.acquire as jest.Mock).mockResolvedValue({ ok: false, reason: 'held' });
    expect((await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps)).skipped).toBe(
      'lease-held',
    );
    (deps.lease.acquire as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'recently-completed',
    });
    expect((await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps)).skipped).toBe(
      'recently-completed',
    );
    expect(deps.listAuditScopes).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(deps.lease.release).not.toHaveBeenCalled();
  });

  it('recovers, announces, re-confirms the lease, deletes bounded by the boundary, finalizes — inside the lease', async () => {
    const deps = makeDeps();
    (deps.listAuditScopes as jest.Mock).mockResolvedValue([
      { scopeKey: 'tenant:abc', tenantId: 'abc' },
    ]);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    expect(callOrder(deps)).toEqual([
      'acquire',
      'finalizePurge', // recovery of any leftover intent
      'computeBoundary',
      'beginPurge',
      'renew', // lease re-confirmed synchronously right before the only delete
      'purgeScope',
      'finalizePurge',
      'release',
    ]);
    expect(deps.beginPurge).toHaveBeenCalledWith({
      scopeKey: 'tenant:abc',
      boundary: BOUNDARY,
      cutoff: computeAuditCutoff(NOW, 365),
      now: NOW,
      fence: 7,
    });
    // the delete is bounded by the boundary's own `purgeBefore`, not the raw cutoff
    expect(deps.purgeScope).toHaveBeenCalledWith(
      { scopeKey: 'tenant:abc', tenantId: 'abc' },
      { before: PURGE_BEFORE, confirm: true },
    );
    expect(deps.finalizePurge).toHaveBeenLastCalledWith(
      expect.objectContaining({ fence: 7, deletedCount: 10 }),
    );
    expect(deps.lease.release).toHaveBeenCalledWith(7, NOW);
    expect(result.fence).toBe(7);
    expect(result.totalDeleted).toBe(10);
    expect(result.chains[0]).toEqual(
      expect.objectContaining({ deletedCount: 10, checkpointAdvanced: true }),
    );
  });

  it('dry-run is READ-ONLY: counts, and never announces, deletes, or even recovers (a ledger write)', async () => {
    const deps = makeDeps();
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: true }, deps);
    expect(deps.beginPurge).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(deps.computeBoundary).not.toHaveBeenCalled();
    expect(deps.finalizePurge).not.toHaveBeenCalled();
    expect(result.totalWouldDelete).toBe(8);
    expect(result.chains.every((c) => c.deletedCount === 0 && c.wouldDelete === 4)).toBe(true);
    expect(deps.lease.release).toHaveBeenCalledTimes(1);
  });

  it('a leftover intent from a crashed pass is finalized first and reported as recovered', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered
        ? { ...COMMITTED, boundary: { throughSeq: 4, prevHash: 'h4' }, recovered: true }
        : COMMITTED,
    );
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(result.chains[0].recoveredPending).toEqual(
      expect.objectContaining({ action: 'committed', recovered: true }),
    );
    expect(silentLogger.warn).toHaveBeenCalledWith(
      '[auditRetention] finalized a leftover purge intent',
      expect.objectContaining({ scopeKey: '__platform__' }),
    );
  });

  it('an untrusted leftover intent is logged at error level (forged intent, not a crash)', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered ? { action: 'dropped', reason: 'untrusted-intent' } : COMMITTED,
    );
    await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(silentLogger.error).toHaveBeenCalledWith(
      '[auditRetention] finalized a leftover purge intent',
      expect.objectContaining({
        recovered: expect.objectContaining({ reason: 'untrusted-intent' }),
      }),
    );
  });

  it('nothing to purge ⇒ no announce, no delete', async () => {
    const deps = makeDeps();
    (deps.computeBoundary as jest.Mock).mockResolvedValue(null);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.beginPurge).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(result.totalDeleted).toBe(0);
  });

  it('finalize failing after a delete leaves the intent for the next pass and logs loudly', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) => {
      if (recovered) return NO_PENDING;
      throw new Error('primary failover');
    });
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(silentLogger.error).toHaveBeenCalledWith(
      '[auditRetention] scope sweep failed',
      expect.objectContaining({ scopeKey: '__platform__' }),
    );
    expect(deps.lease.release).toHaveBeenCalledTimes(1);
    expect(result.chains).toHaveLength(0);
  });

  it('rows deleted but boundary not committed is an error, not silence', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered ? NO_PENDING : { action: 'dropped', reason: 'lost-race' },
    );
    await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(silentLogger.error).toHaveBeenCalledWith(
      '[auditRetention] rows deleted but boundary not committed',
      expect.anything(),
    );
  });

  it('a failing scope is skipped, not fatal — the rest still sweep and the lease is released', async () => {
    const deps = makeDeps();
    (deps.purgeScope as jest.Mock)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ deletedCount: 3 });
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(result.chains).toHaveLength(1);
    expect(result.totalDeleted).toBe(3);
    expect(deps.lease.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease even when listing scopes throws', async () => {
    const deps = makeDeps();
    (deps.listAuditScopes as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps)).rejects.toThrow(
      'db down',
    );
    expect(deps.lease.release).toHaveBeenCalledTimes(1);
  });
});

describe('lease loss and stale fences abort before any further deletion', () => {
  it('renewal refused right before a delete ⇒ that scope and all later scopes are NOT purged', async () => {
    const deps = makeDeps();
    (deps.lease.renew as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.purgeScope).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe('lease-lost');
    expect(result.chains).toHaveLength(1);
    expect(result.totalDeleted).toBe(10);
    expect(deps.lease.release).not.toHaveBeenCalled(); // not ours to release any more
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('lease lost'),
      expect.objectContaining({ fence: 7 }),
    );
  });

  it('renewal REJECTING (not just refusing) is handled and aborts the same way', async () => {
    const deps = makeDeps();
    (deps.lease.renew as jest.Mock).mockRejectedValue(new Error('primary stepped down'));
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(result.aborted).toBe('lease-lost');
  });

  it('the heartbeat marking the lease lost stops the pass before the next scope', async () => {
    jest.useFakeTimers();
    try {
      const deps = makeDeps({
        lease: {
          owner: 'me',
          ttlMs: 3000,
          minGapMs: 0,
          acquire: jest.fn(async () => ({ ok: true as const, fence: 1 })),
          renew: jest.fn(async () => false),
          release: jest.fn(async () => undefined),
        },
      });
      (deps.lease.renew as jest.Mock).mockResolvedValueOnce(true); // pre-delete check passes
      (deps.purgeScope as jest.Mock).mockImplementation(async () => {
        await jest.advanceTimersByTimeAsync(1100); // heartbeat fires mid-delete
        return { deletedCount: 10 };
      });
      const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
      expect(deps.purgeScope).toHaveBeenCalledTimes(1);
      expect(result.aborted).toBe('lease-lost');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a stale fence at announce means a higher fence holds the lease ⇒ abort, nothing deleted', async () => {
    const deps = makeDeps();
    (deps.beginPurge as jest.Mock).mockResolvedValueOnce(false);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(result.aborted).toBe('lease-lost');
    expect(result.chains).toHaveLength(0);
    expect(deps.lease.release).not.toHaveBeenCalled();
  });

  it('a stale fence discovered during recovery, or at commit, aborts before any (further) delete', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered ? { action: 'dropped', reason: 'stale-fence' } : COMMITTED,
    );
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(deps.beginPurge).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(result.aborted).toBe('lease-lost');

    const deps2 = makeDeps();
    (deps2.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered ? NO_PENDING : { action: 'dropped', reason: 'stale-fence' },
    );
    const result2 = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps2);
    expect(deps2.purgeScope).toHaveBeenCalledTimes(1); // first scope's delete had already run
    expect(result2.aborted).toBe('lease-lost');
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

  it('returns null when the interval is explicitly 0 (CronJob mode)', () => {
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

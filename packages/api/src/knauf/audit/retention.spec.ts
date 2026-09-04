// [knauf] KK20-328 — seam test for the audit-retention sweep (pure logic, injected deps).
// The ledger's own behaviour (recovery, generations, races, leases, signatures) is
// covered against a real Mongo in packages/data-schemas/src/knauf/audit/checkpoint.spec.ts;
// this spec pins how the sweep DRIVES it: announce before delete, finalize after,
// recover first, lease around the pass, inert by default.
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
const BOUNDARY = { throughSeq: 10, prevHash: 'h10', terminal: false };

type Deps = Parameters<typeof sweepAuditRetention>[1];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const lease = {
    owner: 'me',
    ttlMs: 60_000,
    acquire: jest.fn(async () => true),
    renew: jest.fn(async () => true),
    release: jest.fn(async () => undefined),
  };
  return {
    listAuditScopes: jest.fn(async () => [
      { scopeKey: '__platform__', tenantId: undefined },
      { scopeKey: 'scope:tenant:abc', tenantId: 'abc' },
    ]),
    computeBoundary: jest.fn(async () => BOUNDARY),
    beginPurge: jest.fn(async () => undefined),
    purgeScope: jest.fn(async () => ({ deletedCount: 10 })),
    finalizePurge: jest.fn(async ({ recovered }) =>
      recovered
        ? ({ action: 'none', reason: 'no-pending' } as const)
        : ({ action: 'committed', boundary: BOUNDARY, generation: 1, recovered: false } as const),
    ),
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

  it('lease TTL falls back to the default below one second or on junk', () => {
    expect(getAuditSweepLeaseMs(undefined)).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
    expect(getAuditSweepLeaseMs('500')).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
    expect(getAuditSweepLeaseMs('abc')).toBe(DEFAULT_AUDIT_SWEEP_LEASE_MS);
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

  it('skips the whole pass when another replica holds the lease', async () => {
    const deps = makeDeps();
    (deps.lease.acquire as jest.Mock).mockResolvedValue(false);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(result.skipped).toBe('lease-held');
    expect(deps.listAuditScopes).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(deps.lease.release).not.toHaveBeenCalled();
  });

  it('announces BEFORE deleting and finalizes AFTER, per scope, inside the lease', async () => {
    const deps = makeDeps();
    (deps.listAuditScopes as jest.Mock).mockResolvedValue([
      { scopeKey: 'scope:tenant:abc', tenantId: 'abc' },
    ]);
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);

    expect(callOrder(deps)).toEqual([
      'acquire',
      'finalizePurge', // recovery of any leftover intent
      'computeBoundary',
      'beginPurge',
      'purgeScope',
      'finalizePurge',
      'release',
    ]);
    expect(deps.beginPurge).toHaveBeenCalledWith({
      scopeKey: 'scope:tenant:abc',
      boundary: BOUNDARY,
      cutoff: computeAuditCutoff(NOW, 365),
      now: NOW,
    });
    expect(deps.purgeScope).toHaveBeenCalledWith(
      { scopeKey: 'scope:tenant:abc', tenantId: 'abc' },
      { before: computeAuditCutoff(NOW, 365), confirm: true },
    );
    expect(result.totalDeleted).toBe(10);
    expect(result.chains[0]).toEqual(
      expect.objectContaining({
        deletedCount: 10,
        checkpointAdvanced: true,
        generation: 1,
        terminal: false,
      }),
    );
  });

  it('dry-run recovers leftover intents and counts, but never announces or deletes', async () => {
    const deps = makeDeps();
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: true }, deps);
    expect(deps.beginPurge).not.toHaveBeenCalled();
    expect(deps.purgeScope).not.toHaveBeenCalled();
    expect(deps.computeBoundary).not.toHaveBeenCalled();
    expect(deps.finalizePurge).toHaveBeenCalledTimes(2); // recovery only, once per scope
    expect(result.totalWouldDelete).toBe(8);
    expect(result.chains.every((c) => c.deletedCount === 0 && c.wouldDelete === 4)).toBe(true);
  });

  it('a leftover intent from a crashed pass is finalized first and reported as recovered', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered
        ? {
            action: 'committed',
            boundary: { ...BOUNDARY, throughSeq: 4 },
            generation: 1,
            recovered: true,
          }
        : { action: 'committed', boundary: BOUNDARY, generation: 1, recovered: false },
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
      if (recovered) return { action: 'none', reason: 'no-pending' };
      throw new Error('primary failover');
    });
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    // the scope is skipped (logged), the other scope still sweeps, the lease is released
    expect(silentLogger.error).toHaveBeenCalledWith(
      '[auditRetention] scope sweep failed',
      expect.objectContaining({ scopeKey: '__platform__' }),
    );
    expect(deps.lease.release).toHaveBeenCalledTimes(1);
    expect(result.chains).toHaveLength(0);
  });

  it('a terminal commit is reported so operators can see a chain generation closed', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered
        ? { action: 'none', reason: 'no-pending' }
        : {
            action: 'committed',
            boundary: { ...BOUNDARY, terminal: true },
            generation: 1,
            recovered: false,
          },
    );
    const result = await sweepAuditRetention({ retentionDays: 365, dryRun: false }, deps);
    expect(result.chains[0]).toEqual(
      expect.objectContaining({ terminal: true, checkpointAdvanced: true }),
    );
  });

  it('rows deleted but boundary not committed is an error, not silence', async () => {
    const deps = makeDeps();
    (deps.finalizePurge as jest.Mock).mockImplementation(async ({ recovered }) =>
      recovered
        ? { action: 'none', reason: 'no-pending' }
        : { action: 'dropped', reason: 'lost-race' },
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

// [knauf] KK20-328 — dependency binding for the audit-retention sweep.
//
// The pure logic lives in `@librechat/api` (packages/api/src/knauf/audit/retention.ts);
// the ledger (intent / CAS commit / recovery / lease) lives in `@librechat/data-schemas`
// (packages/data-schemas/src/knauf/audit). This layer only wires real model access,
// because packages/api cannot import `~/models`. Everything here is Knauf-owned; the
// only upstream touch points are the two `start…()` calls in the server entrypoints.
const os = require('node:os');
const mongoose = require('mongoose');
const {
  logger,
  runAsSystem,
  PLATFORM_CHAIN_KEY,
  auditRetentionScopeKey,
} = require('@librechat/data-schemas');
const {
  sweepAuditRetention: sweepAuditRetentionWithDeps,
  startAuditRetentionSweep: startAuditRetentionSweepWithDeps,
  getAuditSweepLeaseMs,
  getAuditSweepIntervalMs,
  getAuditCheckpointSigningKeys,
} = require('@librechat/api');
const db = require('~/models');

const OWNER = `${os.hostname()}:${process.pid}`;

/**
 * Every audit scope that currently has entries, in ONE round trip: a `$group` on the
 * INDEXED `chainKey` with any row's stored `tenantId` (all rows of a chain share it).
 * The platform chain carries no tenantId and is matched via the exported sentinel.
 * Recomputed per pass so late-onboarded tenants sweep too. Because retention never
 * empties a chain, every scope that ever had rows still has at least one — so this
 * enumeration also reaches every scope that could hold a leftover intent.
 */
async function listAuditScopes() {
  const AuditLog = mongoose.models.AuditLog;
  if (!AuditLog) {
    return [];
  }
  const groups = await AuditLog.aggregate([
    { $group: { _id: '$chainKey', tenantId: { $first: '$tenantId' } } },
  ]);
  const scopes = [];
  for (const g of groups) {
    if (g._id === PLATFORM_CHAIN_KEY) {
      scopes.push({ scopeKey: auditRetentionScopeKey(undefined), tenantId: undefined });
    } else if (typeof g.tenantId === 'string' && g.tenantId.trim().length > 0) {
      scopes.push({ scopeKey: auditRetentionScopeKey(g.tenantId), tenantId: g.tenantId });
    }
  }
  return scopes;
}

function buildDeps({ oneShot = false } = {}) {
  const ttlMs = getAuditSweepLeaseMs();
  const intervalMs = getAuditSweepIntervalMs();
  return {
    listAuditScopes,
    computeBoundary: (scope, before) => db.computeAuditRetentionBoundary(scope.tenantId, before),
    /* Signed at begin with the key held outside Mongo; carries the lease fence. */
    beginPurge: ({ scopeKey, boundary, cutoff, now, fence }) =>
      db.beginAuditRetentionPurge({
        scopeKey,
        boundary,
        cutoff,
        now,
        fence,
        owner: OWNER,
        signingKeys: getAuditCheckpointSigningKeys(),
      }),
    purgeScope: (scope, purgeOptions) => db.purgeAuditLogEntries(scope.tenantId, purgeOptions),
    finalizePurge: ({ scope, fence, deletedCount, now, recovered }) =>
      db.finalizeAuditRetentionPurge({
        scopeKey: scope.scopeKey,
        tenantId: scope.tenantId,
        fence,
        deletedCount,
        now,
        recovered,
        signingKeys: getAuditCheckpointSigningKeys(),
      }),
    countPurgeable: (scope, before) => db.countAuditEntriesBefore(scope.tenantId, before),
    lease: {
      owner: OWNER,
      ttlMs,
      /* Half the cadence: ten replicas booting together run ONE pass, not ten. A
       * one-shot (CronJob) invocation is the schedule itself and never skips. */
      minGapMs: oneShot ? 0 : Math.floor(intervalMs / 2),
      acquire: (now) =>
        db.acquireAuditRetentionLease({
          owner: OWNER,
          ttlMs,
          now,
          minGapMs: oneShot ? 0 : Math.floor(intervalMs / 2),
        }),
      renew: (fence, now) => db.renewAuditRetentionLease({ owner: OWNER, fence, ttlMs, now }),
      release: (fence, now) => db.releaseAuditRetentionLease({ owner: OWNER, fence, now }),
    },
    now: () => new Date(),
    logger,
  };
}

async function sweepAuditRetention(options = {}, { oneShot = false } = {}) {
  return sweepAuditRetentionWithDeps(options, buildDeps({ oneShot }));
}

function startKnaufAuditRetentionSweep() {
  return startAuditRetentionSweepWithDeps({ sweepAuditRetention, runAsSystem, logger });
}

module.exports = { sweepAuditRetention, startKnaufAuditRetentionSweep };
// End [knauf]

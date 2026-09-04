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
} = require('@librechat/api');
const db = require('~/models');

const OWNER = `${os.hostname()}:${process.pid}`;

/**
 * Every audit scope that currently has entries. Enumerates the INDEXED `chainKey`
 * (four compound indexes) rather than `tenantId` (none), then reads the exact stored
 * tenant id off one entry — upstream's `tenant:` prefix is a private constant this
 * layer must not reconstruct. Platform entries carry no tenantId; they are matched
 * via the exported sentinel. Recomputed per pass so late-onboarded tenants sweep too.
 */
async function listAuditScopes() {
  const AuditLog = mongoose.models.AuditLog;
  if (!AuditLog) {
    return [];
  }
  const chainKeys = await AuditLog.distinct('chainKey');
  const scopes = [];
  for (const chainKey of chainKeys) {
    if (chainKey === PLATFORM_CHAIN_KEY) {
      scopes.push({ scopeKey: auditRetentionScopeKey(undefined), tenantId: undefined });
      continue;
    }
    const sample = await AuditLog.findOne({ chainKey }).select('tenantId').lean();
    const tenantId = sample?.tenantId;
    if (typeof tenantId === 'string' && tenantId.trim().length > 0) {
      scopes.push({ scopeKey: auditRetentionScopeKey(tenantId), tenantId });
    }
  }
  return scopes;
}

function signingKey() {
  const key = process.env.KNAUF_AUDIT_CHECKPOINT_HMAC_KEY;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function buildDeps() {
  const ttlMs = getAuditSweepLeaseMs();
  return {
    listAuditScopes,
    computeBoundary: (scope, before) => db.computeAuditRetentionBoundary(scope.tenantId, before),
    beginPurge: db.beginAuditRetentionPurge,
    purgeScope: (scope, purgeOptions) => db.purgeAuditLogEntries(scope.tenantId, purgeOptions),
    finalizePurge: ({ scope, deletedCount, now, recovered }) =>
      db.finalizeAuditRetentionPurge({
        scopeKey: scope.scopeKey,
        tenantId: scope.tenantId,
        deletedCount,
        now,
        recovered,
        signingKey: signingKey(),
      }),
    countPurgeable: (scope, before) => db.countAuditEntriesBefore(scope.tenantId, before),
    lease: {
      owner: OWNER,
      ttlMs,
      acquire: (now) => db.acquireAuditRetentionLease({ owner: OWNER, ttlMs, now }),
      renew: (now) => db.renewAuditRetentionLease({ owner: OWNER, ttlMs, now }),
      release: () => db.releaseAuditRetentionLease({ owner: OWNER }),
    },
    now: () => new Date(),
    logger,
  };
}

async function sweepAuditRetention(options = {}) {
  return sweepAuditRetentionWithDeps(options, buildDeps());
}

function startKnaufAuditRetentionSweep() {
  return startAuditRetentionSweepWithDeps({ sweepAuditRetention, runAsSystem, logger });
}

module.exports = {
  OWNER,
  listAuditScopes,
  buildDeps,
  sweepAuditRetention,
  startKnaufAuditRetentionSweep,
};
// End [knauf]

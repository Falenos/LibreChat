// [knauf] KK20-328 — dependency binding for the audit-retention sweep.
//
// The pure logic lives in `@librechat/api` (packages/api/src/knauf/audit/retention.ts);
// this layer supplies real model/method access, because packages/api cannot import
// `~/models`.
const mongoose = require('mongoose');
const {
  logger,
  runAsSystem,
  PLATFORM_CHAIN_KEY,
  auditRetentionScopeKey,
} = require('@librechat/data-schemas');

/* Mirrors data-schemas' private TENANT_CHAIN_PREFIX. Used ONLY for the dry-run
 * count query — never to derive a tenant id from a chain key, and never on the
 * delete path, which goes through `purgeAuditLogEntries(tenantId)` and derives
 * the chain key upstream. If upstream ever changed the prefix the worst case
 * here is a dry-run count of 0, which is visible, not a wrong deletion. */
const TENANT_CHAIN_PREFIX = 'tenant:';
const {
  sweepAuditRetention: sweepAuditRetentionWithDeps,
  startAuditRetentionSweep: startAuditRetentionSweepWithDeps,
} = require('@librechat/api');
const db = require('~/models');

/**
 * Every audit scope that currently has entries.
 *
 * Enumerates `tenantId` rather than `chainKey` deliberately: `purgeAuditLogEntries`
 * takes a tenant id and derives the chain key itself, and the `tenant:` chain prefix
 * is a PRIVATE constant in data-schemas. Mapping `chainKey -> tenantId` here would
 * duplicate that constant and silently purge the wrong scope if upstream ever
 * changed it. Tenant ids round-trip with no such coupling.
 *
 * Platform entries carry no `tenantId` at all (the schema forbids null/empty), so
 * `distinct` omits them — they are detected separately via the exported sentinel.
 *
 * Scopes are recomputed per pass so a tenant onboarded after boot still gets swept.
 */
async function listAuditScopes() {
  const AuditLog = mongoose.models.AuditLog;
  if (!AuditLog) {
    return [];
  }

  /* Enumerate by `chainKey`, which carries four compound indexes, rather than by
   * `tenantId`, which has none — `distinct('tenantId')` is a full collection scan
   * on exactly the deployments large enough to need retention. */
  const chainKeys = await AuditLog.distinct('chainKey');
  const scopes = [];

  for (const chainKey of chainKeys) {
    if (chainKey === PLATFORM_CHAIN_KEY) {
      scopes.push({ scopeKey: auditRetentionScopeKey(undefined), tenantId: undefined });
      continue;
    }
    /* Read the tenant id off a real entry instead of stripping upstream's
     * `tenant:` prefix: that prefix is a PRIVATE constant, and the stored id is
     * used verbatim by `auditChainKey`, so trimming or reconstructing it here
     * would target a chain key that does not exist and silently skip the scope. */
    const sample = await AuditLog.findOne({ chainKey }).select('tenantId').lean();
    const tenantId = sample?.tenantId;
    if (typeof tenantId === 'string' && tenantId.trim().length > 0) {
      scopes.push({ scopeKey: auditRetentionScopeKey(tenantId), tenantId });
    }
  }
  return scopes;
}

/** Rows older than the cutoff for a scope — the dry-run estimate. Counted with
 *  the indexed `chainKey`, derived the same way `recordAuditEntry` derived it. */
async function countPurgeable(scope, before) {
  const AuditLog = mongoose.models.AuditLog;
  if (!AuditLog) {
    return 0;
  }
  const chainKey =
    scope.tenantId == null ? PLATFORM_CHAIN_KEY : `${TENANT_CHAIN_PREFIX}${scope.tenantId}`;
  return AuditLog.countDocuments({ chainKey, createdAt: { $lt: before } });
}

async function sweepAuditRetention(options = {}) {
  return sweepAuditRetentionWithDeps(options, {
    listAuditScopes,
    purgeScope: (scope, purgeOptions) => db.purgeAuditLogEntries(scope.tenantId, purgeOptions),
    advanceCheckpoint: db.advanceAuditRetentionCheckpoint,
    clearCheckpoint: db.clearAuditRetentionCheckpoint,
    countPurgeable,
    now: () => new Date(),
    logger,
  });
}

function startKnaufAuditRetentionSweep() {
  return startAuditRetentionSweepWithDeps({
    sweepAuditRetention,
    runAsSystem,
    logger,
  });
}

module.exports = {
  listAuditScopes,
  countPurgeable,
  sweepAuditRetention,
  startKnaufAuditRetentionSweep,
};
// End [knauf]

#!/usr/bin/env node
// [knauf] KK20-328 — one-shot audit-retention sweep for a singleton CronJob.
//
// The in-process scheduler (started by api/server/index.js) is guarded by the same
// distributed lease, so either deployment shape is safe. Platforms that want the
// destructive task OUT of the web replicas run this from a Kubernetes CronJob and
// set KNAUF_AUDIT_SWEEP_INTERVAL_MS=0 on the API pods. Honours exactly the same
// knobs (KNAUF_AUDIT_RETENTION_DAYS, KNAUF_AUDIT_SWEEP_DRY_RUN, …); unset retention
// ⇒ exits 0 having done nothing.
//
//   npm run audit:retention:sweep          # or: node api/knauf/audit/sweepOnce.js
//
// Exit codes: 0 pass completed (or inert, or lease held elsewhere) · 2 pass ABORTED
// (lease lost mid-way — remaining scopes untouched; the next run recovers) · 1 failure.
// Always exits explicitly: requiring `@librechat/api` opens Redis clients when
// USE_REDIS=true, and those handles would otherwise keep a CronJob pod Running forever.
require('dotenv').config();
const path = require('node:path');
require('module-alias')({ base: path.resolve(__dirname, '../..') });
const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const { getAuditRetentionDays } = require('@librechat/api');
const { connectDb } = require('~/db');

async function main() {
  if (getAuditRetentionDays() == null) {
    logger.info('[auditRetention] sweepOnce: KNAUF_AUDIT_RETENTION_DAYS unset — nothing to do');
    return 0;
  }
  await connectDb();
  require('~/models');
  const { sweepAuditRetention } = require('./retention');
  const result = await runAsSystem(() => sweepAuditRetention({}, { oneShot: true }));
  logger.info('[auditRetention] sweepOnce finished', {
    dryRun: result.dryRun,
    skipped: result.skipped,
    aborted: result.aborted,
    fence: result.fence,
    chains: result.chains.length,
    totalDeleted: result.totalDeleted,
    totalWouldDelete: result.totalWouldDelete,
    recovered: result.chains.filter((c) => c.recoveredPending).length,
  });
  await mongoose.disconnect();
  return result.aborted ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error('[auditRetention] sweepOnce failed', err);
      process.exit(1);
    });
}
// End [knauf]

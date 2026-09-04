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
// Exit codes: 0 ran (or inert, or lease held elsewhere) · 1 failure.
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
    return;
  }
  await connectDb();
  require('~/models');
  const { sweepAuditRetention } = require('./retention');
  const result = await runAsSystem(() => sweepAuditRetention());
  logger.info('[auditRetention] sweepOnce finished', {
    dryRun: result.dryRun,
    skipped: result.skipped,
    chains: result.chains.length,
    totalDeleted: result.totalDeleted,
    totalWouldDelete: result.totalWouldDelete,
    recovered: result.chains.filter((c) => c.recoveredPending).length,
  });
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('[auditRetention] sweepOnce failed', err);
    process.exit(1);
  });
}

module.exports = { main };
// End [knauf]

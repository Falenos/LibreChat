'use strict';

require('dotenv').config();

if (require.main === module && process.env.KNAUF_SCHEDULER_WORKER_ENABLED !== 'true') {
  console.warn('[scheduler] KNAUF_SCHEDULER_WORKER_ENABLED is not true; exiting');
  process.exit(0);
}

const telemetry = require('../../server/telemetry');
const os = require('node:os');
const path = require('node:path');
require('module-alias')({ base: path.resolve(__dirname, '../..') });
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  createSchedulerRepository,
  createSchedulerWorker,
} = require('@knauf/knauf/server/scheduler');
const { connectDb } = require('~/db');
const db = require('~/models');
const { checkPermission } = require('~/server/services/PermissionService');
const { createProbeApp } = require('~/server/services/Files/knauf/workerProbes');
const { resolveSchedulableAgent } = require('./agentPolicy');
const { createAgentExecutionAdapter } = require('./agentExecutionAdapter');
const { createSchedulerMetrics } = require('./metrics');
const { getSchedulerReadiness, parsePositiveIntegerSetting } = require('./runtime');
const { ensureSchedulerUserStateIndexes, isSchedulerUserDeleting } = require('./userLifecycle');

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

async function main() {
  if (process.env.KNAUF_SCHEDULER_WORKER_ENABLED !== 'true') {
    logger.warn('[scheduler] KNAUF_SCHEDULER_WORKER_ENABLED is not true; exiting');
    return;
  }
  if (!process.env.KNAUF_SCHEDULER_API_URL) {
    throw new Error('KNAUF_SCHEDULER_API_URL is required');
  }
  if (!process.env.KNAUF_SCHEDULER_INTERNAL_SECRET) {
    throw new Error('KNAUF_SCHEDULER_INTERNAL_SECRET is required');
  }

  await connectDb();
  const repository = createSchedulerRepository({
    schedules: mongoose.connection.db.collection('knauf_agent_schedules'),
    runs: mongoose.connection.db.collection('knauf_scheduled_agent_runs'),
  });
  await repository.ensureIndexes();
  await ensureSchedulerUserStateIndexes();

  const workerId = `${os.hostname()}:${process.pid}`;
  const leaseMs = parsePositiveInteger(process.env.KNAUF_SCHEDULER_LEASE_MS, 10 * 60_000);
  const pollMs = parsePositiveInteger(process.env.KNAUF_SCHEDULER_POLL_MS, 5_000);
  const { metrics, metricsRouter } = createSchedulerMetrics();
  const resolveAgent = (agentId, user) =>
    resolveSchedulableAgent({
      agentId,
      user,
      getAgent: db.getAgent,
      getRoleByName: db.getRoleByName,
      checkPermission,
    });
  const worker = createSchedulerWorker({
    repository,
    workerId,
    leaseMs,
    batchSize: parsePositiveInteger(process.env.KNAUF_SCHEDULER_BATCH_SIZE, 10),
    dispatchBatchSize: parsePositiveIntegerSetting(
      'KNAUF_SCHEDULER_DISPATCH_BATCH_SIZE',
      process.env.KNAUF_SCHEDULER_DISPATCH_BATCH_SIZE,
      100,
    ),
    maxConcurrency: parsePositiveIntegerSetting(
      'KNAUF_SCHEDULER_MAX_CONCURRENCY',
      process.env.KNAUF_SCHEDULER_MAX_CONCURRENCY,
      25,
    ),
    executionTimeoutMs: parsePositiveIntegerSetting(
      'KNAUF_SCHEDULER_EXECUTION_TIMEOUT_MS',
      process.env.KNAUF_SCHEDULER_EXECUTION_TIMEOUT_MS,
      30 * 60_000,
    ),
    autoDisableAfterFailures: parsePositiveIntegerSetting(
      'KNAUF_SCHEDULER_AUTO_DISABLE_AFTER_FAILURES',
      process.env.KNAUF_SCHEDULER_AUTO_DISABLE_AFTER_FAILURES,
      5,
    ),
    prepareScheduleRun: async (schedule) => {
      const user = await db.getUserById(schedule.user);
      if (user == null) {
        return { preflightError: 'Schedule owner no longer exists' };
      }
      const resolved = await resolveAgent(schedule.agent_id, user);
      if (resolved == null) {
        return { preflightError: 'Scheduled agent no longer exists or is not editable' };
      }
      return {
        agentSnapshot: resolved.snapshot,
        agentVersion: resolved.snapshot.version,
      };
    },
    executeSchedule: createAgentExecutionAdapter({
      apiBaseUrl: process.env.KNAUF_SCHEDULER_API_URL,
      getUserById: db.getUserById,
      generateToken: db.generateToken,
      getProject: db.getChatProject,
      resolveAgent,
      internalSecret: process.env.KNAUF_SCHEDULER_INTERNAL_SECRET,
      isUserDeleting: isSchedulerUserDeleting,
    }),
    logger,
    metrics,
  });

  const workerPort = parsePositiveIntegerSetting(
    'KNAUF_SCHEDULER_PORT',
    process.env.KNAUF_SCHEDULER_PORT,
    3082,
  );
  const readinessStaleAfterMs = Math.max(pollMs * 5, leaseMs);
  let stopping = false;
  const stop = () => {
    stopping = true;
    worker.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const probeApp = createProbeApp({
    getReadiness: () =>
      getSchedulerReadiness({
        mongoConnected: mongoose.connection.readyState === 1,
        lastProgressAt: worker.getLastProgressAt(),
        staleAfterMs: readinessStaleAfterMs,
        stopping,
      }),
    metricsRouter,
  });
  const probeServer = await new Promise((resolve, reject) => {
    const server = probeApp.listen(workerPort, () => resolve(server));
    server.once('error', reject);
  });

  logger.info(`[scheduler] worker ${workerId} started`);
  while (!stopping) {
    try {
      await worker.tick();
    } catch (error) {
      logger.error(`[scheduler] worker loop failed: ${error.message}`);
    }
    if (!stopping) {
      await worker.waitForNextTick(pollMs);
    }
  }
  await worker.waitForIdle();
  await new Promise((resolve, reject) => {
    probeServer.close((error) => (error == null ? resolve() : reject(error)));
  });
  logger.info(`[scheduler] worker ${workerId} stopped`);
}

async function runWorkerProcess() {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    logger.error(`[scheduler] fatal startup error: ${error.message}`);
    exitCode = 1;
  }

  try {
    await mongoose.disconnect();
  } catch (error) {
    logger.error(`[scheduler] MongoDB shutdown failed: ${error.message}`);
    exitCode = 1;
  }

  try {
    await telemetry.shutdown();
  } catch (error) {
    logger.error(`[scheduler] telemetry shutdown failed: ${error.message}`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  void runWorkerProcess();
}

module.exports = { main, parsePositiveInteger };

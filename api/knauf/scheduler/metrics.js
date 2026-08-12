'use strict';

const { timingSafeEqual } = require('node:crypto');
const { Router } = require('express');
const { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } = require('prom-client');

function createSchedulerMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const dispatches = new Counter({
    name: 'knauf_scheduler_dispatches_total',
    help: 'Recurring schedule dispatch outcomes',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const executions = new Counter({
    name: 'knauf_scheduler_executions_total',
    help: 'Scheduler execution outcomes',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const executionDuration = new Histogram({
    name: 'knauf_scheduler_execution_duration_seconds',
    help: 'Scheduler execution duration',
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1_200, 1_800],
    registers: [registry],
  });
  const activeExecutions = new Gauge({
    name: 'knauf_scheduler_active_executions',
    help: 'Executions active in this scheduler process',
    registers: [registry],
  });
  const executionCapacity = new Gauge({
    name: 'knauf_scheduler_execution_capacity',
    help: 'Configured execution capacity in this scheduler process',
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: 'knauf_scheduler_queue_depth',
    help: 'Durable queued scheduler runs',
    registers: [registry],
  });
  const oldestQueueAge = new Gauge({
    name: 'knauf_scheduler_oldest_queue_age_seconds',
    help: 'Age of the oldest durable queued scheduler run',
    registers: [registry],
  });

  const metrics = {
    recordDispatch: (outcome) => dispatches.inc({ outcome }),
    recordExecution: (outcome) => executions.inc({ outcome }),
    recordExecutionDuration: (durationSeconds) => executionDuration.observe(durationSeconds),
    setState: ({ active, capacity, queued, oldestQueueAgeSeconds }) => {
      activeExecutions.set(active);
      executionCapacity.set(capacity);
      queueDepth.set(queued);
      oldestQueueAge.set(oldestQueueAgeSeconds);
    },
  };

  const metricsRouter = Router();
  metricsRouter.get('/', async (req, res, next) => {
    try {
      const secret = process.env.METRICS_SECRET;
      const match = req.headers.authorization?.match(/^bearer\s+(.+)$/i);
      if (!secret || !match) {
        res.status(401).end();
        return;
      }
      const expected = Buffer.from(secret);
      const actual = Buffer.from(match[1]);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        res.status(401).end();
        return;
      }
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      next(error);
    }
  });

  return { metrics, metricsRouter, getMetricsText: () => registry.metrics() };
}

module.exports = { createSchedulerMetrics };

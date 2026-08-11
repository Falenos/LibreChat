'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const {
  SCHEDULE_ACTIVE_RUN_CODE,
  SCHEDULE_LIMIT_CODE,
  computeNextRunAt,
  createSchedulerRepository,
  isValidTimezone,
} = require('@knauf/knauf/server/scheduler');
const { messageIpLimiter, requireJwtAuth } = require('~/server/middleware');
const { checkPermission } = require('~/server/services/PermissionService');
const { isSchedulerApiEnabled } = require('~/knauf/scheduler/config');
const { resolveSchedulableAgent } = require('~/knauf/scheduler/agentPolicy');
const { isSchedulerUserDeleting } = require('~/knauf/scheduler/userLifecycle');
const db = require('~/models');

const scheduleCadenceSchema = z
  .object({
    frequency: z.enum(['hourly', 'daily', 'weekdays', 'weekly']),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((days) => Array.from(new Set(days)))
      .optional(),
  })
  .strict();

const scheduleCoreSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    prompt: z.string().trim().min(1).max(32_000),
    agent_id: z.string().trim().min(1),
    cadence: scheduleCadenceSchema,
    timezone: z.string().trim().min(1).refine(isValidTimezone, 'Invalid IANA timezone'),
    target: z.literal('new').default('new'),
    enabled: z.boolean().default(true),
  })
  .strict();

const scheduleConfigSchema = scheduleCoreSchema
  .extend({
    chatProjectId: z.string().trim().min(1),
  })
  .strict();

const createScheduleSchema = scheduleConfigSchema
  .extend({
    clientRequestId: z.string().trim().min(1).max(128),
  })
  .strict();

const updateScheduleSchema = scheduleConfigSchema
  .partial()
  .extend({
    expectedConfigRevision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (payload) => Object.keys(payload).some((key) => key !== 'expectedConfigRevision'),
    'At least one schedule field must be updated',
  );

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeUserId = (userId) =>
  mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;

const toWireLastRun = (lastRun) => ({
  ...(lastRun.conversationId == null ? {} : { conversationId: lastRun.conversationId }),
  status: lastRun.status,
  ...(lastRun.error == null ? {} : { error: lastRun.error }),
  firedAt: lastRun.firedAt,
});

const toWireSchedule = (schedule) => ({
  id: schedule.id,
  user: String(schedule.user),
  name: schedule.name,
  prompt: schedule.prompt,
  agent_id: schedule.agent_id,
  chatProjectId: schedule.chatProjectId,
  cadence: schedule.cadence,
  timezone: schedule.timezone,
  target: schedule.target,
  enabled: schedule.enabled,
  ...(schedule.disabledReason == null ? {} : { disabledReason: schedule.disabledReason }),
  ...(schedule.nextRunAt == null ? {} : { nextRunAt: schedule.nextRunAt }),
  ...(schedule.lastRun == null ? {} : { lastRun: toWireLastRun(schedule.lastRun) }),
  runCount: schedule.runCount ?? 0,
  failureCount: schedule.failureCount ?? 0,
  configRevision: schedule.configRevision ?? 0,
  createdAt: schedule.createdAt,
  updatedAt: schedule.updatedAt,
});

const defaultResolveAgent = (agentId, req) =>
  resolveSchedulableAgent({
    agentId,
    user: req.user,
    getAgent: db.getAgent,
    getRoleByName: db.getRoleByName,
    checkPermission,
  });

function createSchedulesRouter({
  getRepository = () =>
    createSchedulerRepository({
      schedules: mongoose.connection.db.collection('knauf_agent_schedules'),
      runs: mongoose.connection.db.collection('knauf_scheduled_agent_runs'),
    }),
  resolveAgent = defaultResolveAgent,
  authMiddleware = requireJwtAuth,
  isUserDeleting = isSchedulerUserDeleting,
  runNowIpLimiter = String(process.env.LIMIT_MESSAGE_IP).toLowerCase() === 'true'
    ? messageIpLimiter
    : (_req, _res, next) => next(),
  apiEnabled = isSchedulerApiEnabled,
  getProject = db.getChatProject,
  maxPerUser = () => parsePositiveInteger(process.env.KNAUF_SCHEDULER_MAX_PER_USER, 10),
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!apiEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }
    return next();
  });
  router.use(authMiddleware);
  router.use(async (req, res, next) => {
    if (req.method === 'GET') {
      return next();
    }
    try {
      if (await isUserDeleting(req.user.id)) {
        return res.status(410).json({ error: 'This account is being deleted' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const repository = getRepository();
      const schedules = await repository.listSchedulesForUser({
        user: normalizeUserId(req.user.id),
      });
      return res.json({
        schedules: schedules.map(toWireSchedule),
        limits: { maxPerUser: maxPerUser() },
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const repository = getRepository();
      const schedule = await repository.getScheduleForUser({
        id: req.params.id,
        user: normalizeUserId(req.user.id),
      });
      if (schedule == null) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      return res.json(toWireSchedule(schedule));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
      }
      const payload = parsed.data;
      if ((await resolveAgent(payload.agent_id, req)) == null) {
        return res.status(400).json({ error: 'Agent not found or not editable' });
      }
      if ((await getProject(req.user.id, payload.chatProjectId)) == null) {
        return res.status(400).json({ error: 'Project not found or not accessible' });
      }
      const repository = getRepository();
      await repository.ensureIndexes();
      const scheduleId = randomUUID();
      const nextRunAt = computeNextRunAt({
        cadence: payload.cadence,
        timezone: payload.timezone,
        scheduleId,
        after: now(),
      });
      if (payload.enabled && nextRunAt == null) {
        return res.status(400).json({ error: 'Schedule cadence could not be computed' });
      }
      const created = await repository.createSchedule({
        user: normalizeUserId(req.user.id),
        payload,
        nextRunAt,
        maxPerUser: maxPerUser(),
        id: scheduleId,
      });
      return res.status(created.replayed ? 200 : 201).json(toWireSchedule(created.schedule));
    } catch (error) {
      if (error?.code === 'IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({ error: error.message });
      }
      if (error?.code === SCHEDULE_LIMIT_CODE) {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const parsed = updateScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
      }
      const { expectedConfigRevision, ...changes } = parsed.data;
      const repository = getRepository();
      const user = normalizeUserId(req.user.id);
      const current = await repository.getScheduleForUser({ id: req.params.id, user });
      if (current == null) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      const nextProjectId = changes.chatProjectId ?? current.chatProjectId;
      if (changes.enabled !== false && (await getProject(req.user.id, nextProjectId)) == null) {
        return res.status(400).json({ error: 'Project not found or not accessible' });
      }
      const merged = scheduleCoreSchema.parse({
        name: changes.name ?? current.name,
        prompt: changes.prompt ?? current.prompt,
        agent_id: changes.agent_id ?? current.agent_id,
        cadence: changes.cadence ?? current.cadence,
        timezone: changes.timezone ?? current.timezone,
        target: changes.target ?? current.target,
        enabled: changes.enabled ?? current.enabled,
      });
      if (merged.enabled && (await resolveAgent(merged.agent_id, req)) == null) {
        return res.status(400).json({ error: 'Agent not found or not editable' });
      }
      const recurrenceChanged =
        changes.cadence != null ||
        changes.timezone != null ||
        (changes.enabled === true && current.enabled !== true);
      const set = { ...changes };
      const unset = {};
      if (merged.enabled) {
        if (recurrenceChanged) {
          const nextRunAt = computeNextRunAt({
            cadence: merged.cadence,
            timezone: merged.timezone,
            scheduleId: current.id,
            after: now(),
          });
          if (nextRunAt == null) {
            return res.status(400).json({ error: 'Schedule cadence could not be computed' });
          }
          set.nextRunAt = nextRunAt;
        }
        unset.disabledReason = '';
      } else if (changes.enabled === false) {
        unset.nextRunAt = '';
        unset.disabledReason = '';
      }

      const result = await repository.updateScheduleForUser({
        id: req.params.id,
        user,
        expectedConfigRevision,
        set,
        unset,
      });
      if (result.outcome === 'revision_conflict') {
        return res.status(409).json({
          error: 'Schedule was updated by another request',
          schedule: result.schedule == null ? undefined : toWireSchedule(result.schedule),
        });
      }
      return res.json(toWireSchedule(result.schedule));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:id/run', runNowIpLimiter, async (req, res, next) => {
    try {
      const repository = getRepository();
      const schedule = await repository.getScheduleForUser({
        id: req.params.id,
        user: normalizeUserId(req.user.id),
      });
      if (schedule == null) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      const resolvedAgent = await resolveAgent(schedule.agent_id, req);
      if (resolvedAgent == null) {
        return res.status(400).json({ error: 'Agent not found or not editable' });
      }
      if ((await getProject(req.user.id, schedule.chatProjectId)) == null) {
        return res.status(409).json({ error: 'Scheduled chat project no longer exists' });
      }
      await repository.ensureIndexes();
      const conversationId = randomUUID();
      const queued = await repository.enqueueManualRun({
        schedule,
        conversationId,
        requestedBy: normalizeUserId(req.user.id),
        scheduledFor: now(),
        execution: {
          agentSnapshot: resolvedAgent.snapshot,
          agentVersion: resolvedAgent.snapshot.version,
        },
      });
      if (queued == null) {
        return res.status(409).json({ error: 'Schedule has an active run' });
      }
      return res.json({
        scheduleId: schedule.id,
        conversationId,
        status: 'started',
      });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const repository = getRepository();
      const deleted = await repository.deleteScheduleForUser({
        id: req.params.id,
        user: normalizeUserId(req.user.id),
      });
      if (deleted == null) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      return res.status(204).end();
    } catch (error) {
      if (error?.code === SCHEDULE_ACTIVE_RUN_CODE) {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  return router;
}

module.exports = createSchedulesRouter();
module.exports.createSchedulesRouter = createSchedulesRouter;
module.exports.schemas = {
  createScheduleSchema,
  scheduleCadenceSchema,
  updateScheduleSchema,
};
module.exports.toWireSchedule = toWireSchedule;

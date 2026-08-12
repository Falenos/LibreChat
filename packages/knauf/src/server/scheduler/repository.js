'use strict';

const { createHash, randomUUID } = require('node:crypto');

const DUPLICATE_KEY_CODE = 11000;
const SCHEDULE_ACTIVE_RUN_CODE = 'SCHEDULE_ACTIVE_RUN';
const SCHEDULE_LIMIT_CODE = 'SCHEDULE_LIMIT_REACHED';
const DEFAULT_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function createScheduleDigest(payload) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: payload.name,
        prompt: payload.prompt,
        agent_id: payload.agent_id,
        chatProjectId: payload.chatProjectId,
        cadence: payload.cadence,
        timezone: payload.timezone,
        target: payload.target,
        enabled: payload.enabled,
      }),
    )
    .digest('hex');
}

function createOccurrenceKey(scheduleId, scheduledFor) {
  const date = new Date(scheduledFor);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('scheduledFor must be a valid date');
  }
  return `${String(scheduleId)}:${date.toISOString()}`;
}

function createSchedulerRepository({
  schedules,
  runs,
  now = () => new Date(),
  runRetentionMs = DEFAULT_RUN_RETENTION_MS,
}) {
  if (schedules == null || runs == null) {
    throw new TypeError('schedules and runs collections are required');
  }
  if (!Number.isInteger(runRetentionMs) || runRetentionMs <= 0) {
    throw new TypeError('runRetentionMs must be a positive integer');
  }

  const ensureIndexes = async () => {
    await Promise.all([
      schedules.createIndex({ enabled: 1, nextRunAt: 1 }),
      schedules.createIndex({ id: 1 }, { unique: true }),
      schedules.createIndex({ user: 1, chatProjectId: 1 }),
      schedules.createIndex(
        { user: 1, clientRequestId: 1 },
        { unique: true, partialFilterExpression: { clientRequestId: { $exists: true } } },
      ),
      schedules.createIndex(
        { user: 1, slot: 1 },
        { unique: true, partialFilterExpression: { slot: { $exists: true } } },
      ),
      runs.createIndex({ occurrenceKey: 1 }, { unique: true }),
      runs.createIndex(
        { scheduleId: 1, active: 1 },
        { unique: true, partialFilterExpression: { active: true } },
      ),
      runs.createIndex({ status: 1, leaseExpiresAt: 1 }),
      runs.createIndex({ status: 1, active: 1, scheduledFor: 1 }),
      runs.createIndex({ ownerId: 1, chatProjectId: 1, active: 1 }),
      runs.createIndex({ status: 1, bookkeepingAppliedAt: 1, completedAt: 1 }),
      runs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  };

  const listDueSchedules = ({ at = now(), limit = 50 } = {}) =>
    schedules
      .find({ enabled: true, nextRunAt: { $lte: at } })
      .sort({ nextRunAt: 1, id: 1 })
      .limit(limit)
      .toArray();

  const listExpiredRuns = ({ at = now(), limit = 50 } = {}) =>
    runs
      .find({ status: 'started', leaseExpiresAt: { $lte: at } })
      .sort({ leaseExpiresAt: 1, _id: 1 })
      .limit(limit)
      .toArray();

  const listQueuedRuns = ({ limit = 50 } = {}) =>
    runs
      .find({ status: 'queued', active: true })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();

  const getQueueStats = async ({ at = now() } = {}) => {
    const [queued, oldest] = await Promise.all([
      runs.countDocuments({ status: 'queued', active: true }),
      runs
        .find({ status: 'queued', active: true })
        .sort({ scheduledFor: 1, _id: 1 })
        .limit(1)
        .next(),
    ]);
    return {
      queued,
      oldestAgeMs:
        oldest?.scheduledFor == null
          ? 0
          : Math.max(0, at.getTime() - new Date(oldest.scheduledFor).getTime()),
    };
  };

  const listUnbookkeptRuns = ({ limit = 50 } = {}) =>
    runs
      .find({
        status: { $in: ['success', 'error', 'interrupted'] },
        bookkeepingAppliedAt: { $exists: false },
      })
      .sort({ completedAt: 1, _id: 1 })
      .limit(limit)
      .toArray();

  const getSchedule = (scheduleId) => schedules.findOne({ id: scheduleId });

  const listSchedulesForUser = ({ user }) =>
    schedules.find({ user }).sort({ createdAt: -1, id: 1 }).toArray();

  const getScheduleForUser = ({ id, user }) => schedules.findOne({ id, user });

  const createSchedule = async ({ user, payload, nextRunAt, maxPerUser, id = randomUUID() }) => {
    const createdAt = now();
    const clientRequestDigest = createScheduleDigest(payload);

    for (let slot = 0; slot < maxPerUser; slot++) {
      const schedule = {
        id,
        user,
        name: payload.name,
        prompt: payload.prompt,
        agent_id: payload.agent_id,
        chatProjectId: payload.chatProjectId,
        cadence: payload.cadence,
        timezone: payload.timezone,
        target: payload.target,
        enabled: payload.enabled,
        ...(payload.enabled ? { nextRunAt } : {}),
        runCount: 0,
        failureCount: 0,
        configRevision: 0,
        slot,
        clientRequestId: payload.clientRequestId,
        clientRequestDigest,
        createdAt,
        updatedAt: createdAt,
      };

      try {
        await schedules.insertOne(schedule);
        return { schedule, replayed: false };
      } catch (error) {
        if (error?.code !== DUPLICATE_KEY_CODE) {
          throw error;
        }
        const existing = await schedules.findOne({
          user,
          clientRequestId: payload.clientRequestId,
        });
        if (existing != null) {
          if (existing.clientRequestDigest !== clientRequestDigest) {
            const conflict = new Error('clientRequestId was already used for another schedule');
            conflict.code = 'IDEMPOTENCY_CONFLICT';
            throw conflict;
          }
          return { schedule: existing, replayed: true };
        }
      }
    }

    const limitError = new Error(`Schedule limit of ${maxPerUser} reached`);
    limitError.code = SCHEDULE_LIMIT_CODE;
    throw limitError;
  };

  const updateScheduleForUser = async ({ id, user, expectedConfigRevision, set, unset = {} }) => {
    const current = await schedules.findOne({ id, user });
    if (current == null) {
      return { outcome: 'not_found' };
    }
    if (expectedConfigRevision != null && current.configRevision !== expectedConfigRevision) {
      return { outcome: 'revision_conflict', schedule: current };
    }

    const updated = await schedules.findOneAndUpdate(
      { id, user, configRevision: current.configRevision },
      {
        $set: { ...set, updatedAt: now() },
        $unset: unset,
        $inc: { configRevision: 1 },
      },
      { returnDocument: 'after' },
    );
    return updated == null
      ? { outcome: 'revision_conflict', schedule: await schedules.findOne({ id, user }) }
      : { outcome: 'updated', schedule: updated };
  };

  const deleteScheduleForUser = async ({ id, user }) => {
    const activeRun = await runs.findOne({
      scheduleId: id,
      ownerId: user,
      active: true,
      $or: [{ status: 'queued' }, { status: 'started', leaseExpiresAt: { $gt: now() } }],
    });
    if (activeRun != null) {
      const error = new Error('Schedule has an active run');
      error.code = SCHEDULE_ACTIVE_RUN_CODE;
      throw error;
    }
    const deleted = await schedules.findOneAndDelete({ id, user });
    if (deleted != null) {
      await runs.deleteMany({ scheduleId: id, ownerId: user, active: { $ne: true } });
    }
    return deleted;
  };

  const assertProjectCanBeDeleted = async ({ projectId, user }) => {
    const scheduleIds = await schedules
      .find({ user, chatProjectId: projectId }, { projection: { _id: 0, id: 1 } })
      .map((schedule) => schedule.id)
      .toArray();
    const activeRun = await runs.findOne({
      ownerId: user,
      active: true,
      $and: [
        {
          $or: [
            { chatProjectId: projectId },
            ...(scheduleIds.length > 0 ? [{ scheduleId: { $in: scheduleIds } }] : []),
          ],
        },
        {
          $or: [{ status: 'queued' }, { status: 'started', leaseExpiresAt: { $gt: now() } }],
        },
      ],
    });
    if (activeRun != null) {
      const error = new Error('Project has an active scheduled run');
      error.code = SCHEDULE_ACTIVE_RUN_CODE;
      throw error;
    }
    return scheduleIds;
  };

  const deleteSchedulesForProject = async ({ projectId, user, scheduleIds }) => {
    const ids = scheduleIds ?? (await assertProjectCanBeDeleted({ projectId, user }));
    const scheduleResult = await schedules.deleteMany({ user, chatProjectId: projectId });
    const runResult = await runs.deleteMany({
      ownerId: user,
      $and: [
        {
          $or: [
            { chatProjectId: projectId },
            ...(ids.length > 0 ? [{ scheduleId: { $in: ids } }] : []),
          ],
        },
        {
          $nor: [
            { active: true, status: 'queued' },
            { active: true, status: 'started', leaseExpiresAt: { $gt: now() } },
          ],
        },
      ],
    });
    return {
      deletedSchedules: scheduleResult.deletedCount ?? 0,
      deletedRuns: runResult.deletedCount ?? 0,
    };
  };

  const claimOccurrence = async ({ schedule, workerId, leaseMs }) => {
    const claimedAt = now();
    const leaseToken = randomUUID();
    const occurrenceKey = createOccurrenceKey(schedule.id, schedule.nextRunAt);
    const run = {
      occurrenceKey,
      scheduleId: schedule.id,
      ownerId: schedule.user,
      agentId: schedule.agent_id,
      chatProjectId: schedule.chatProjectId,
      scheduleName: schedule.name,
      prompt: schedule.prompt,
      timezone: schedule.timezone,
      cadence: schedule.cadence,
      configRevision: schedule.configRevision,
      scheduledFor: schedule.nextRunAt,
      status: 'started',
      trigger: 'automatic',
      active: true,
      attempt: 1,
      leaseOwner: workerId,
      leaseToken,
      leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
      claimedAt,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    };

    try {
      const inserted = await runs.insertOne(run);
      return { ...run, _id: inserted.insertedId, recovered: false };
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY_CODE) {
        throw error;
      }
    }

    const recovered = await runs.findOneAndUpdate(
      {
        occurrenceKey,
        status: 'started',
        leaseExpiresAt: { $lte: claimedAt },
      },
      {
        $set: {
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
          claimedAt,
          updatedAt: claimedAt,
        },
        $inc: { attempt: 1 },
      },
      { returnDocument: 'after' },
    );
    return recovered == null ? null : { ...recovered, recovered: true };
  };

  const enqueueOccurrence = async ({ schedule, execution }) => {
    const queuedAt = now();
    const occurrenceKey = createOccurrenceKey(schedule.id, schedule.nextRunAt);
    const run = {
      occurrenceKey,
      scheduleId: schedule.id,
      ownerId: schedule.user,
      agentId: schedule.agent_id,
      chatProjectId: schedule.chatProjectId,
      scheduleName: schedule.name,
      prompt: schedule.prompt,
      timezone: schedule.timezone,
      cadence: schedule.cadence,
      configRevision: schedule.configRevision,
      ...(execution == null ? {} : { execution }),
      scheduledFor: schedule.nextRunAt,
      conversationId: randomUUID(),
      status: 'queued',
      trigger: 'automatic',
      active: true,
      attempt: 0,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    };

    try {
      const inserted = await runs.insertOne(run);
      return { ...run, _id: inserted.insertedId };
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_CODE) {
        return null;
      }
      throw error;
    }
  };

  const enqueueManualRun = async ({
    schedule,
    conversationId,
    requestedBy,
    scheduledFor = now(),
    execution,
  }) => {
    const queuedAt = now();
    const run = {
      occurrenceKey: `${schedule.id}:manual:${randomUUID()}`,
      scheduleId: schedule.id,
      ownerId: schedule.user,
      agentId: schedule.agent_id,
      chatProjectId: schedule.chatProjectId,
      scheduleName: schedule.name,
      prompt: schedule.prompt,
      timezone: schedule.timezone,
      cadence: schedule.cadence,
      configRevision: schedule.configRevision,
      ...(execution == null ? {} : { execution }),
      scheduledFor,
      conversationId,
      requestedBy,
      trigger: 'manual',
      status: 'queued',
      active: true,
      attempt: 0,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    };

    try {
      const inserted = await runs.insertOne(run);
      return { ...run, _id: inserted.insertedId };
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_CODE) {
        return null;
      }
      throw error;
    }
  };

  const claimQueuedRun = ({ run, workerId, leaseMs }) => {
    const claimedAt = now();
    return runs.findOneAndUpdate(
      { _id: run._id, status: 'queued', active: true },
      {
        $set: {
          status: 'started',
          leaseOwner: workerId,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
          claimedAt,
          updatedAt: claimedAt,
        },
        $inc: { attempt: 1 },
      },
      { returnDocument: 'after' },
    );
  };

  const reclaimExpiredRun = async ({ run, workerId, leaseMs }) => {
    const claimedAt = now();
    const reclaimed = await runs.findOneAndUpdate(
      {
        _id: run._id,
        status: 'started',
        leaseToken: run.leaseToken,
        leaseExpiresAt: { $lte: claimedAt },
      },
      {
        $set: {
          leaseOwner: workerId,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
          claimedAt,
          updatedAt: claimedAt,
        },
        $inc: { attempt: 1 },
      },
      { returnDocument: 'after' },
    );
    return reclaimed == null ? null : { ...reclaimed, recovered: true };
  };

  const renewRunLease = ({ runId, leaseToken, leaseMs }) => {
    const renewedAt = now();
    return runs.findOneAndUpdate(
      {
        _id: runId,
        status: 'started',
        leaseToken,
        leaseExpiresAt: { $gt: renewedAt },
      },
      {
        $set: {
          leaseExpiresAt: new Date(renewedAt.getTime() + leaseMs),
          updatedAt: renewedAt,
        },
      },
      { returnDocument: 'after' },
    );
  };

  const advanceSchedule = ({ schedule, nextRunAt }) =>
    schedules.findOneAndUpdate(
      {
        id: schedule.id,
        enabled: true,
        nextRunAt: schedule.nextRunAt,
      },
      { $set: { nextRunAt, updatedAt: now() } },
      { returnDocument: 'after' },
    );

  const applyRunBookkeeping = async (run, { autoDisableAfterFailures = 5 } = {}) => {
    const firedAt = run.claimedAt ?? run.createdAt ?? run.scheduledFor;
    const revisionFilter = run.configRevision == null ? {} : { configRevision: run.configRevision };
    let conversationId = run.result?.conversationId;
    if (conversationId == null) {
      conversationId = run.conversationId;
    }
    const lastRun = {
      ...(conversationId == null ? {} : { conversationId }),
      status: run.status,
      ...(run.error?.message == null ? {} : { error: run.error.message }),
      firedAt,
      scheduledFor: run.scheduledFor,
    };
    if (run.status === 'success' || run.status === 'error') {
      await schedules.updateOne(
        {
          id: run.scheduleId,
          countedOccurrenceKeys: { $ne: run.occurrenceKey },
          $or: [{ countersAsOf: { $exists: false } }, { countersAsOf: { $lte: run.scheduledFor } }],
          ...revisionFilter,
        },
        {
          $set: {
            countersAsOf: run.scheduledFor,
            ...(run.status === 'success' ? { failureCount: 0 } : {}),
          },
          $push: {
            countedOccurrenceKeys: {
              $each: [run.occurrenceKey],
              $slice: -50,
            },
          },
          ...(run.status === 'success' ? { $inc: { runCount: 1 } } : { $inc: { failureCount: 1 } }),
        },
      );
    }
    if (run.status === 'error') {
      await schedules.updateOne(
        {
          id: run.scheduleId,
          enabled: true,
          failureCount: { $gte: autoDisableAfterFailures },
          countersAsOf: run.scheduledFor,
          ...revisionFilter,
        },
        {
          $set: {
            enabled: false,
            disabledReason: 'too_many_failures',
            updatedAt: now(),
          },
        },
      );
    }
    await schedules.updateOne(
      {
        id: run.scheduleId,
        $or: [
          { 'lastRun.scheduledFor': { $exists: false } },
          { 'lastRun.scheduledFor': { $lte: run.scheduledFor } },
        ],
        ...revisionFilter,
      },
      { $set: { lastRun } },
    );
    await runs.updateOne(
      { _id: run._id, bookkeepingAppliedAt: { $exists: false } },
      { $set: { bookkeepingAppliedAt: now(), updatedAt: now() } },
    );
  };

  const finishRun = ({ runId, leaseToken, status, result, error }) => {
    const completedAt = now();
    return runs.findOneAndUpdate(
      { _id: runId, status: 'started', leaseToken },
      {
        $set: {
          status,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
          completedAt,
          expiresAt: new Date(completedAt.getTime() + runRetentionMs),
          updatedAt: completedAt,
        },
        $unset: {
          active: '',
          leaseOwner: '',
          leaseToken: '',
          leaseExpiresAt: '',
        },
      },
      { returnDocument: 'after' },
    );
  };

  const skipRun = ({ runId, leaseToken, reason }) => {
    const completedAt = now();
    return runs.findOneAndUpdate(
      { _id: runId, status: 'started', leaseToken },
      {
        $set: {
          status: 'interrupted',
          skipReason: reason,
          completedAt,
          expiresAt: new Date(completedAt.getTime() + runRetentionMs),
          updatedAt: completedAt,
        },
        $unset: {
          active: '',
          leaseOwner: '',
          leaseToken: '',
          leaseExpiresAt: '',
        },
      },
      { returnDocument: 'after' },
    );
  };

  const interruptQueuedRun = ({ runId, reason }) => {
    const completedAt = now();
    return runs.findOneAndUpdate(
      { _id: runId, status: 'queued', active: true },
      {
        $set: {
          status: 'interrupted',
          skipReason: reason,
          completedAt,
          expiresAt: new Date(completedAt.getTime() + runRetentionMs),
          updatedAt: completedAt,
        },
        $unset: { active: '' },
      },
      { returnDocument: 'after' },
    );
  };

  return {
    ensureIndexes,
    listDueSchedules,
    listExpiredRuns,
    listQueuedRuns,
    getQueueStats,
    listUnbookkeptRuns,
    getSchedule,
    listSchedulesForUser,
    getScheduleForUser,
    createSchedule,
    updateScheduleForUser,
    deleteScheduleForUser,
    assertProjectCanBeDeleted,
    deleteSchedulesForProject,
    claimOccurrence,
    enqueueOccurrence,
    enqueueManualRun,
    claimQueuedRun,
    reclaimExpiredRun,
    renewRunLease,
    advanceSchedule,
    completeRun: (params) => finishRun({ ...params, status: 'success' }),
    failRun: (params) => finishRun({ ...params, status: 'error' }),
    skipRun,
    interruptQueuedRun,
    applyRunBookkeeping,
  };
}

module.exports = {
  SCHEDULE_ACTIVE_RUN_CODE,
  SCHEDULE_LIMIT_CODE,
  createOccurrenceKey,
  createScheduleDigest,
  createSchedulerRepository,
};

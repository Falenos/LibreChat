'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const {
  cadenceToCron,
  computeNextRunAt,
  createSchedulerRepository,
  createSchedulerWorker,
  isValidTimezone,
  scheduleJitterMs,
} = require('@knauf/knauf/server/scheduler');

describe('Knauf scheduler foundation', () => {
  let mongoServer;
  let client;
  let schedules;
  let runs;
  let clock;
  let repository;

  const waitFor = async (condition, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for scheduler condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    client = new MongoClient(mongoServer.getUri());
    await client.connect();
  });

  beforeEach(async () => {
    const db = client.db(`scheduler_${new ObjectId()}`);
    schedules = db.collection('knauf_agent_schedules');
    runs = db.collection('knauf_scheduled_agent_runs');
    clock = new Date('2026-05-15T10:02:00.000Z');
    repository = createSchedulerRepository({
      schedules,
      runs,
      now: () => new Date(clock),
    });
    await repository.ensureIndexes();
  });

  afterAll(async () => {
    await client?.close();
    await mongoServer?.stop();
  });

  const createSchedule = async (overrides = {}) => {
    const schedule = {
      id: 'schedule-test',
      user: new ObjectId(),
      name: 'Test Schedule',
      agent_id: 'agent-test',
      chatProjectId: 'project-test',
      prompt: 'Original scheduled prompt',
      timezone: 'Europe/Berlin',
      target: 'new',
      enabled: true,
      nextRunAt: new Date(clock),
      runCount: 0,
      failureCount: 0,
      configRevision: 0,
      cadence: { frequency: 'hourly', hour: 0, minute: 0 },
      ...overrides,
    };
    const result = await schedules.insertOne(schedule);
    return { ...schedule, _id: result.insertedId };
  };

  test('expires only terminal runs after the retention window', async () => {
    const retentionIndex = (await runs.indexes()).find((index) => index.key?.expiresAt === 1);
    expect(retentionIndex).toMatchObject({ expireAfterSeconds: 0 });

    const completedSchedule = await createSchedule({ id: 'completed-retention' });
    const started = await repository.claimOccurrence({
      schedule: completedSchedule,
      workerId: 'worker-retention',
      leaseMs: 30_000,
    });
    expect(started).not.toHaveProperty('expiresAt');
    await expect(
      repository.completeRun({
        runId: started._id,
        leaseToken: started.leaseToken,
        result: { messageId: 'retained' },
      }),
    ).resolves.toMatchObject({
      expiresAt: new Date('2026-06-14T10:02:00.000Z'),
    });

    const skippedSchedule = await createSchedule({ id: 'skipped-retention' });
    const skippedStarted = await repository.claimOccurrence({
      schedule: skippedSchedule,
      workerId: 'worker-retention',
      leaseMs: 30_000,
    });
    await expect(
      repository.skipRun({
        runId: skippedStarted._id,
        leaseToken: skippedStarted.leaseToken,
        reason: 'test_skip',
      }),
    ).resolves.toMatchObject({
      status: 'interrupted',
      expiresAt: new Date('2026-06-14T10:02:00.000Z'),
    });

    const queuedSchedule = await createSchedule({ id: 'queued-retention' });
    const queued = await repository.enqueueOccurrence({ schedule: queuedSchedule });
    expect(queued).not.toHaveProperty('expiresAt');
    await expect(
      repository.interruptQueuedRun({ runId: queued._id, reason: 'test_interrupt' }),
    ).resolves.toMatchObject({
      status: 'interrupted',
      expiresAt: new Date('2026-06-14T10:02:00.000Z'),
    });
  });

  test('compiles upstream-compatible structured cadence', () => {
    expect(cadenceToCron({ frequency: 'hourly', hour: 0, minute: 15 })).toBe('15 * * * *');
    expect(cadenceToCron({ frequency: 'weekdays', hour: 9, minute: 30 })).toBe('30 9 * * 1-5');
    expect(cadenceToCron({ frequency: 'weekly', hour: 9, minute: 30, daysOfWeek: [5, 1] })).toBe(
      '30 9 * * 1,5',
    );
  });

  test('computes the next timezone-aware occurrence without replaying missed runs', () => {
    expect(
      computeNextRunAt({
        cadence: { frequency: 'daily', hour: 9, minute: 0 },
        timezone: 'Europe/Berlin',
        scheduleId: 'schedule-test',
        after: new Date('2026-05-15T10:00:00.000Z'),
        disableJitter: true,
      }),
    ).toEqual(new Date('2026-05-16T07:00:00.000Z'));
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Not/A_Timezone')).toBe(false);
  });

  test('allows only one worker to claim an occurrence', async () => {
    const schedule = await createSchedule();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.claimOccurrence({
          schedule,
          workerId: `worker-${index}`,
          leaseMs: 30_000,
        }),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ chatProjectId: 'project-test' });
    expect(await runs.countDocuments()).toBe(1);
  });

  test('preallocates a durable Agent stream identity before an occurrence is executable', async () => {
    const schedule = await createSchedule();
    const execution = {
      agentSnapshot: { id: schedule.agent_id, version: 3, instructions: 'Pinned' },
      agentVersion: 3,
    };
    const queued = await repository.enqueueOccurrence({ schedule, execution });

    expect(queued.conversationId).toEqual(expect.any(String));
    expect(await runs.findOne({ _id: queued._id })).toMatchObject({
      conversationId: queued.conversationId,
      execution,
      status: 'queued',
    });

    const claimed = await repository.claimQueuedRun({
      run: queued,
      workerId: 'worker-a',
      leaseMs: 30_000,
    });
    clock = new Date(clock.getTime() + 30_001);
    const recovered = await repository.reclaimExpiredRun({
      run: claimed,
      workerId: 'worker-b',
      leaseMs: 30_000,
    });
    expect(recovered).toMatchObject({ execution });
    expect(recovered).toMatchObject({
      conversationId: queued.conversationId,
      recovered: true,
      attempt: 2,
    });
  });

  test('reclaims an occurrence only after its lease expires', async () => {
    const schedule = await createSchedule();
    const first = await repository.claimOccurrence({
      schedule,
      workerId: 'worker-a',
      leaseMs: 30_000,
    });

    expect(
      await repository.claimOccurrence({
        schedule,
        workerId: 'worker-b',
        leaseMs: 30_000,
      }),
    ).toBeNull();

    clock = new Date(clock.getTime() + 30_001);
    const recovered = await repository.claimOccurrence({
      schedule,
      workerId: 'worker-b',
      leaseMs: 30_000,
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.attempt).toBe(2);
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
  });

  test('fences completion by the current lease token', async () => {
    const schedule = await createSchedule();
    const stale = await repository.claimOccurrence({
      schedule,
      workerId: 'worker-a',
      leaseMs: 30_000,
    });
    clock = new Date(clock.getTime() + 30_001);
    const current = await repository.claimOccurrence({
      schedule,
      workerId: 'worker-b',
      leaseMs: 30_000,
    });

    expect(
      await repository.completeRun({
        runId: stale._id,
        leaseToken: stale.leaseToken,
        result: { messageId: 'stale' },
      }),
    ).toBeNull();
    expect(
      await repository.completeRun({
        runId: current._id,
        leaseToken: current.leaseToken,
        result: { messageId: 'current' },
      }),
    ).toMatchObject({ status: 'success', result: { messageId: 'current' } });
  });

  test('renews only a live lease held by the current token', async () => {
    const schedule = await createSchedule();
    const run = await repository.claimOccurrence({
      schedule,
      workerId: 'worker-a',
      leaseMs: 30_000,
    });
    clock = new Date(clock.getTime() + 10_000);

    expect(
      await repository.renewRunLease({
        runId: run._id,
        leaseToken: 'stale-token',
        leaseMs: 30_000,
      }),
    ).toBeNull();
    expect(
      await repository.renewRunLease({
        runId: run._id,
        leaseToken: run.leaseToken,
        leaseMs: 30_000,
      }),
    ).toMatchObject({
      leaseExpiresAt: new Date('2026-05-15T10:02:40.000Z'),
    });
  });

  test('executes once, advances the schedule, and persists the outcome', async () => {
    await createSchedule({ failureCount: 4 });
    const executeSchedule = jest.fn().mockResolvedValue({ conversationId: 'conversation-1' });
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'worker-a',
      now: () => new Date(clock),
    });

    await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(executeSchedule).toHaveBeenCalledTimes(1);
    expect(executeSchedule).toHaveBeenCalledTimes(1);
    expect(await runs.findOne()).toMatchObject({
      status: 'success',
      result: { conversationId: 'conversation-1' },
    });
    const jitter = scheduleJitterMs('schedule-test');
    expect(await schedules.findOne()).toMatchObject({
      nextRunAt: new Date(new Date('2026-05-15T11:00:00.000Z').getTime() + jitter),
      lastRun: {
        conversationId: 'conversation-1',
        status: 'success',
        firedAt: new Date(clock),
        scheduledFor: new Date(clock),
      },
      runCount: 1,
      failureCount: 0,
    });
  });

  test('records progress after a healthy idle poll', async () => {
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(),
      workerId: 'worker-a',
      now: () => new Date(clock),
    });

    expect(worker.getLastProgressAt()).toBeNull();
    await worker.runOnce();
    expect(worker.getLastProgressAt()).toEqual(new Date(clock));
  });

  test('dispatches durable queued runs without waiting for execution capacity', async () => {
    const schedule = await createSchedule();
    const execution = {
      agentSnapshot: { id: schedule.agent_id, version: 4, instructions: 'Dispatch snapshot' },
      agentVersion: 4,
    };
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(),
      prepareScheduleRun: jest.fn().mockResolvedValue(execution),
      workerId: 'dispatcher',
      maxConcurrency: 0,
      dispatchBatchSize: 100,
      now: () => new Date(clock),
    });

    const result = await worker.tick();

    expect(result.dispatchOutcomes).toEqual(['queued']);
    expect(worker.getActiveCount()).toBe(0);
    expect(await runs.findOne()).toMatchObject({
      scheduleId: schedule.id,
      status: 'queued',
      trigger: 'automatic',
      attempt: 0,
      execution,
    });
    expect((await schedules.findOne({ id: schedule.id })).nextRunAt).not.toEqual(
      schedule.nextRunAt,
    );
  });

  test('refills bounded execution slots without waiting for the slowest run', async () => {
    await Promise.all(
      ['schedule-a', 'schedule-b', 'schedule-c'].map((id) => createSchedule({ id, name: id })),
    );
    const resolvers = new Map();
    const executeSchedule = jest.fn(
      ({ run }) =>
        new Promise((resolve) => {
          resolvers.set(run.scheduleId, resolve);
        }),
    );
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'executor',
      maxConcurrency: 2,
      dispatchBatchSize: 100,
      now: () => new Date(clock),
    });

    await worker.tick();
    await waitFor(() => executeSchedule.mock.calls.length === 2);
    expect(worker.getActiveCount()).toBe(2);
    expect(executeSchedule).toHaveBeenCalledTimes(2);
    expect(await runs.countDocuments({ status: 'queued' })).toBe(1);

    const firstScheduleId = executeSchedule.mock.calls[0][0].run.scheduleId;
    resolvers.get(firstScheduleId)({ conversationId: `conversation-${firstScheduleId}` });
    await worker.waitForNextTick(1_000);
    await worker.tick();
    await waitFor(() => executeSchedule.mock.calls.length === 3);

    expect(executeSchedule).toHaveBeenCalledTimes(3);
    expect(worker.getActiveCount()).toBe(2);
    for (const [scheduleId, resolve] of resolvers) {
      if (scheduleId !== firstScheduleId) {
        resolve({ conversationId: `conversation-${scheduleId}` });
      }
    }
    await worker.waitForIdle();
  });

  test('contains unexpected detached execution task failures', async () => {
    await createSchedule({
      id: 'detached-task-failure',
      name: 'Detached task failure',
      nextRunAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    repository.getSchedule = jest.fn().mockRejectedValue(new Error('temporary MongoDB failure'));
    const logger = { error: jest.fn() };
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(),
      logger,
      now: () => new Date('2026-01-01T12:00:00.000Z'),
      workerId: 'worker-1',
      leaseMs: 60_000,
      batchSize: 10,
      maxConcurrency: 1,
    });

    const { executionTasks } = await worker.tick();
    await expect(executionTasks[0]).resolves.toEqual({
      kind: 'queued',
      outcome: 'unexpected_error',
    });
    await worker.waitForIdle();

    expect(logger.error).toHaveBeenCalledWith(
      '[scheduler] unexpected queued task failure: temporary MongoDB failure',
    );
    expect(worker.getActiveCount()).toBe(0);
  });

  test('interrupts executions that exceed the configured timeout', async () => {
    await createSchedule();
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
      workerId: 'timeout-worker',
      executionTimeoutMs: 50,
      now: () => new Date(clock),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      executionOutcomes: ['interrupted'],
    });
    expect(await runs.findOne()).toMatchObject({
      status: 'interrupted',
      skipReason: 'execution_timeout',
    });
  });

  test('records progress when a long execution is claimed and renews its lease', async () => {
    await createSchedule();
    let finishExecution;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const executeSchedule = jest.fn(
      () =>
        new Promise((resolve) => {
          finishExecution = resolve;
          markStarted();
        }),
    );
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'worker-a',
      leaseMs: 300,
      now: () => new Date(clock),
    });

    const running = worker.runOnce();
    await started;
    expect(worker.getLastProgressAt()).toEqual(new Date(clock));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(worker.getLastProgressAt()).toEqual(new Date(clock));
    finishExecution({ conversationId: 'conversation-1' });
    await running;
  });

  test('does not report progress when polling fails before useful work', async () => {
    jest
      .spyOn(repository, 'listUnbookkeptRuns')
      .mockRejectedValue(new Error('database unavailable'));
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(),
      workerId: 'worker-a',
      now: () => new Date(clock),
    });

    await expect(worker.runOnce()).rejects.toThrow('database unavailable');
    expect(worker.getLastProgressAt()).toBeNull();
  });

  test('interrupts active execution on shutdown without growing the failure streak', async () => {
    await createSchedule({ failureCount: 2 });
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const executeSchedule = jest.fn(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'worker-a',
      now: () => new Date(clock),
    });

    const running = worker.runOnce();
    await started;
    worker.stop();

    await expect(running).resolves.toMatchObject({ executionOutcomes: ['interrupted'] });
    expect(await runs.findOne()).toMatchObject({
      status: 'interrupted',
      skipReason: 'worker_stopping',
    });
    expect(await schedules.findOne()).toMatchObject({
      enabled: true,
      failureCount: 2,
      lastRun: { status: 'interrupted' },
    });
  });

  test('aborts execution at the confirmed lease deadline after renewal errors', async () => {
    await createSchedule();
    jest.spyOn(repository, 'renewRunLease').mockRejectedValue(new Error('database unavailable'));
    const executeSchedule = jest.fn(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'worker-a',
      leaseMs: 150,
      now: () => new Date(clock),
      logger: { error: jest.fn() },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ executionOutcomes: ['lease_lost'] });
    expect(executeSchedule).toHaveBeenCalledTimes(1);
  });

  test('executes a queued manual run without advancing a disabled schedule', async () => {
    const schedule = await createSchedule({
      enabled: false,
      nextRunAt: undefined,
      configRevision: 3,
    });
    const queued = await repository.enqueueManualRun({
      schedule,
      conversationId: 'conversation-manual',
      requestedBy: schedule.user,
      execution: {
        agentSnapshot: { id: schedule.agent_id, version: 5, instructions: 'Manual snapshot' },
        agentVersion: 5,
      },
    });
    const executeSchedule = jest.fn().mockResolvedValue({
      conversationId: 'conversation-manual',
      messageId: 'message-manual',
    });
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'manual-worker',
      now: () => new Date(clock),
    });

    const outcomes = await worker.runOnce();

    expect(outcomes.queuedOutcomes).toEqual(['completed']);
    expect(executeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: expect.objectContaining({ id: schedule.id, enabled: false }),
        run: expect.objectContaining({
          _id: queued._id,
          conversationId: 'conversation-manual',
          trigger: 'manual',
          execution: {
            agentSnapshot: expect.objectContaining({ version: 5 }),
            agentVersion: 5,
          },
        }),
      }),
    );
    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: false,
      runCount: 1,
      lastRun: {
        conversationId: 'conversation-manual',
        status: 'success',
      },
    });
    expect((await schedules.findOne({ id: schedule.id })).nextRunAt).toBeNull();
  });

  test('prevents manual and recurring executions from overlapping', async () => {
    const schedule = await createSchedule();
    await repository.claimOccurrence({
      schedule,
      workerId: 'recurring-worker',
      leaseMs: 30_000,
    });

    expect(
      await repository.enqueueManualRun({
        schedule,
        conversationId: 'conversation-conflict',
        requestedBy: schedule.user,
      }),
    ).toBeNull();
    expect(await runs.countDocuments({ active: true })).toBe(1);
  });

  test('reconciles schedule bookkeeping once after a crash', async () => {
    const schedule = await createSchedule({ enabled: false });
    const run = await repository.claimOccurrence({
      schedule,
      workerId: 'crashed-worker',
      leaseMs: 30_000,
    });
    await runs.updateOne(
      { _id: run._id },
      {
        $set: {
          status: 'error',
          error: { name: 'Error', message: 'provider unavailable' },
          completedAt: new Date(clock),
        },
        $unset: { active: '', leaseOwner: '', leaseToken: '', leaseExpiresAt: '' },
      },
    );
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn(),
      workerId: 'reconciler',
      now: () => new Date(clock),
    });

    await worker.runOnce();
    await worker.runOnce();

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      runCount: 0,
      failureCount: 1,
      lastRun: {
        status: 'error',
        error: 'provider unavailable',
      },
    });
    expect(await runs.findOne({ _id: run._id })).toMatchObject({
      bookkeepingAppliedAt: new Date(clock),
    });
  });

  test('auto-disables when a failure reaches the configured threshold', async () => {
    const schedule = await createSchedule({ failureCount: 2 });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:threshold`,
      scheduledFor: new Date(clock),
      claimedAt: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'error',
      error: { message: 'provider unavailable' },
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: false,
      disabledReason: 'too_many_failures',
      failureCount: 3,
      nextRunAt: schedule.nextRunAt,
    });
  });

  test('keeps a schedule enabled below the failure threshold', async () => {
    const schedule = await createSchedule({ failureCount: 1 });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:below-threshold`,
      scheduledFor: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'error',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: true,
      failureCount: 2,
    });
  });

  test('supports auto-disabling after the first failure', async () => {
    const schedule = await createSchedule();
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:first-failure`,
      scheduledFor: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'error',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 1 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: false,
      disabledReason: 'too_many_failures',
      failureCount: 1,
    });
  });

  test('replays auto-disable after the failure counter was already persisted', async () => {
    const schedule = await createSchedule({
      failureCount: 3,
      countersAsOf: new Date(clock),
      countedOccurrenceKeys: ['schedule-test:partial'],
    });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: 'schedule-test:partial',
      scheduledFor: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'error',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: false,
      disabledReason: 'too_many_failures',
      failureCount: 3,
    });
    expect(await runs.findOne({ _id: run._id })).toHaveProperty('bookkeepingAppliedAt');
  });

  test('does not auto-disable for a stale configuration revision', async () => {
    const schedule = await createSchedule({ failureCount: 2, configRevision: 2 });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:stale-revision`,
      scheduledFor: new Date(clock),
      configRevision: 1,
      status: 'error',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: true,
      failureCount: 2,
      configRevision: 2,
    });
  });

  test('does not alter counters or policy for interrupted runs', async () => {
    const schedule = await createSchedule({ failureCount: 2 });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:interrupted`,
      scheduledFor: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'interrupted',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: true,
      failureCount: 2,
      lastRun: { status: 'interrupted' },
    });
  });

  test('does not change the reason of an already disabled schedule', async () => {
    const schedule = await createSchedule({
      enabled: false,
      failureCount: 2,
      disabledReason: 'manually_disabled',
    });
    const run = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:already-disabled`,
      scheduledFor: new Date(clock),
      configRevision: schedule.configRevision,
      status: 'error',
    };
    await runs.insertOne(run);

    await repository.applyRunBookkeeping(run, { autoDisableAfterFailures: 3 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: false,
      disabledReason: 'manually_disabled',
      failureCount: 3,
    });
  });

  test('does not let an older recovered outcome replace newer card state', async () => {
    const schedule = await createSchedule({ failureCount: 1 });
    const older = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:older`,
      scheduledFor: new Date('2026-05-15T09:00:00.000Z'),
      claimedAt: new Date('2026-05-15T09:00:00.000Z'),
      status: 'error',
      error: { message: 'older failure' },
    };
    const newer = {
      _id: new ObjectId(),
      scheduleId: schedule.id,
      occurrenceKey: `${schedule.id}:newer`,
      scheduledFor: new Date('2026-05-15T10:00:00.000Z'),
      claimedAt: new Date('2026-05-15T10:00:00.000Z'),
      status: 'success',
      result: { conversationId: 'conversation-newer' },
    };
    await runs.insertMany([older, newer]);

    await repository.applyRunBookkeeping(newer);
    await repository.applyRunBookkeeping(older, { autoDisableAfterFailures: 1 });

    expect(await schedules.findOne({ id: schedule.id })).toMatchObject({
      enabled: true,
      runCount: 1,
      failureCount: 0,
      lastRun: {
        conversationId: 'conversation-newer',
        status: 'success',
        scheduledFor: newer.scheduledFor,
      },
    });
  });

  test('records unfinished agent responses as interrupted without growing the failure streak', async () => {
    await createSchedule({ failureCount: 2 });
    const worker = createSchedulerWorker({
      repository,
      executeSchedule: jest.fn().mockResolvedValue({
        status: 'interrupted',
        conversationId: 'conversation-1',
      }),
      workerId: 'worker-a',
      autoDisableAfterFailures: 3,
      now: () => new Date(clock),
    });

    expect(await worker.runOnce()).toMatchObject({ executionOutcomes: ['interrupted'] });
    expect(await runs.findOne()).toMatchObject({
      status: 'interrupted',
      skipReason: 'agent_response_unfinished',
    });
    expect(await schedules.findOne()).toMatchObject({
      enabled: true,
      failureCount: 2,
      lastRun: { status: 'interrupted' },
    });
  });

  test('recovers an expired run after the schedule was already advanced', async () => {
    const schedule = await createSchedule();
    const abandoned = await repository.claimOccurrence({
      schedule,
      workerId: 'crashed-worker',
      leaseMs: 30_000,
    });
    await repository.advanceSchedule({
      schedule,
      nextRunAt: new Date('2026-05-15T11:00:00.000Z'),
    });
    await schedules.updateOne(
      { _id: schedule._id },
      { $set: { prompt: 'Edited after the occurrence was claimed' } },
    );
    clock = new Date(clock.getTime() + 30_001);
    const executeSchedule = jest.fn().mockResolvedValue({ recovered: true });
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'recovery-worker',
      now: () => new Date(clock),
    });

    const outcomes = await worker.runOnce();

    expect(outcomes.recoveryOutcomes).toEqual(['completed']);
    expect(executeSchedule).toHaveBeenCalledTimes(1);
    expect(executeSchedule.mock.calls[0][0].run).toMatchObject({
      prompt: 'Original scheduled prompt',
      scheduleName: 'Test Schedule',
      timezone: 'Europe/Berlin',
      cadence: { frequency: 'hourly', hour: 0, minute: 0 },
    });
    expect(await runs.findOne({ _id: abandoned._id })).toMatchObject({
      status: 'success',
      attempt: 2,
      result: { recovered: true },
    });
  });

  test('recovers an expired run and advances a schedule abandoned before advancement', async () => {
    const schedule = await createSchedule();
    await repository.claimOccurrence({
      schedule,
      workerId: 'crashed-worker',
      leaseMs: 30_000,
    });
    clock = new Date(clock.getTime() + 30_001);
    const executeSchedule = jest.fn().mockResolvedValue({ recovered: true });
    const worker = createSchedulerWorker({
      repository,
      executeSchedule,
      workerId: 'recovery-worker',
      now: () => new Date(clock),
    });

    await worker.runOnce();

    expect(executeSchedule).toHaveBeenCalledTimes(1);
    const jitter = scheduleJitterMs('schedule-test');
    expect(await schedules.findOne({ _id: schedule._id })).toMatchObject({
      nextRunAt: new Date(new Date('2026-05-15T11:00:00.000Z').getTime() + jitter),
    });
    expect(await runs.countDocuments()).toBe(1);
  });
});

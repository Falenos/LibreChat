'use strict';

const { computeNextRunAt } = require('./cadence');

function serializeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };
}

function createSchedulerWorker({
  repository,
  executeSchedule,
  workerId,
  leaseMs = 60_000,
  batchSize = 25,
  dispatchBatchSize = batchSize,
  maxConcurrency = batchSize,
  executionTimeoutMs = 30 * 60_000,
  autoDisableAfterFailures = 5,
  now = () => new Date(),
  logger = console,
  metrics,
  prepareScheduleRun = async () => undefined,
}) {
  if (typeof executeSchedule !== 'function') {
    throw new TypeError('executeSchedule adapter is required');
  }
  if (typeof prepareScheduleRun !== 'function') {
    throw new TypeError('prepareScheduleRun adapter must be a function');
  }

  let lastProgressAt = null;
  let stopping = false;
  const activeAbortControllers = new Set();
  const activeTasks = new Set();
  const tickWaiters = new Set();
  function onProgress() {
    lastProgressAt = now();
  }

  const wakeTickWaiters = () => {
    for (const resolve of tickWaiters) {
      resolve();
    }
    tickWaiters.clear();
  };

  const ensureScheduleAdvanced = async ({ schedule, run }) => {
    if (
      schedule == null ||
      schedule.enabled !== true ||
      repository.isScheduleDeletionFenced(schedule)
    ) {
      return null;
    }

    const currentNextMs = new Date(schedule.nextRunAt).getTime();
    const scheduledMs = new Date(run.scheduledFor).getTime();
    if (currentNextMs > scheduledMs) {
      return schedule;
    }
    if (currentNextMs !== scheduledMs) {
      return null;
    }
    const nextRunAt = computeNextRunAt({
      cadence: run.cadence,
      timezone: run.timezone,
      scheduleId: run.scheduleId,
      after: now(),
    });
    if (nextRunAt == null) {
      return null;
    }
    return repository.advanceSchedule({ schedule, nextRunAt });
  };

  const applyBookkeeping = async (run) => {
    try {
      await repository.applyRunBookkeeping(run, { autoDisableAfterFailures });
    } catch (error) {
      logger.error?.(`[scheduler] bookkeeping failed for ${run.occurrenceKey}: ${error.message}`);
    }
  };

  const interruptRun = async ({ run, reason }) => {
    const interrupted = await repository.skipRun({
      runId: run._id,
      leaseToken: run.leaseToken,
      reason,
    });
    if (interrupted != null) {
      await applyBookkeeping(interrupted);
    }
    return interrupted == null ? 'lease_lost' : 'interrupted';
  };

  const executeClaimedRun = async ({ schedule, run }) => {
    let advanced;
    if (run.trigger === 'manual') {
      advanced =
        schedule != null &&
        schedule.configRevision === run.configRevision &&
        !repository.isScheduleDeletionFenced(schedule)
          ? schedule
          : null;
    } else {
      advanced = await ensureScheduleAdvanced({ schedule, run });
    }
    if (advanced == null) {
      const skipped = await repository.skipRun({
        runId: run._id,
        leaseToken: run.leaseToken,
        reason: 'schedule_changed_after_claim',
      });
      if (skipped != null) {
        await applyBookkeeping(skipped);
      }
      return 'schedule_changed';
    }

    const abortController = new AbortController();
    activeAbortControllers.add(abortController);
    let leaseLost = false;
    let renewalInFlight = false;
    let leaseDeadlineTimer;
    let executionTimeoutTimer;
    let executionTimedOut = false;
    const loseLease = () => {
      if (leaseLost) {
        return;
      }
      leaseLost = true;
      abortController.abort(new Error('scheduler lease lost'));
    };
    const armLeaseDeadline = (leaseExpiresAt) => {
      clearTimeout(leaseDeadlineTimer);
      const remainingMs = Math.max(0, new Date(leaseExpiresAt).getTime() - now().getTime());
      leaseDeadlineTimer = setTimeout(loseLease, remainingMs);
      leaseDeadlineTimer.unref?.();
    };
    armLeaseDeadline(run.leaseExpiresAt);
    if (stopping) {
      abortController.abort(new Error('scheduler worker stopping'));
    }
    const renewalTimer = setInterval(
      async () => {
        if (renewalInFlight || leaseLost) {
          return;
        }
        renewalInFlight = true;
        try {
          const renewed = await repository.renewRunLease({
            runId: run._id,
            leaseToken: run.leaseToken,
            leaseMs,
          });
          if (renewed == null) {
            loseLease();
          } else {
            armLeaseDeadline(renewed.leaseExpiresAt);
            onProgress();
          }
        } catch (error) {
          logger.error?.(
            `[scheduler] lease renewal failed for ${run.occurrenceKey}: ${error.message}`,
          );
        } finally {
          renewalInFlight = false;
        }
      },
      Math.max(100, Math.floor(leaseMs / 3)),
    );
    renewalTimer.unref?.();
    if (executionTimeoutMs > 0) {
      executionTimeoutTimer = setTimeout(() => {
        executionTimedOut = true;
        abortController.abort(new Error('scheduler execution timed out'));
      }, executionTimeoutMs);
      executionTimeoutTimer.unref?.();
    }

    const startedAt = now();
    try {
      const result = await executeSchedule({
        schedule: advanced,
        run,
        signal: abortController.signal,
      });
      if (leaseLost) {
        return 'lease_lost';
      }
      if (result?.status === 'interrupted') {
        return interruptRun({
          run,
          reason: result.interruptionReason ?? 'agent_response_unfinished',
        });
      }
      const completed = await repository.completeRun({
        runId: run._id,
        leaseToken: run.leaseToken,
        result,
      });
      if (completed != null) {
        await applyBookkeeping(completed);
      }
      return completed == null ? 'lease_lost' : 'completed';
    } catch (error) {
      if (leaseLost) {
        return 'lease_lost';
      }
      if (executionTimedOut) {
        return interruptRun({ run, reason: 'execution_timeout' });
      }
      if (stopping && abortController.signal.aborted) {
        return interruptRun({ run, reason: 'worker_stopping' });
      }
      const failed = await repository.failRun({
        runId: run._id,
        leaseToken: run.leaseToken,
        error: serializeError(error),
      });
      if (failed != null) {
        await applyBookkeeping(failed);
      }
      logger.error?.(`[scheduler] execution failed for ${run.occurrenceKey}: ${error.message}`);
      return failed == null ? 'lease_lost' : 'failed';
    } finally {
      activeAbortControllers.delete(abortController);
      clearInterval(renewalTimer);
      clearTimeout(leaseDeadlineTimer);
      clearTimeout(executionTimeoutTimer);
      metrics?.recordExecutionDuration?.(Math.max(0, now().getTime() - startedAt.getTime()) / 1000);
    }
  };

  const dispatchSchedule = async (schedule) => {
    if (stopping) {
      return 'stopping';
    }
    const execution = await prepareScheduleRun(schedule);
    const run = await repository.enqueueOccurrence({ schedule, execution });
    if (run == null) {
      return 'already_claimed';
    }
    onProgress();
    const advanced = await ensureScheduleAdvanced({ schedule, run });
    if (advanced == null) {
      const interrupted = await repository.interruptQueuedRun({
        runId: run._id,
        reason: 'schedule_changed_after_dispatch',
      });
      if (interrupted != null) {
        await applyBookkeeping(interrupted);
      }
      return 'schedule_changed';
    }
    return 'queued';
  };

  const recoverRun = async (expiredRun) => {
    if (stopping) {
      return 'stopping';
    }
    const run = await repository.reclaimExpiredRun({
      run: expiredRun,
      workerId,
      leaseMs,
    });
    if (run == null) {
      return 'already_claimed';
    }
    onProgress();
    const schedule = await repository.getSchedule(run.scheduleId);
    return executeClaimedRun({ schedule, run });
  };

  const processQueuedRun = async (queuedRun) => {
    if (stopping) {
      return 'stopping';
    }
    const run = await repository.claimQueuedRun({
      run: queuedRun,
      workerId,
      leaseMs,
    });
    if (run == null) {
      return 'already_claimed';
    }
    onProgress();
    const schedule = await repository.getSchedule(run.scheduleId);
    return executeClaimedRun({ schedule, run });
  };

  const trackExecution = (kind, execution) => {
    const task = Promise.resolve(execution)
      .then((outcome) => {
        metrics?.recordExecution?.(outcome);
        return { kind, outcome };
      })
      .catch((error) => {
        logger.error?.(`[scheduler] unexpected ${kind} task failure: ${error.message}`);
        metrics?.recordExecution?.('unexpected_error');
        return { kind, outcome: 'unexpected_error' };
      })
      .finally(() => {
        activeTasks.delete(task);
        onProgress();
        wakeTickWaiters();
      });
    activeTasks.add(task);
    return task;
  };

  const fillExecutionSlots = async () => {
    const available = Math.max(0, maxConcurrency - activeTasks.size);
    if (available === 0 || stopping) {
      return [];
    }

    const expiredRuns = await repository.listExpiredRuns({ at: now(), limit: available });
    const tasks = expiredRuns.map((run) => trackExecution('recovery', recoverRun(run)));
    const queuedCapacity = Math.max(0, available - tasks.length);
    if (queuedCapacity > 0 && !stopping) {
      const queuedRuns = await repository.listQueuedRuns({ limit: queuedCapacity });
      tasks.push(...queuedRuns.map((run) => trackExecution('queued', processQueuedRun(run))));
    }
    return tasks;
  };

  const tick = async () => {
    if (stopping) {
      return { dispatchOutcomes: [], executionTasks: [] };
    }
    const unbookkeptRuns = await repository.listUnbookkeptRuns({ limit: batchSize });
    await Promise.all(unbookkeptRuns.map(applyBookkeeping));
    const schedules = stopping
      ? []
      : await repository.listDueSchedules({ at: now(), limit: dispatchBatchSize });
    const dispatchOutcomes = await Promise.all(schedules.map(dispatchSchedule));
    for (const outcome of dispatchOutcomes) {
      metrics?.recordDispatch?.(outcome);
    }
    const executionTasks = await fillExecutionSlots();
    const queueStats = await repository.getQueueStats({ at: now() });
    metrics?.setState?.({
      active: activeTasks.size,
      capacity: maxConcurrency,
      queued: queueStats.queued,
      oldestQueueAgeSeconds: queueStats.oldestAgeMs / 1000,
    });
    onProgress();
    return { dispatchOutcomes, executionTasks };
  };

  const runOnce = async () => {
    const { dispatchOutcomes, executionTasks } = await tick();
    const settled = await Promise.all(executionTasks);
    return {
      dispatchOutcomes,
      recoveryOutcomes: settled
        .filter(({ kind }) => kind === 'recovery')
        .map(({ outcome }) => outcome),
      queuedOutcomes: settled.filter(({ kind }) => kind === 'queued').map(({ outcome }) => outcome),
      executionOutcomes: settled.map(({ outcome }) => outcome),
    };
  };

  const stop = () => {
    stopping = true;
    for (const controller of activeAbortControllers) {
      controller.abort(new Error('scheduler worker stopping'));
    }
    wakeTickWaiters();
  };

  const waitForNextTick = (timeoutMs) =>
    new Promise((resolve) => {
      if (stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        tickWaiters.delete(done);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        tickWaiters.delete(done);
        resolve();
      };
      tickWaiters.add(done);
    });

  const waitForIdle = async () => {
    while (activeTasks.size > 0) {
      await Promise.allSettled([...activeTasks]);
    }
  };

  return {
    tick,
    runOnce,
    stop,
    waitForNextTick,
    waitForIdle,
    getActiveCount: () => activeTasks.size,
    getLastProgressAt: () => lastProgressAt,
  };
}

module.exports = { createSchedulerWorker, serializeError };

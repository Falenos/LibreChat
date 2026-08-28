'use strict';

const crypto = require('crypto');
const {
  cancelClaimedTranslationJob,
  claimNextTranslationJob,
  clearTranslationCleanupDebt,
  completeTranslationJob,
  deferTranslationCleanupDebt,
  failTranslationJob,
  finalizeTranslationJobExpiry,
  findTranslationReconcileCandidates,
  getTranslationJobConfig,
  getTranslationJobModel,
  heartbeatTranslationJob,
  prepareTranslationAttempt,
  reconcileMissingConversationTranslationJobs,
  recordTranslationCleanupDebt,
  recoverExpiredTranslationJob,
} = require('./jobs');
const { beginTranslationObservation } = require('./observability');

function createTranslationOutputCleanup({ findFiles, deletePersistedFiles, deleteLocatedOutput }) {
  return async (files, job) => {
    let outputFileIds = files.map((file) => file.file_id);
    if (job.planned_output_file_ids?.length) {
      outputFileIds = job.planned_output_file_ids;
    }
    if (job.current_output_file_ids?.length) {
      outputFileIds = job.current_output_file_ids;
    }
    const expectedIds = new Set(outputFileIds);
    const supplied = files.filter((file) => expectedIds.has(file.file_id));
    const knownIds = new Set(supplied.map((file) => file.file_id));
    const missingIds = [...expectedIds].filter((fileId) => !knownIds.has(fileId));
    const persisted = missingIds.length ? await findFiles(missingIds, job) : [];
    const outputFiles = [...supplied, ...(persisted ?? [])];
    if (outputFiles.length) {
      await deletePersistedFiles(outputFiles, job);
    }
    const persistedIds = new Set((persisted ?? []).map((file) => file.file_id));
    const metadataFreeIds = missingIds.filter((fileId) => !persistedIds.has(fileId));
    if (!metadataFreeIds.length) return;
    const locators = new Map(
      (job.current_output_locators ?? []).map((locator) => [locator.file_id, locator]),
    );
    const currentAttempt = (job.attempt_outputs ?? []).find(
      (attempt) => attempt.generation === job.target_generation,
    );
    for (const fileId of metadataFreeIds) {
      const locator = locators.get(fileId);
      if (!locator) {
        if (currentAttempt?.locator_fenced === true) {
          continue;
        }
        throw new Error(`translation cleanup locator unavailable for ${fileId}`);
      }
      await deleteLocatedOutput(locator, job);
    }
  };
}

function createTranslationWorker({
  execute,
  cleanupOutputs,
  logger,
  workerId,
  onOutcome,
  onWorkerError,
}) {
  const id = workerId ?? `translation-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let stopped = false;
  let lastProgressAt = Date.now();

  const cleanupUnpublished = async (files, job) => {
    if (!files.length && !job?.planned_output_file_ids?.length) return;
    try {
      await cleanupOutputs(files, job);
    } catch (error) {
      logger.error(
        `[translationWorker:${id}] unpublished output cleanup failed: ${error?.message}`,
      );
    }
  };

  const currentJob = (jobId) => getTranslationJobModel().findOne({ job_id: jobId }).lean();
  const isPublished = (current, generation, outputFileIds) =>
    ['completed', 'partial'].includes(current?.status) &&
    current.published_generation === generation &&
    outputFileIds.length === current.output_file_ids?.length &&
    outputFileIds.every((fileId, index) => fileId === current.output_file_ids[index]);

  const markAndCleanup = async (files, job) => {
    try {
      await recordTranslationCleanupDebt({
        jobId: job.job_id,
        generation: job.target_generation,
        outputFileIds: job.current_output_file_ids ?? files.map((file) => file.file_id),
      });
    } catch (error) {
      logger.error(
        `[translationWorker:${id}][alert][cleanup_debt_write_failed] ${job.job_id}:${job.target_generation}: ${error?.message}`,
      );
    }
    await cleanupUnpublished(files, job);
  };

  const executeClaim = async (claimedJob) => {
    const startedAt = Date.now();
    let observation;
    const recordOutcome = (outcome, errorCode) => {
      observation?.setOutcome(outcome, errorCode);
      onOutcome?.(outcome, (Date.now() - startedAt) / 1000);
    };
    const controller = new AbortController();
    const config = getTranslationJobConfig();
    const job = await prepareTranslationAttempt({
      jobId: claimedJob.job_id,
      token: claimedJob.execution_token,
      generation: claimedJob.target_generation,
    });
    if (!job) {
      recordOutcome('lease_lost');
      return 'lease_lost';
    }
    observation = beginTranslationObservation(job, logger);
    const deadlineAt = new Date(job.deadline_at).getTime();
    const deadline = setTimeout(
      () => {
        controller.abort(
          Object.assign(new Error('translation job exceeded its maximum age'), {
            code: 'translation_job_deadline',
          }),
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    deadline.unref?.();
    const heartbeat = setInterval(async () => {
      try {
        const owned = await heartbeatTranslationJob({
          jobId: job.job_id,
          token: job.execution_token,
          generation: job.target_generation,
        });
        if (!owned) {
          controller.abort(
            Object.assign(new Error('translation job ownership lost'), { code: 'lease_lost' }),
          );
        } else {
          lastProgressAt = Date.now();
        }
      } catch (error) {
        logger.warn(`[translationWorker:${id}] heartbeat failed: ${error?.message}`);
        controller.abort(
          Object.assign(new Error('translation job heartbeat failed'), { code: 'lease_lost' }),
        );
      }
    }, config.heartbeatMs);
    heartbeat.unref?.();
    let result;
    try {
      result = await observation.run(() => execute(job, controller.signal));
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const outputFileIds = result.files.map((file) => file.file_id);
      let completed;
      try {
        completed = await completeTranslationJob({
          jobId: job.job_id,
          token: job.execution_token,
          generation: job.target_generation,
          outputFileIds,
          report: result.report,
        });
      } catch (error) {
        let current;
        try {
          current = await currentJob(job.job_id);
        } catch (readError) {
          logger.warn(
            `[translationWorker:${id}] completion acknowledgement and readback are ambiguous for ${job.job_id}:${job.target_generation}: ${readError?.message}`,
          );
          recordOutcome('ambiguous', 'completion_acknowledgement_ambiguous');
          return 'ambiguous';
        }
        if (isPublished(current, job.target_generation, outputFileIds)) {
          recordOutcome(current.status);
          return current.status;
        }
        throw error;
      }
      if (!completed) {
        let current;
        try {
          current = await currentJob(job.job_id);
        } catch (error) {
          logger.warn(
            `[translationWorker:${id}] completion miss readback is ambiguous for ${job.job_id}:${job.target_generation}: ${error?.message}`,
          );
          recordOutcome('ambiguous', 'completion_readback_ambiguous');
          return 'ambiguous';
        }
        if (isPublished(current, job.target_generation, outputFileIds)) {
          recordOutcome(current.status);
          return current.status;
        }
        await markAndCleanup(result.files, job);
        recordOutcome('lease_lost', 'lease_lost');
        return 'lease_lost';
      }
      recordOutcome(completed.status);
      return completed.status;
    } catch (error) {
      const unpublishedFiles = result?.files ?? error?.outputFiles ?? [];
      if (controller.signal.aborted) {
        if (controller.signal.reason?.code === 'translation_job_deadline') {
          const failed = await failTranslationJob({ job, error: controller.signal.reason });
          if (failed) {
            await cleanupUnpublished(unpublishedFiles, job);
            recordOutcome(failed.status, controller.signal.reason?.code);
            return failed.status;
          }
        }
        const current = await currentJob(job.job_id);
        if (current?.cancel_requested_at && current.execution_token === job.execution_token) {
          const cancelled = await cancelClaimedTranslationJob({
            jobId: job.job_id,
            token: job.execution_token,
            generation: job.target_generation,
          });
          if (cancelled) await cleanupUnpublished(unpublishedFiles, job);
          recordOutcome('cancelled', 'translation_cancelled');
          return 'cancelled';
        }
        await markAndCleanup(unpublishedFiles, job);
        recordOutcome('lease_lost', controller.signal.reason?.code ?? 'lease_lost');
        return 'lease_lost';
      }
      const failed = await failTranslationJob({ job, error });
      if (failed) await cleanupUnpublished(unpublishedFiles, job);
      if (!failed) {
        const current = await currentJob(job.job_id);
        if (current?.cancel_requested_at && current.execution_token === job.execution_token) {
          const cancelled = await cancelClaimedTranslationJob({
            jobId: job.job_id,
            token: job.execution_token,
            generation: job.target_generation,
          });
          if (cancelled) await cleanupUnpublished(unpublishedFiles, job);
          recordOutcome('cancelled', 'translation_cancelled');
          return 'cancelled';
        }
        await markAndCleanup(unpublishedFiles, job);
      }
      const outcome = failed?.status ?? 'lease_lost';
      logger.warn(
        `[translationWorker:${id}] ${job.job_id} ${outcome}: ${error?.code ?? 'translation_failed'}`,
      );
      recordOutcome(outcome, error?.code);
      return outcome;
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      observation?.end();
      lastProgressAt = Date.now();
    }
  };

  const processNextDue = async () => {
    if (stopped) return 'stopped';
    const recovered = await recoverExpiredTranslationJob();
    if (recovered) {
      lastProgressAt = Date.now();
      await cleanupUnpublished([], recovered);
      if (['cancelled', 'failed'].includes(recovered.status)) {
        onOutcome?.(recovered.status, 0);
      }
      return recovered.status;
    }
    const job = await claimNextTranslationJob({ workerId: id });
    lastProgressAt = Date.now();
    if (!job) return 'idle';
    return executeClaim(job);
  };

  const reconcileOnce = async () => {
    const config = getTranslationJobConfig();
    const now = new Date();
    try {
      await reconcileMissingConversationTranslationJobs({
        now,
        limit: config.reconcileBatchLimit,
      });
    } catch (error) {
      onWorkerError?.('conversation_reconcile');
      logger.warn(
        `[translationWorker:${id}] conversation reconciliation failed: ${error?.message}`,
      );
    }
    let candidates;
    try {
      candidates = await findTranslationReconcileCandidates({
        now,
        limit: config.reconcileBatchLimit,
      });
    } catch (error) {
      onWorkerError?.('cleanup_scan');
      throw error;
    }
    let cleaned = 0;
    let finalized = 0;
    for (const candidate of candidates) {
      const attempts = (candidate.attempt_outputs ?? []).filter(
        (attempt) =>
          attempt.cleanup_status === 'cleanup_pending' &&
          attempt.cleanup_after &&
          new Date(attempt.cleanup_after) <= now,
      );
      for (const attempt of attempts) {
        try {
          await cleanupOutputs([], {
            ...candidate,
            target_generation: attempt.generation,
            current_output_file_ids: attempt.output_file_ids,
            current_output_locators: attempt.storage_locators ?? [],
            planned_output_file_ids: attempt.output_file_ids,
          });
          if (
            await clearTranslationCleanupDebt({
              jobId: candidate.job_id,
              generation: attempt.generation,
              now,
            })
          ) {
            cleaned += 1;
          }
        } catch (error) {
          onWorkerError?.('cleanup_reconcile');
          logger.warn(
            `[translationWorker:${id}] cleanup reconciliation failed for ${candidate.job_id}:${attempt.generation}: ${error?.message}`,
          );
          try {
            await deferTranslationCleanupDebt({
              jobId: candidate.job_id,
              generation: attempt.generation,
              now,
            });
          } catch (deferError) {
            logger.error(
              `[translationWorker:${id}][alert][cleanup_debt_defer_failed] ${candidate.job_id}:${attempt.generation}: ${deferError?.message}`,
            );
          }
        }
      }
      try {
        if (await finalizeTranslationJobExpiry({ jobId: candidate.job_id, now })) {
          finalized += 1;
        }
      } catch (error) {
        onWorkerError?.('finalize_reconcile');
        logger.warn(
          `[translationWorker:${id}] expiry reconciliation failed for ${candidate.job_id}: ${error?.message}`,
        );
      }
    }
    lastProgressAt = Date.now();
    return { scanned: candidates.length, cleaned, finalized };
  };

  const lane = async () => {
    const config = getTranslationJobConfig();
    while (!stopped) {
      let outcome;
      try {
        outcome = await processNextDue();
      } catch (error) {
        lastProgressAt = Date.now();
        onWorkerError?.('claim');
        logger.error(`[translationWorker:${id}] claim loop failed: ${error?.message}`);
        outcome = 'error';
      }
      if (outcome === 'idle' || outcome === 'error') {
        await new Promise((resolve) => setTimeout(resolve, config.pollMs));
      }
    }
  };

  const start = () => {
    stopped = false;
    return Promise.all(Array.from({ length: getTranslationJobConfig().concurrency }, lane));
  };
  const stop = () => {
    stopped = true;
  };

  return {
    executeClaim,
    getLastProgressAt: () => lastProgressAt,
    processNextDue,
    reconcileOnce,
    start,
    stop,
    workerId: id,
  };
}

module.exports = { createTranslationOutputCleanup, createTranslationWorker };

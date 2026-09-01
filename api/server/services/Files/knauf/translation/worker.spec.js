'use strict';

jest.mock('./jobs', () => ({
  cancelClaimedTranslationJob: jest.fn(),
  claimNextTranslationJob: jest.fn(),
  clearTranslationCleanupDebt: jest.fn(),
  completeTranslationJob: jest.fn(),
  deferTranslationCleanupDebt: jest.fn(),
  failTranslationJob: jest.fn(),
  finalizeTranslationJobExpiry: jest.fn(),
  findTranslationReconcileCandidates: jest.fn(),
  getTranslationJobConfig: jest.fn(() => ({
    heartbeatMs: 60000,
    pollMs: 1,
    concurrency: 1,
    maxJobAgeMs: 60000,
    reconcileBatchLimit: 25,
  })),
  getTranslationJobModel: jest.fn(),
  heartbeatTranslationJob: jest.fn(),
  prepareTranslationAttempt: jest.fn(),
  reconcileMissingConversationTranslationJobs: jest.fn(),
  recordTranslationCleanupDebt: jest.fn(),
  recoverExpiredTranslationJob: jest.fn(),
}));

const jobs = require('./jobs');
const { createTranslationOutputCleanup, createTranslationWorker } = require('./worker');

const job = {
  job_id: 'job-1',
  execution_token: 'token-1',
  attempt_count: 1,
  target_generation: 1,
  deadline_at: new Date(Date.now() + 60_000),
  current_output_file_ids: ['out-1'],
  planned_output_file_ids: ['out-1'],
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  jobs.getTranslationJobConfig.mockReturnValue({
    heartbeatMs: 60000,
    pollMs: 1,
    concurrency: 1,
    maxJobAgeMs: 60000,
    reconcileBatchLimit: 25,
  });
  jobs.completeTranslationJob.mockResolvedValue({ status: 'completed' });
  jobs.failTranslationJob.mockResolvedValue({ status: 'retrying' });
  jobs.prepareTranslationAttempt.mockImplementation(async ({ jobId, token, generation }) => ({
    ...job,
    job_id: jobId,
    execution_token: token,
    target_generation: generation,
  }));
  jobs.recordTranslationCleanupDebt.mockResolvedValue(true);
  jobs.clearTranslationCleanupDebt.mockResolvedValue(true);
  jobs.deferTranslationCleanupDebt.mockResolvedValue(true);
  jobs.finalizeTranslationJobExpiry.mockResolvedValue(null);
  jobs.findTranslationReconcileCandidates.mockResolvedValue([]);
  jobs.reconcileMissingConversationTranslationJobs.mockResolvedValue({
    scanned: 0,
    cancelled: 0,
  });
  jobs.recoverExpiredTranslationJob.mockResolvedValue(null);
  jobs.getTranslationJobModel.mockReturnValue({
    findOne: () => ({ lean: () => Promise.resolve(null) }),
  });
});

describe('[knauf] translation worker', () => {
  it('publishes output only after token-fenced completion', async () => {
    const execute = jest.fn().mockResolvedValue({
      files: [{ file_id: 'out-1' }],
      report: { status: 'completed' },
    });
    const cleanupOutputs = jest.fn();
    const worker = createTranslationWorker({ execute, cleanupOutputs, logger, workerId: 'w1' });

    await expect(worker.executeClaim(job)).resolves.toBe('completed');
    expect(jobs.completeTranslationJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', token: 'token-1', outputFileIds: ['out-1'] }),
    );
    expect(cleanupOutputs).not.toHaveBeenCalled();
  });

  it('deletes only the stale generation when completion loses ownership', async () => {
    jobs.completeTranslationJob.mockResolvedValue(null);
    const files = [{ file_id: 'out-1' }];
    const cleanupOutputs = jest.fn().mockResolvedValue(undefined);
    const worker = createTranslationWorker({
      execute: jest.fn().mockResolvedValue({ files, report: { status: 'completed' } }),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('lease_lost');
    expect(jobs.recordTranslationCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', generation: 1, outputFileIds: ['out-1'] }),
    );
    expect(cleanupOutputs).toHaveBeenCalledWith(files, expect.objectContaining(job));
  });

  it('accepts an ambiguously acknowledged completion without deleting published output', async () => {
    jobs.completeTranslationJob.mockRejectedValue(new Error('Mongo acknowledgement lost'));
    jobs.getTranslationJobModel.mockReturnValue({
      findOne: () => ({
        lean: () =>
          Promise.resolve({
            status: 'completed',
            published_generation: 1,
            output_file_ids: ['out-1'],
          }),
      }),
    });
    const cleanupOutputs = jest.fn();
    const worker = createTranslationWorker({
      execute: jest.fn().mockResolvedValue({
        files: [{ file_id: 'out-1' }],
        report: { status: 'completed' },
      }),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('completed');
    expect(cleanupOutputs).not.toHaveBeenCalled();
    expect(jobs.failTranslationJob).not.toHaveBeenCalled();
  });

  it('defers cleanup when completion and generation readback are both ambiguous', async () => {
    jobs.completeTranslationJob.mockRejectedValue(new Error('Mongo acknowledgement lost'));
    jobs.getTranslationJobModel.mockReturnValue({
      findOne: () => ({
        lean: () => Promise.reject(new Error('Mongo read unavailable')),
      }),
    });
    const cleanupOutputs = jest.fn();
    const worker = createTranslationWorker({
      execute: jest.fn().mockResolvedValue({
        files: [{ file_id: 'out-1' }],
        report: { status: 'completed' },
      }),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('ambiguous');
    expect(cleanupOutputs).not.toHaveBeenCalled();
    expect(jobs.recordTranslationCleanupDebt).not.toHaveBeenCalled();
    expect(jobs.failTranslationJob).not.toHaveBeenCalled();
  });

  it('classifies execution failures through the durable retry state machine', async () => {
    const error = Object.assign(new Error('rate limited'), { status: 429 });
    const worker = createTranslationWorker({
      execute: jest.fn().mockRejectedValue(error),
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('retrying');
    expect(jobs.failTranslationJob).toHaveBeenCalledWith({ job, error });
  });

  it('fails a job permanently when its whole-job deadline expires', async () => {
    jobs.getTranslationJobConfig.mockReturnValue({
      heartbeatMs: 60000,
      pollMs: 1,
      concurrency: 1,
      maxJobAgeMs: 1,
      reconcileBatchLimit: 25,
    });
    jobs.failTranslationJob.mockResolvedValue({ status: 'failed' });
    const execute = jest.fn(
      (_job, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const worker = createTranslationWorker({
      execute,
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
    });

    jobs.prepareTranslationAttempt.mockResolvedValueOnce({ ...job, deadline_at: new Date(0) });
    await expect(worker.executeClaim(job)).resolves.toBe('failed');
    expect(jobs.failTranslationJob).toHaveBeenCalledWith({
      job: expect.objectContaining({ job_id: job.job_id }),
      error: expect.objectContaining({ code: 'translation_job_deadline' }),
    });
  });

  it('deletes outputs persisted before an interrupted multi-file job failed', async () => {
    const outputFiles = [{ file_id: 'out-1' }];
    const error = Object.assign(new Error('cancelled'), { outputFiles });
    const cleanupOutputs = jest.fn().mockResolvedValue(undefined);
    const worker = createTranslationWorker({
      execute: jest.fn().mockRejectedValue(error),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('retrying');
    expect(cleanupOutputs).toHaveBeenCalledWith(outputFiles, job);
  });

  it('records cancellation when it wins after execution fails', async () => {
    jobs.failTranslationJob.mockResolvedValue(null);
    jobs.getTranslationJobModel.mockReturnValue({
      findOne: () => ({
        lean: () =>
          Promise.resolve({
            cancel_requested_at: new Date(),
            execution_token: job.execution_token,
          }),
      }),
    });
    jobs.cancelClaimedTranslationJob.mockResolvedValue({ status: 'cancelled' });
    const onOutcome = jest.fn();
    const worker = createTranslationWorker({
      execute: jest.fn().mockRejectedValue(new Error('interrupted')),
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
      onOutcome,
    });

    await expect(worker.executeClaim(job)).resolves.toBe('cancelled');
    expect(jobs.cancelClaimedTranslationJob).toHaveBeenCalledWith({
      jobId: job.job_id,
      token: job.execution_token,
      generation: job.target_generation,
    });
    expect(onOutcome).toHaveBeenCalledWith('cancelled', expect.any(Number));
  });

  it('keeps durable state transitions running when output cleanup fails', async () => {
    const worker = createTranslationWorker({
      execute: jest.fn().mockRejectedValue(
        Object.assign(new Error('rate limited'), {
          status: 429,
          outputFiles: [{ file_id: 'out-1' }],
        }),
      ),
      cleanupOutputs: jest.fn().mockRejectedValue(new Error('blob unavailable')),
      logger,
      workerId: 'w1',
    });

    await expect(worker.executeClaim(job)).resolves.toBe('retrying');
    expect(jobs.failTranslationJob).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
  });

  it('stops claiming new work and drains the active claim', async () => {
    let finish;
    const execute = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    jobs.claimNextTranslationJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    const worker = createTranslationWorker({
      execute,
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
    });

    const loop = worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    worker.stop();
    finish({ files: [], report: { status: 'completed' } });
    await loop;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(jobs.claimNextTranslationJob).toHaveBeenCalledTimes(1);
  });

  it('cleans planned outputs after finalizing an expired cancellation', async () => {
    const recovered = {
      ...job,
      status: 'cancelled',
      planned_output_file_ids: ['out-1'],
    };
    jobs.recoverExpiredTranslationJob.mockResolvedValueOnce(recovered);
    const cleanupOutputs = jest.fn();
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.processNextDue()).resolves.toBe('cancelled');
    expect(cleanupOutputs).toHaveBeenCalledWith([], recovered);
    expect(jobs.claimNextTranslationJob).not.toHaveBeenCalled();
  });

  it('reconciles cleanup debt independently and then starts terminal TTL', async () => {
    const due = new Date(Date.now() - 1);
    jobs.findTranslationReconcileCandidates.mockResolvedValueOnce([
      {
        ...job,
        status: 'failed',
        active: false,
        attempt_outputs: [
          {
            generation: 1,
            output_file_ids: ['out-1'],
            cleanup_status: 'cleanup_pending',
            cleanup_after: due,
          },
        ],
      },
    ]);
    jobs.finalizeTranslationJobExpiry.mockResolvedValueOnce({ status: 'failed' });
    const cleanupOutputs = jest.fn().mockResolvedValue(undefined);
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.reconcileOnce()).resolves.toEqual({
      scanned: 1,
      cleaned: 1,
      finalized: 1,
    });
    expect(cleanupOutputs).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        target_generation: 1,
        current_output_file_ids: ['out-1'],
      }),
    );
    expect(jobs.clearTranslationCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', generation: 1 }),
    );
  });

  it('reaps a metadata-free late blob from its durable locator after restart', async () => {
    const due = new Date(Date.now() - 1);
    const locator = {
      file_id: 'out-1',
      source: 'local',
      filepath: '/uploads/user-1/out-1__translated.docx',
      filename: 'translated.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    jobs.findTranslationReconcileCandidates.mockResolvedValueOnce([
      {
        ...job,
        status: 'failed',
        active: false,
        attempt_outputs: [
          {
            generation: 1,
            output_file_ids: ['out-1'],
            storage_locators: [locator],
            cleanup_status: 'cleanup_pending',
            cleanup_after: due,
          },
        ],
      },
    ]);
    const deleteLocatedOutput = jest.fn().mockResolvedValue(undefined);
    const cleanupOutputs = createTranslationOutputCleanup({
      findFiles: jest.fn().mockResolvedValue([]),
      deletePersistedFiles: jest.fn(),
      deleteLocatedOutput,
    });
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'restarted-worker',
    });

    await expect(worker.reconcileOnce()).resolves.toMatchObject({ cleaned: 1 });
    expect(deleteLocatedOutput).toHaveBeenCalledWith(
      locator,
      expect.objectContaining({ target_generation: 1 }),
    );
    expect(jobs.clearTranslationCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', generation: 1 }),
    );
  });

  it('clears cleanup debt for outputs that never produced metadata or a locator', async () => {
    const due = new Date(Date.now() - 1);
    jobs.findTranslationReconcileCandidates.mockResolvedValueOnce([
      {
        ...job,
        status: 'failed',
        active: false,
        attempt_outputs: [
          {
            generation: 1,
            output_file_ids: ['never-written'],
            storage_locators: [],
            locator_fenced: true,
            cleanup_status: 'cleanup_pending',
            cleanup_after: due,
          },
        ],
      },
    ]);
    const deletePersistedFiles = jest.fn();
    const deleteLocatedOutput = jest.fn();
    const cleanupOutputs = createTranslationOutputCleanup({
      findFiles: jest.fn().mockResolvedValue([]),
      deletePersistedFiles,
      deleteLocatedOutput,
    });
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'restarted-worker',
    });

    await expect(worker.reconcileOnce()).resolves.toMatchObject({ cleaned: 1 });
    expect(deletePersistedFiles).not.toHaveBeenCalled();
    expect(deleteLocatedOutput).not.toHaveBeenCalled();
    expect(jobs.clearTranslationCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', generation: 1 }),
    );
  });

  it('keeps legacy locator-less cleanup debt pending because blob absence is unproven', async () => {
    const due = new Date(Date.now() - 1);
    jobs.findTranslationReconcileCandidates.mockResolvedValueOnce([
      {
        ...job,
        status: 'failed',
        active: false,
        attempt_outputs: [
          {
            generation: 1,
            output_file_ids: ['legacy-output'],
            storage_locators: [],
            locator_fenced: false,
            cleanup_status: 'cleanup_pending',
            cleanup_after: due,
          },
        ],
      },
    ]);
    const cleanupOutputs = createTranslationOutputCleanup({
      findFiles: jest.fn().mockResolvedValue([]),
      deletePersistedFiles: jest.fn(),
      deleteLocatedOutput: jest.fn(),
    });
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'restarted-worker',
    });

    await expect(worker.reconcileOnce()).resolves.toMatchObject({ cleaned: 0 });
    expect(jobs.clearTranslationCleanupDebt).not.toHaveBeenCalled();
  });

  it('keeps cleanup debt when persisted-file deletion reports failure and retries it', async () => {
    const due = new Date(Date.now() - 1);
    const candidate = {
      ...job,
      status: 'failed',
      active: false,
      attempt_outputs: [
        {
          generation: 1,
          output_file_ids: ['out-1'],
          cleanup_status: 'cleanup_pending',
          cleanup_after: due,
        },
      ],
    };
    jobs.findTranslationReconcileCandidates
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([candidate]);
    const deletePersistedFiles = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('storage cleanup failed'), { failedFileIds: ['out-1'] }),
      )
      .mockResolvedValueOnce(undefined);
    const cleanupOutputs = createTranslationOutputCleanup({
      findFiles: jest.fn().mockResolvedValue([{ file_id: 'out-1' }]),
      deletePersistedFiles,
      deleteLocatedOutput: jest.fn(),
    });
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs,
      logger,
      workerId: 'w1',
    });

    await expect(worker.reconcileOnce()).resolves.toMatchObject({ cleaned: 0 });
    expect(jobs.clearTranslationCleanupDebt).not.toHaveBeenCalled();
    expect(jobs.deferTranslationCleanupDebt).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', generation: 1 }),
    );
    await expect(worker.reconcileOnce()).resolves.toMatchObject({ cleaned: 1 });
    expect(deletePersistedFiles).toHaveBeenCalledTimes(2);
    expect(jobs.clearTranslationCleanupDebt).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a transient claim error', async () => {
    let worker;
    jobs.recoverExpiredTranslationJob.mockRejectedValueOnce(new Error('Mongo unavailable'));
    jobs.recoverExpiredTranslationJob.mockImplementationOnce(async () => {
      worker.stop();
      return null;
    });
    const execute = jest.fn();
    worker = createTranslationWorker({
      execute,
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
    });

    await worker.start();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('claim loop failed: Mongo unavailable'),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a bounded worker operation and continues cleanup after conversation scan failure', async () => {
    jobs.reconcileMissingConversationTranslationJobs.mockRejectedValueOnce(
      new Error('Mongo unavailable'),
    );
    const onWorkerError = jest.fn();
    const worker = createTranslationWorker({
      execute: jest.fn(),
      cleanupOutputs: jest.fn(),
      logger,
      workerId: 'w1',
      onWorkerError,
    });

    await expect(worker.reconcileOnce()).resolves.toEqual({
      scanned: 0,
      cleaned: 0,
      finalized: 0,
    });
    expect(onWorkerError).toHaveBeenCalledWith('conversation_reconcile');
    expect(jobs.findTranslationReconcileCandidates).toHaveBeenCalled();
  });
});

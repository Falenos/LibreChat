'use strict';

const { createHash } = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  ATTEMPT_OUTPUT_LEDGER_LIMIT,
  cancelTranslationJobsByConversation,
  claimNextTranslationJob,
  classifyTranslationError,
  clearTranslationCleanupDebt,
  completeTranslationJob,
  computeRetryAt,
  deferTranslationCleanupDebt,
  enqueueTranslationJob,
  failTranslationJob,
  finalizeTranslationJobExpiry,
  findTranslationReconcileCandidates,
  getOwnedTranslationJob,
  getTranslationJobModel,
  heartbeatTranslationJob,
  makeIdempotencyKey,
  prepareTranslationAttempt,
  prepareTranslationStorageLocator,
  reconcileMissingConversationTranslationJobs,
  recoverExpiredTranslationJob,
  releaseOverdueQueuedTranslationJobs,
  requestTranslationCancellation,
  translationArgsForJob,
  upgradeActiveTranslationJobs,
} = require('./jobs');

let mongoServer;
let Model;
let Conversation;

const file = (id = 'f1') => ({
  file_id: id,
  filename: `${id}.docx`,
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  bytes: 1024,
});

const enqueue = async (overrides = {}) => {
  const params = {
    user: 'u1',
    tenantId: 't1',
    conversationId: 'c1',
    files: [file()],
    sourceLocale: null,
    targetLocale: 'de-DE',
    ...overrides,
  };
  if (params.conversationId && params.conversationId !== 'new') {
    await Conversation.updateOne(
      {
        user: String(params.user),
        tenantId: params.tenantId ?? null,
        conversationId: params.conversationId,
      },
      { $setOnInsert: { title: 'Test' } },
      { upsert: true },
    );
  }
  return enqueueTranslationJob(params);
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Conversation =
    mongoose.models.Conversation ||
    mongoose.model(
      'Conversation',
      new mongoose.Schema(
        {
          user: String,
          tenantId: { type: String, default: null },
          conversationId: String,
          title: String,
        },
        { timestamps: true },
      ),
    );
  Model = getTranslationJobModel();
  await Model.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([Model.deleteMany({}), Conversation.deleteMany({})]);
  for (const name of [
    'KNAUF_TRANSLATION_ATTEMPT_CAP',
    'KNAUF_TRANSLATION_AUTH_ATTEMPT_CAP',
    'KNAUF_TRANSLATION_BACKOFF_BASE_MS',
    'KNAUF_TRANSLATION_BACKOFF_MAX_MS',
    'KNAUF_TRANSLATION_LEASE_MS',
  ]) {
    delete process.env[name];
  }
  process.env.KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER = '3';
  process.env.KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL = '10';
  process.env.KNAUF_TRANSLATION_STORAGE_WRITE_TIMEOUT_MS = '1';
  process.env.KNAUF_TRANSLATION_CLEANUP_QUIESCENCE_MS = '1';
});

describe('[knauf] durable translation jobs', () => {
  it('persists the output retention decision with the durable job', async () => {
    const outputExpiresAt = new Date(Date.now() + 60_000);

    const { job } = await enqueue({
      outputExpiresAt,
      outputRetentionResolved: true,
    });

    expect(job.output_retention_resolved).toBe(true);
    expect(job.output_expires_at).toEqual(outputExpiresAt);
  });

  it('converges concurrent duplicate starts on one idempotent job', async () => {
    const jobs = await Promise.all(Array.from({ length: 5 }, () => enqueue()));

    expect(new Set(jobs.map(({ job }) => job.job_id)).size).toBe(1);
    expect(await Model.countDocuments()).toBe(1);
  });

  it('persists preserved terms and includes them in job idempotency', async () => {
    const first = await enqueue({ preserveTerms: ['HERADESIGN'] });
    const duplicate = await enqueue({ preserveTerms: ['HERADESIGN'] });
    const different = await enqueue({ preserveTerms: ['Knauf Ceiling Solutions'] });

    expect(first.job.preserve_terms).toEqual(['HERADESIGN']);
    expect(duplicate).toMatchObject({ created: false, job: { job_id: first.job.job_id } });
    expect(different.job.job_id).not.toBe(first.job.job_id);
    expect(await Model.countDocuments()).toBe(2);
  });

  it('keeps the legacy idempotency payload when no preserved terms are supplied', () => {
    const params = {
      user: 'u1',
      tenantId: 't1',
      conversationId: 'c1',
      files: [file()],
      sourceLocale: null,
      targetLocale: 'de-DE',
      preserveTerms: [],
    };
    const legacyPayload = {
      user: 'u1',
      tenantId: 't1',
      conversationId: 'c1',
      files: ['f1'],
      sourceLocale: null,
      targetLocale: 'de-DE',
      glossaryRevision: process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION || 'none',
    };

    expect(makeIdempotencyKey(params)).toBe(
      createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex'),
    );
  });

  it('reconstructs exact protected terms for worker execution', () => {
    expect(
      translationArgsForJob({
        source_locale: 'en',
        target_locale: 'pl-PL',
        preserve_terms: ['HERADESIGN', 'Heradesign'],
      }),
    ).toEqual({
      source_locale: 'en',
      target_locale: 'pl-PL',
      preserve_terms: ['HERADESIGN', 'Heradesign'],
    });
    expect(
      translationArgsForJob({
        source_locale: null,
        target_locale: 'de',
        preserve_terms: [],
      }),
    ).toEqual({
      source_locale: undefined,
      target_locale: 'de',
    });
  });

  it.each(['failed', 'cancelled'])('creates one fresh attempt after a %s job', async (status) => {
    const first = await enqueue();
    await Model.updateOne(
      { job_id: first.job.job_id },
      { $set: { status, active: false, finished_at: new Date() } },
    );

    const retries = await Promise.all(Array.from({ length: 5 }, () => enqueue()));

    expect(new Set(retries.map(({ job }) => job.job_id)).size).toBe(1);
    expect(retries[0].job.job_id).not.toBe(first.job.job_id);
    expect(await Model.countDocuments()).toBe(2);
  });

  it.each(['completed', 'partial'])('keeps a %s job idempotent', async (status) => {
    const first = await enqueue();
    await Model.updateOne(
      { job_id: first.job.job_id },
      { $set: { status, active: false, finished_at: new Date() } },
    );

    const duplicate = await enqueue();

    expect(duplicate).toMatchObject({ created: false, job: { job_id: first.job.job_id } });
    expect(await Model.countDocuments()).toBe(1);
  });

  it('enforces per-user admission with a partial unique slot index', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER = '1';
    await enqueue();

    await expect(enqueue({ conversationId: 'c2', files: [file('f2')] })).rejects.toMatchObject({
      code: 'translation_user_limit',
      status: 429,
    });
  });

  it('enforces global admission across users', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL = '1';
    await enqueue();

    await expect(
      enqueue({ user: 'u2', conversationId: 'c2', files: [file('f2')] }),
    ).rejects.toMatchObject({ code: 'translation_capacity_full', status: 503 });
  });

  it('allows only one worker to claim and token-fences completion', async () => {
    const { job } = await enqueue();
    const claims = await Promise.all([
      claimNextTranslationJob({ workerId: 'w1' }),
      claimNextTranslationJob({ workerId: 'w2' }),
    ]);
    const claim = claims.find(Boolean);
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await heartbeatTranslationJob({
        jobId: job.job_id,
        token: 'stale',
        generation: prepared.target_generation,
      }),
    ).toBe(false);
    await expect(
      completeTranslationJob({
        jobId: job.job_id,
        token: 'stale',
        generation: prepared.target_generation,
        outputFileIds: prepared.current_output_file_ids,
        report: { status: 'completed' },
      }),
    ).resolves.toBeNull();
    const completed = await completeTranslationJob({
      jobId: job.job_id,
      token: claim.execution_token,
      generation: prepared.target_generation,
      outputFileIds: prepared.current_output_file_ids,
      report: { status: 'completed' },
    });
    expect(completed).toMatchObject({
      status: 'completed',
      active: false,
      published_generation: prepared.target_generation,
    });
  });

  it('extends a live lease only for its current execution token', async () => {
    process.env.KNAUF_TRANSLATION_LEASE_MS = '1000';
    await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const heartbeatAt = new Date(claim.lease_expires_at.getTime() + 1000);

    await expect(
      heartbeatTranslationJob({
        jobId: claim.job_id,
        token: claim.execution_token,
        generation: claim.target_generation,
        now: heartbeatAt,
      }),
    ).resolves.toBe(true);
    const current = await Model.findOne({ job_id: claim.job_id }).lean();
    expect(current.lease_expires_at.getTime()).toBe(heartbeatAt.getTime() + 1000);
    delete process.env.KNAUF_TRANSLATION_LEASE_MS;
  });

  it('backs off an expired lease before issuing a fresh execution token', async () => {
    process.env.KNAUF_TRANSLATION_LEASE_MS = '10';
    process.env.KNAUF_TRANSLATION_BACKOFF_BASE_MS = '1000';
    await enqueue();
    const now = new Date(Date.now() + 1000);
    const first = await claimNextTranslationJob({ workerId: 'w1', now });
    const recovered = await recoverExpiredTranslationJob({
      now: new Date(now.getTime() + 11),
    });
    const tooEarly = await claimNextTranslationJob({
      workerId: 'w2',
      now: new Date(now.getTime() + 11),
    });
    const second = await claimNextTranslationJob({
      workerId: 'w2',
      now: new Date(recovered.next_attempt_at.getTime() + 1),
    });

    expect(recovered).toMatchObject({ job_id: first.job_id, status: 'retrying' });
    expect(tooEarly).toBeNull();
    expect(second).toMatchObject({ job_id: first.job_id, lease_owner: 'w2', attempt_count: 2 });
    expect(second.execution_token).not.toBe(first.execution_token);
    delete process.env.KNAUF_TRANSLATION_LEASE_MS;
    delete process.env.KNAUF_TRANSLATION_BACKOFF_BASE_MS;
  });

  it('rechecks lease expiry in the recovery compare-and-set', async () => {
    process.env.KNAUF_TRANSLATION_LEASE_MS = '10';
    await enqueue();
    const claimedAt = new Date(Date.now() + 1000);
    await claimNextTranslationJob({ workerId: 'w1', now: claimedAt });
    const updateSpy = jest.spyOn(Model, 'findOneAndUpdate');
    const recoveryAt = new Date(claimedAt.getTime() + 11);

    await recoverExpiredTranslationJob({ now: recoveryAt });

    const recoveryCall = updateSpy.mock.calls.find(([filter]) => filter.status === 'processing');
    expect(recoveryCall[0].$or).toEqual([
      { lease_expires_at: { $lte: recoveryAt } },
      { deadline_at: { $lte: recoveryAt } },
    ]);
    updateSpy.mockRestore();
    delete process.env.KNAUF_TRANSLATION_LEASE_MS;
  });

  it('finalizes an expired cancelled claim and releases admission', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER = '1';
    process.env.KNAUF_TRANSLATION_LEASE_MS = '10';
    const { job } = await enqueue();
    const now = new Date(Date.now() + 1000);
    await claimNextTranslationJob({ workerId: 'w1', now });
    await requestTranslationCancellation({ user: 'u1', tenantId: 't1', jobId: job.job_id });

    const recovered = await recoverExpiredTranslationJob({
      now: new Date(now.getTime() + 11),
    });

    expect(recovered).toMatchObject({ status: 'cancelled', active: false });
    expect(recovered.expires_at).toBeNull();
    await expect(enqueue({ conversationId: 'c2', files: [file('f2')] })).resolves.toBeDefined();
    delete process.env.KNAUF_TRANSLATION_LEASE_MS;
  });

  it('fails an expired claim at the attempt cap instead of reclaiming it', async () => {
    process.env.KNAUF_TRANSLATION_ATTEMPT_CAP = '1';
    process.env.KNAUF_TRANSLATION_LEASE_MS = '10';
    await enqueue();
    const now = new Date(Date.now() + 1000);
    const claim = await claimNextTranslationJob({ workerId: 'w1', now });

    const recovered = await recoverExpiredTranslationJob({
      now: new Date(now.getTime() + 11),
    });

    expect(recovered).toMatchObject({
      job_id: claim.job_id,
      status: 'failed',
      active: false,
      last_error_code: 'worker_lease_expired',
    });
    await expect(
      claimNextTranslationJob({ workerId: 'w2', now: new Date(now.getTime() + 12) }),
    ).resolves.toBeNull();
    delete process.env.KNAUF_TRANSLATION_ATTEMPT_CAP;
    delete process.env.KNAUF_TRANSLATION_LEASE_MS;
  });

  it('scopes status lookup to both user and tenant', async () => {
    const { job } = await enqueue();

    await expect(
      getOwnedTranslationJob({ user: 'u1', tenantId: 'foreign', jobId: job.job_id }),
    ).resolves.toBeNull();
    await expect(
      getOwnedTranslationJob({ user: 'foreign', tenantId: 't1', jobId: job.job_id }),
    ).resolves.toBeNull();
  });

  it('does not reschedule a claim after cancellation wins the race', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    await requestTranslationCancellation({ user: 'u1', tenantId: 't1', jobId: job.job_id });

    await expect(
      failTranslationJob({
        job: claim,
        error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      }),
    ).resolves.toBeNull();
  });

  it('cancels queued work immediately and releases admission', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER = '1';
    const { job } = await enqueue();
    const cancelled = await requestTranslationCancellation({
      user: 'u1',
      tenantId: 't1',
      jobId: job.job_id,
    });

    expect(cancelled).toMatchObject({ status: 'cancelled', active: false });
    await expect(enqueue({ conversationId: 'c2', files: [file('f2')] })).resolves.toBeDefined();
  });

  it('releases admission and retains TTL metadata after completion', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER = '1';
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    await completeTranslationJob({
      jobId: job.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
      outputFileIds: prepared.current_output_file_ids,
      report: { status: 'completed' },
    });

    await expect(enqueue({ conversationId: 'c2', files: [file('f2')] })).resolves.toBeDefined();
    const completed = await Model.findOne({ job_id: job.job_id }).lean();
    expect(completed).toMatchObject({ active: false, status: 'completed' });
    expect(completed.expires_at).toBeNull();
  });

  it('starts job-history TTL only after cleanup reconciliation', async () => {
    const { job } = await enqueue();
    expect(job.expires_at).toBeNull();
    expect(job.planned_output_file_ids).toHaveLength(0);

    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    const finishedAt = new Date('2026-08-27T12:00:00.000Z');
    const completed = await completeTranslationJob({
      jobId: job.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
      outputFileIds: prepared.current_output_file_ids,
      report: { status: 'completed' },
      now: finishedAt,
    });

    expect(completed.expires_at).toBeNull();
    const reconciledAt = new Date(finishedAt.getTime() + 31_000);
    const finalized = await finalizeTranslationJobExpiry({
      jobId: job.job_id,
      now: reconciledAt,
    });
    expect(finalized.expires_at.getTime()).toBe(reconciledAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it('uses Retry-After as the floor while bounding local jitter', () => {
    process.env.KNAUF_TRANSLATION_BACKOFF_BASE_MS = '1';
    process.env.KNAUF_TRANSLATION_BACKOFF_MAX_MS = '60000';
    const now = new Date('2026-08-26T12:00:00.000Z');
    const retryAt = computeRetryAt({
      attempt: 1,
      error: Object.assign(new Error('rate limited'), { retryAfter: '30' }),
      now,
    });

    expect(retryAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30000);
    expect(retryAt.getTime()).toBeLessThanOrEqual(now.getTime() + 30001);
  });

  it('honors an HTTP-date Retry-After against the retry clock', () => {
    process.env.KNAUF_TRANSLATION_BACKOFF_BASE_MS = '1';
    process.env.KNAUF_TRANSLATION_BACKOFF_MAX_MS = '60000';
    const now = new Date('2026-08-26T12:00:00.000Z');
    const retryAt = computeRetryAt({
      attempt: 1,
      error: Object.assign(new Error('busy'), {
        retryAfter: 'Wed, 26 Aug 2026 12:00:30 GMT',
      }),
      now,
    });

    expect(retryAt.getTime()).toBe(now.getTime() + 30000);
  });

  it.each([
    [400, 5],
    [401, 1],
    [503, 1],
  ])('stops retrying status %i at its configured cap', async (status, attemptCap) => {
    process.env.KNAUF_TRANSLATION_ATTEMPT_CAP = String(attemptCap);
    process.env.KNAUF_TRANSLATION_AUTH_ATTEMPT_CAP = String(attemptCap);
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    await Model.updateOne({ job_id: job.job_id }, { $set: { attempt_count: attemptCap } });

    const failed = await failTranslationJob({
      job: { ...claim, attempt_count: attemptCap },
      error: Object.assign(new Error('provider rejected'), { status }),
    });

    expect(failed).toMatchObject({ status: 'failed', active: false });
    delete process.env.KNAUF_TRANSLATION_ATTEMPT_CAP;
    delete process.env.KNAUF_TRANSLATION_AUTH_ATTEMPT_CAP;
  });

  it('persists whether a terminal error involved required protected terms', async () => {
    const { job } = await enqueue({ preserveTerms: ['HERADESIGN'] });
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const error = Object.assign(new Error('provider rejected'), {
      status: 400,
      code: 'translator_rejected',
      protectedTermsRequired: true,
    });

    const failed = await failTranslationJob({ job: claim, error });

    expect(failed).toMatchObject({
      job_id: job.job_id,
      status: 'failed',
      protected_terms_required: true,
    });
  });

  it('treats the whole-job deadline as permanent', () => {
    expect(classifyTranslationError({ code: 'translation_job_deadline' })).toBe('permanent');
  });

  it('uses a distinct output generation after lease recovery', async () => {
    process.env.KNAUF_TRANSLATION_LEASE_MS = '10';
    process.env.KNAUF_TRANSLATION_BACKOFF_BASE_MS = '1';
    process.env.KNAUF_TRANSLATION_BACKOFF_MAX_MS = '1';
    await enqueue();
    const claimedAt = new Date();
    const first = await claimNextTranslationJob({ workerId: 'worker-a', now: claimedAt });
    const preparedA = await prepareTranslationAttempt({
      jobId: first.job_id,
      token: first.execution_token,
      generation: first.target_generation,
      now: claimedAt,
    });
    const recovered = await recoverExpiredTranslationJob({
      now: new Date(claimedAt.getTime() + 11),
    });
    const second = await claimNextTranslationJob({
      workerId: 'worker-b',
      now: new Date(recovered.next_attempt_at.getTime() + 1),
    });
    const preparedB = await prepareTranslationAttempt({
      jobId: second.job_id,
      token: second.execution_token,
      generation: second.target_generation,
      now: new Date(recovered.next_attempt_at.getTime() + 1),
    });

    expect(preparedB.target_generation).toBe(preparedA.target_generation + 1);
    expect(preparedB.current_output_file_ids).not.toEqual(preparedA.current_output_file_ids);
    await expect(
      completeTranslationJob({
        jobId: first.job_id,
        token: first.execution_token,
        generation: first.target_generation,
        outputFileIds: preparedA.current_output_file_ids,
        report: { status: 'completed' },
      }),
    ).resolves.toBeNull();
    const current = await Model.findOne({ job_id: first.job_id }).lean();
    expect(
      current.attempt_outputs.find((attempt) => attempt.generation === first.target_generation),
    ).toMatchObject({
      output_file_ids: preparedA.current_output_file_ids,
      cleanup_status: 'cleanup_pending',
    });
    expect(
      current.attempt_outputs.find((attempt) => attempt.generation === second.target_generation),
    ).toMatchObject({
      output_file_ids: preparedB.current_output_file_ids,
      cleanup_status: 'prepared',
    });
  });

  it('keeps cleanup debt durable until a later sweep clears it', async () => {
    process.env.KNAUF_TRANSLATION_CLEANUP_QUIESCENCE_MS = '1';
    process.env.KNAUF_TRANSLATION_ATTEMPT_CAP = '1';
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    await failTranslationJob({
      job: prepared,
      error: Object.assign(new Error('provider down'), { status: 503 }),
    });
    const sweepAt = new Date(Date.now() + 10);
    const [candidate] = await findTranslationReconcileCandidates({ now: sweepAt, limit: 1 });

    expect(candidate.job_id).toBe(job.job_id);
    expect(candidate.expires_at).toBeNull();
    await clearTranslationCleanupDebt({
      jobId: job.job_id,
      generation: claim.target_generation,
      now: sweepAt,
    });
    const finalized = await finalizeTranslationJobExpiry({ jobId: job.job_id, now: sweepAt });
    expect(finalized.cleanup_swept_at).toEqual(sweepAt);
    expect(finalized.expires_at).toBeInstanceOf(Date);
  });

  it('defers failed cleanup debt so another due job can be reconciled', async () => {
    const first = await enqueue();
    const second = await enqueue({ conversationId: 'c2', files: [file('f2')] });
    const due = new Date(Date.now() - 1000);
    await Model.updateMany(
      { job_id: { $in: [first.job.job_id, second.job.job_id] } },
      {
        $set: {
          status: 'failed',
          active: false,
          attempt_outputs: [
            {
              generation: 1,
              output_file_ids: ['out'],
              cleanup_status: 'cleanup_pending',
              prepared_at: due,
              cleanup_after: due,
            },
          ],
        },
      },
    );
    const [firstCandidate] = await findTranslationReconcileCandidates({ limit: 1 });

    await deferTranslationCleanupDebt({
      jobId: firstCandidate.job_id,
      generation: 1,
    });
    const [nextCandidate] = await findTranslationReconcileCandidates({ limit: 1 });

    expect(nextCandidate.job_id).not.toBe(firstCandidate.job_id);
  });

  it('tombstones jobs by owner and conversation before deletion', async () => {
    const queued = await enqueue();
    const processing = await enqueue({
      conversationId: 'c2',
      files: [file('f2')],
    });
    await claimNextTranslationJob({ workerId: 'w1' });

    const result = await cancelTranslationJobsByConversation({
      user: 'u1',
      tenantId: 't1',
      conversationIds: ['c1', 'c2'],
    });
    const rows = await Model.find({
      job_id: { $in: [queued.job.job_id, processing.job.job_id] },
    }).lean();

    expect(result.queued + result.processing).toBe(2);
    expect(rows.every((row) => row.cancel_requested_at)).toBe(true);
    expect(rows.find((row) => row.status === 'processing')).toMatchObject({ active: true });
    expect(rows.find((row) => row.status === 'cancelled')).toMatchObject({ active: false });
  });

  it('reconciles an active job whose owner conversation disappeared', async () => {
    const { job } = await enqueue();
    await Conversation.deleteOne({ conversationId: 'c1', user: 'u1', tenantId: 't1' });

    const reconciled = await reconcileMissingConversationTranslationJobs();
    const current = await Model.findOne({ job_id: job.job_id }).lean();

    expect(reconciled).toEqual({ scanned: 1, cancelled: 1 });
    expect(current).toMatchObject({
      job_id: job.job_id,
      status: 'cancelled',
      active: false,
    });
  });

  it('rejects a claimed attempt before provider execution when its conversation vanished', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    await Conversation.deleteOne({ conversationId: 'c1', user: 'u1', tenantId: 't1' });

    await expect(
      prepareTranslationAttempt({
        jobId: claim.job_id,
        token: claim.execution_token,
        generation: claim.target_generation,
      }),
    ).resolves.toBeNull();

    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current).toMatchObject({
      status: 'cancelled',
      active: false,
      cancel_requested_at: expect.any(Date),
    });
  });

  it('rejects enqueue when the owner conversation is missing', async () => {
    await expect(
      enqueueTranslationJob({
        user: 'u1',
        tenantId: 't1',
        conversationId: 'missing',
        files: [file()],
        sourceLocale: null,
        targetLocale: 'de-DE',
      }),
    ).rejects.toMatchObject({ code: 'translation_conversation_not_found', status: 404 });
  });

  it('releases overdue queued and retrying admission records', async () => {
    const first = await enqueue();
    const second = await enqueue({
      user: 'u2',
      conversationId: 'c2',
      files: [file('f2')],
    });
    const overdue = new Date(Date.now() - 1);
    await Model.updateOne(
      { job_id: first.job.job_id },
      { $set: { deadline_at: overdue, status: 'queued' } },
    );
    await Model.updateOne(
      { job_id: second.job.job_id },
      { $set: { deadline_at: overdue, status: 'retrying' } },
    );

    await releaseOverdueQueuedTranslationJobs();

    const rows = await Model.find({ active: true }).lean();
    expect(rows).toHaveLength(0);
    expect(
      await Model.countDocuments({
        status: 'failed',
        last_error_code: 'translation_job_deadline',
      }),
    ).toBe(2);
  });

  it('terminally deadline-fails when Retry-After reaches the deadline', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'w1' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    const now = new Date();
    const deadline = new Date(now.getTime() + 10_000);
    await Model.updateOne({ job_id: job.job_id }, { $set: { deadline_at: deadline } });
    expect(
      await Model.exists({
        job_id: job.job_id,
        status: 'processing',
        active: true,
        execution_token: prepared.execution_token,
        target_generation: prepared.target_generation,
        cancel_requested_at: null,
      }),
    ).not.toBeNull();

    const failed = await failTranslationJob({
      job: { ...prepared, deadline_at: deadline },
      error: Object.assign(new Error('rate limited'), { status: 429, retryAfter: '10' }),
      now,
    });

    expect(failed).toMatchObject({
      status: 'failed',
      active: false,
      last_error_code: 'translation_job_deadline',
    });
  });

  it('admits nine synchronized users into a 100-slot global pool', async () => {
    process.env.KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL = '100';
    const jobs = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        enqueue({
          user: `user-${index}`,
          conversationId: `convo-${index}`,
          files: [file(`file-${index}`)],
        }),
      ),
    );

    expect(jobs).toHaveLength(9);
    expect(new Set(jobs.map(({ job }) => job.global_slot)).size).toBe(9);
  });

  it('upgrades and executes an active legacy job without deleting it', async () => {
    const now = new Date();
    await Conversation.create({
      user: 'legacy-user',
      tenantId: 'legacy-tenant',
      conversationId: 'legacy-convo',
      title: 'Legacy',
    });
    await Model.collection.insertOne({
      job_id: 'legacy-job',
      request_key: 'legacy-request',
      idempotency_key: 'legacy-idempotency',
      user: 'legacy-user',
      tenantId: 'legacy-tenant',
      conversation_id: 'legacy-convo',
      input_files: [{ ...file('legacy-file'), output_file_id: 'legacy-reusable-output' }],
      planned_output_file_ids: ['legacy-reusable-output'],
      target_locale: 'de-DE',
      status: 'queued',
      active: true,
      user_slot: 0,
      global_slot: 0,
      attempt_count: 0,
      next_attempt_at: now,
      queued_at: now,
      createdAt: now,
      updatedAt: now,
    });

    await upgradeActiveTranslationJobs({ now });
    const claim = await claimNextTranslationJob({ workerId: 'legacy-worker', now });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
      now,
    });

    expect(prepared).toMatchObject({
      job_id: 'legacy-job',
      target_generation: 1,
      attempt_count: 1,
    });
    expect(prepared.deadline_at).toBeInstanceOf(Date);
    expect(prepared.current_output_file_ids).toHaveLength(1);
    expect(prepared.current_output_file_ids).not.toContain('legacy-reusable-output');
    expect(prepared.attempt_outputs).toHaveLength(1);
    expect(ATTEMPT_OUTPUT_LEDGER_LIMIT).toBeGreaterThanOrEqual(5);
  });

  it('persists a deterministic storage locator before the generation writes', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'locator-worker' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    const locator = {
      file_id: prepared.current_output_file_ids[0],
      source: 'local',
      filepath: `/uploads/u1/${prepared.current_output_file_ids[0]}__f1_de-DE.docx`,
      filename: 'f1_de-DE.docx',
      type: file().type,
    };

    await expect(
      prepareTranslationStorageLocator({
        jobId: prepared.job_id,
        token: prepared.execution_token,
        generation: prepared.target_generation,
        locator,
      }),
    ).resolves.toBe(true);

    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current.attempt_outputs[0]).toMatchObject({
      locator_fenced: true,
      storage_locators: [expect.objectContaining(locator)],
    });
  });

  it('tombstones only published or located outputs when publication wins before deletion', async () => {
    const { job } = await enqueue({ files: [file('f1'), file('f2'), file('f3')] });
    const claim = await claimNextTranslationJob({ workerId: 'publish-worker' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    const [outputFileId, locatedOutputFileId, neverWrittenOutputFileId] =
      prepared.current_output_file_ids;
    await prepareTranslationStorageLocator({
      jobId: prepared.job_id,
      token: prepared.execution_token,
      generation: prepared.target_generation,
      locator: {
        file_id: locatedOutputFileId,
        source: 'local',
        filepath: `/uploads/u1/${locatedOutputFileId}__f2_de-DE.docx`,
        filename: 'f2_de-DE.docx',
        type: file().type,
      },
    });
    await completeTranslationJob({
      jobId: prepared.job_id,
      token: prepared.execution_token,
      generation: prepared.target_generation,
      outputFileIds: [outputFileId],
      report: { status: 'completed' },
    });

    const cancelled = await cancelTranslationJobsByConversation({
      user: 'u1',
      tenantId: 't1',
      conversationIds: ['c1'],
    });

    expect(cancelled.terminal).toBe(1);
    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current).toMatchObject({
      status: 'cancelled',
      active: false,
      expires_at: null,
    });
    expect(current.attempt_outputs).toContainEqual(
      expect.objectContaining({
        generation: prepared.target_generation,
        output_file_ids: [outputFileId, locatedOutputFileId],
        locator_fenced: true,
        cleanup_status: 'cleanup_pending',
      }),
    );
    expect(current.attempt_outputs[0].output_file_ids).not.toContain(neverWrittenOutputFileId);
  });

  it('does not schedule terminal cleanup unless cancellation is persisted atomically', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'publish-worker' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    await completeTranslationJob({
      jobId: prepared.job_id,
      token: prepared.execution_token,
      generation: prepared.target_generation,
      outputFileIds: prepared.current_output_file_ids,
      report: { status: 'completed' },
    });
    const updateSpy = jest
      .spyOn(Model.collection, 'updateOne')
      .mockRejectedValueOnce(new Error('cancellation write failed'));

    await expect(
      cancelTranslationJobsByConversation({
        user: 'u1',
        tenantId: 't1',
        conversationIds: ['c1'],
      }),
    ).rejects.toThrow('cancellation write failed');
    updateSpy.mockRestore();

    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current.status).toBe('completed');
    expect(current.attempt_outputs[0].cleanup_status).toBe('published');
  });

  it('does not let stale legacy migration overwrite a concurrently claimed generation', async () => {
    const now = new Date();
    await Model.collection.insertOne({
      job_id: 'legacy-race',
      request_key: 'legacy-race',
      user: 'u1',
      tenantId: 't1',
      conversation_id: 'c1',
      input_files: [file('f1')],
      planned_output_file_ids: ['legacy-output'],
      status: 'retrying',
      active: true,
      attempt_count: 1,
      next_attempt_at: now,
      queued_at: now,
      createdAt: now,
      updatedAt: now,
    });
    const realUpdateOne = Model.collection.updateOne.bind(Model.collection);
    const updateSpy = jest
      .spyOn(Model.collection, 'updateOne')
      .mockImplementationOnce(async (filter, update, options) => {
        await Model.collection.updateOne(
          { _id: filter._id },
          {
            $set: {
              status: 'processing',
              execution_token: 'live-token',
              target_generation: 9,
              current_output_file_ids: ['live-output'],
              attempt_outputs: [
                {
                  generation: 9,
                  output_file_ids: ['live-output'],
                  storage_locators: [
                    {
                      file_id: 'live-output',
                      source: 'local',
                      filepath: '/uploads/u1/live-output__f1_de-DE.docx',
                    },
                  ],
                  cleanup_status: 'prepared',
                },
              ],
              updatedAt: new Date(now.getTime() + 1000),
            },
          },
        );
        return realUpdateOne(filter, update, options);
      });

    await upgradeActiveTranslationJobs({ now });
    updateSpy.mockRestore();

    const current = await Model.findOne({ job_id: 'legacy-race' }).lean();
    expect(current).toMatchObject({
      status: 'processing',
      execution_token: 'live-token',
      target_generation: 9,
      current_output_file_ids: ['live-output'],
    });
    expect(current.attempt_outputs[0].storage_locators[0].file_id).toBe('live-output');
  });

  it('reconciles a completed publication whose conversation disappeared outside the delete wrapper', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'terminal-reconcile-worker' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    await completeTranslationJob({
      jobId: prepared.job_id,
      token: prepared.execution_token,
      generation: prepared.target_generation,
      outputFileIds: prepared.current_output_file_ids,
      report: { status: 'completed' },
    });
    await Conversation.deleteOne({ user: 'u1', tenantId: 't1', conversationId: 'c1' });

    await expect(reconcileMissingConversationTranslationJobs()).resolves.toMatchObject({
      cancelled: 1,
    });

    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current.status).toBe('cancelled');
    expect(current.attempt_outputs[0].cleanup_status).toBe('cleanup_pending');
  });

  it('migrates retrying and terminal legacy planned outputs into cleanup debt', async () => {
    const now = new Date();
    await Conversation.create({
      user: 'legacy-user',
      tenantId: 'legacy-tenant',
      conversationId: 'legacy-convo',
      title: 'Legacy',
    });
    const base = {
      request_key: 'legacy-request',
      user: 'legacy-user',
      tenantId: 'legacy-tenant',
      conversation_id: 'legacy-convo',
      input_files: [{ ...file('legacy-file'), output_file_id: 'old-output' }],
      planned_output_file_ids: ['old-output'],
      target_locale: 'de-DE',
      user_slot: 0,
      global_slot: 0,
      attempt_count: 1,
      target_generation: 1,
      next_attempt_at: now,
      queued_at: now,
      createdAt: now,
      updatedAt: now,
    };
    await Model.collection.insertMany([
      {
        ...base,
        job_id: 'legacy-retrying',
        request_key: 'legacy-retrying',
        idempotency_key: 'legacy-retrying',
        status: 'retrying',
        active: true,
      },
      {
        ...base,
        job_id: 'legacy-failed',
        request_key: 'legacy-failed',
        idempotency_key: 'legacy-failed',
        status: 'failed',
        active: false,
        expires_at: new Date(now.getTime() + 60_000),
        attempt_outputs: [
          {
            generation: 1,
            output_file_ids: ['old-output'],
            cleanup_status: 'prepared',
            prepared_at: now,
          },
        ],
      },
      {
        ...base,
        job_id: 'legacy-cancelled',
        request_key: 'legacy-cancelled',
        idempotency_key: 'legacy-cancelled',
        status: 'cancelled',
        active: false,
        expires_at: new Date(now.getTime() + 60_000),
      },
    ]);

    await upgradeActiveTranslationJobs({ now });

    for (const jobId of ['legacy-retrying', 'legacy-failed', 'legacy-cancelled']) {
      const migrated = await Model.findOne({ job_id: jobId }).lean();
      expect(migrated.planned_output_file_ids).toEqual([]);
      expect(migrated.attempt_outputs).toContainEqual(
        expect.objectContaining({
          output_file_ids: ['old-output'],
          locator_fenced: false,
          cleanup_status: 'cleanup_pending',
        }),
      );
      expect(migrated.expires_at).toBeNull();
    }

    const claim = await claimNextTranslationJob({ workerId: 'legacy-retry-worker', now });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
      now,
    });
    expect(prepared.target_generation).toBe(2);
    expect(prepared.attempt_outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generation: 1,
          output_file_ids: ['old-output'],
          cleanup_status: 'cleanup_pending',
        }),
        expect.objectContaining({
          generation: 2,
          cleanup_status: 'prepared',
        }),
      ]),
    );
  });

  it('does not downgrade locator-fenced retry cleanup to legacy semantics', async () => {
    const { job } = await enqueue();
    const claim = await claimNextTranslationJob({ workerId: 'current-worker' });
    const prepared = await prepareTranslationAttempt({
      jobId: claim.job_id,
      token: claim.execution_token,
      generation: claim.target_generation,
    });
    await failTranslationJob({
      job: prepared,
      error: Object.assign(new Error('provider unavailable'), { status: 503 }),
    });

    await upgradeActiveTranslationJobs();

    const current = await Model.findOne({ job_id: job.job_id }).lean();
    expect(current.status).toBe('retrying');
    expect(current.planned_output_file_ids).toEqual(prepared.current_output_file_ids);
    expect(current.attempt_outputs[0].locator_fenced).toBe(true);
  });
});

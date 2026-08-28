'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Constants } = require('librechat-data-provider');
const { IdmlError } = require('../idml/core');

const ACTIVE_STATUSES = ['queued', 'processing', 'retrying'];
const TERMINAL_STATUSES = ['completed', 'partial', 'failed', 'cancelled'];
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const ERROR_DETAIL_MAX = 1000;
const ATTEMPT_OUTPUT_LEDGER_LIMIT = 16;

const envInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getTranslationJobConfig = () => ({
  userSlots: envInt('KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER', 3),
  globalSlots: envInt('KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL', 100),
  leaseMs: envInt('KNAUF_TRANSLATION_LEASE_MS', 12 * 60 * 1000),
  heartbeatMs: envInt('KNAUF_TRANSLATION_HEARTBEAT_MS', 30 * 1000),
  pollMs: envInt('KNAUF_TRANSLATION_WORKER_POLL_MS', 2000),
  concurrency: envInt('KNAUF_TRANSLATION_WORKER_CONCURRENCY', 2),
  fileConcurrency: envInt('KNAUF_TRANSLATION_FILE_CONCURRENCY', 1),
  attemptCap: Math.min(envInt('KNAUF_TRANSLATION_ATTEMPT_CAP', 5), ATTEMPT_OUTPUT_LEDGER_LIMIT),
  authAttemptCap: Math.min(
    envInt('KNAUF_TRANSLATION_AUTH_ATTEMPT_CAP', 2),
    ATTEMPT_OUTPUT_LEDGER_LIMIT,
  ),
  backoffBaseMs: envInt('KNAUF_TRANSLATION_BACKOFF_BASE_MS', 10 * 1000),
  backoffMaxMs: envInt('KNAUF_TRANSLATION_BACKOFF_MAX_MS', 10 * 60 * 1000),
  maxJobAgeMs: envInt('KNAUF_TRANSLATION_MAX_JOB_AGE_MS', 60 * 60 * 1000),
  historyMs: envInt('KNAUF_TRANSLATION_JOB_HISTORY_MS', 7 * 24 * 60 * 60 * 1000),
  inlineWaitMs: envInt('KNAUF_TRANSLATION_INLINE_WAIT_MS', 15 * 1000),
  cleanupQuiescenceMs: envInt('KNAUF_TRANSLATION_CLEANUP_QUIESCENCE_MS', 30 * 1000),
  reconcileIntervalMs: envInt('KNAUF_TRANSLATION_RECONCILE_INTERVAL_MS', 30 * 1000),
  reconcileBatchLimit: envInt('KNAUF_TRANSLATION_RECONCILE_BATCH_LIMIT', 25),
  storageWriteTimeoutMs: envInt('KNAUF_TRANSLATION_STORAGE_WRITE_TIMEOUT_MS', 2 * 60 * 1000),
});

function buildSchema() {
  const storageLocatorSchema = new mongoose.Schema(
    {
      file_id: { type: String, required: true },
      source: { type: String, required: true },
      filepath: { type: String, required: true },
      storageKey: { type: String, default: null },
      filename: { type: String, required: true },
      type: { type: String, required: true },
    },
    { _id: false },
  );
  const attemptOutputSchema = new mongoose.Schema(
    {
      generation: { type: Number, required: true },
      output_file_ids: { type: [String], required: true },
      storage_locators: { type: [storageLocatorSchema], default: [] },
      locator_fenced: { type: Boolean, default: false },
      cleanup_status: {
        type: String,
        enum: ['prepared', 'cleanup_pending', 'clean', 'published'],
        required: true,
      },
      prepared_at: { type: Date, required: true },
      cleanup_after: { type: Date, default: null },
      cleaned_at: { type: Date, default: null },
    },
    { _id: false },
  );
  const schema = new mongoose.Schema(
    {
      job_id: { type: String, required: true, unique: true },
      request_key: { type: String, required: true, index: true },
      idempotency_key: { type: String, required: true, unique: true },
      user: { type: String, required: true },
      tenantId: { type: String, default: null },
      conversation_id: { type: String, default: null },
      output_retention_resolved: { type: Boolean, default: false },
      output_expires_at: { type: Date, default: null },
      input_files: {
        type: [
          {
            _id: false,
            file_id: { type: String, required: true },
            filename: { type: String, required: true },
            type: { type: String, required: true },
            bytes: { type: Number, required: true },
            output_file_id: { type: String, default: null },
          },
        ],
        required: true,
      },
      source_locale: { type: String, default: null },
      target_locale: { type: String, required: true },
      glossary_revision: { type: String, default: 'none' },
      status: {
        type: String,
        enum: [...ACTIVE_STATUSES, ...TERMINAL_STATUSES],
        required: true,
        default: 'queued',
      },
      active: { type: Boolean, required: true, default: true },
      user_slot: { type: Number, required: true },
      global_slot: { type: Number, required: true },
      attempt_count: { type: Number, default: 0 },
      target_generation: { type: Number, default: 0 },
      published_generation: { type: Number, default: null },
      attempt_outputs: { type: [attemptOutputSchema], default: [] },
      current_output_file_ids: { type: [String], default: [] },
      completion_output_file_ids: { type: [String], default: [] },
      next_attempt_at: { type: Date, required: true },
      deadline_at: { type: Date, default: null },
      lease_owner: { type: String, default: null },
      lease_expires_at: { type: Date, default: null },
      execution_token: { type: String, default: null },
      cancel_requested_at: { type: Date, default: null },
      planned_output_file_ids: { type: [String], default: [] },
      output_file_ids: { type: [String], default: [] },
      report: { type: mongoose.Schema.Types.Mixed, default: null },
      last_error_code: { type: String, default: null },
      last_error_detail: { type: String, maxlength: ERROR_DETAIL_MAX, default: null },
      queued_at: { type: Date, required: true },
      started_at: { type: Date, default: null },
      finished_at: { type: Date, default: null },
      cleanup_swept_at: { type: Date, default: null },
      expires_at: { type: Date, default: null },
    },
    { timestamps: true, collection: 'knauf_translation_jobs' },
  );
  schema.index(
    { tenantId: 1, user: 1, user_slot: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  schema.index({ global_slot: 1 }, { unique: true, partialFilterExpression: { active: true } });
  schema.index({ status: 1, next_attempt_at: 1, queued_at: 1 });
  schema.index({ status: 1, lease_expires_at: 1 });
  schema.index({ active: 1, deadline_at: 1 });
  schema.index({ 'attempt_outputs.cleanup_status': 1, 'attempt_outputs.cleanup_after': 1 });
  schema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
  return schema;
}

function getTranslationJobModel() {
  return (
    mongoose.models.KnaufTranslationJob || mongoose.model('KnaufTranslationJob', buildSchema())
  );
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const tenantKey = (tenantId) => tenantId ?? null;
const terminalExpiry = (now) => new Date(now.getTime() + getTranslationJobConfig().historyMs);
const cleanupDelayMs = () => {
  const config = getTranslationJobConfig();
  return config.storageWriteTimeoutMs + config.cleanupQuiescenceMs;
};
const isNewConversation = (conversationId) =>
  !conversationId || conversationId === Constants.NEW_CONVO;

function conversationScope({ user, tenantId, conversationId }) {
  return {
    conversationId,
    user: String(user),
    tenantId: tenantKey(tenantId),
  };
}

async function translationConversationExists(params) {
  if (isNewConversation(params.conversationId)) return true;
  const Conversation = mongoose.models.Conversation;
  if (!Conversation) {
    throw new Error('Conversation model is unavailable');
  }
  return Boolean(await Conversation.exists(conversationScope(params)));
}

function makeIdempotencyKey({ user, tenantId, conversationId, files, sourceLocale, targetLocale }) {
  return sha256(
    JSON.stringify({
      user: String(user),
      tenantId: tenantKey(tenantId),
      conversationId: conversationId ?? null,
      files: files.map((file) => file.file_id),
      sourceLocale: sourceLocale ?? null,
      targetLocale,
      glossaryRevision: process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION || 'none',
    }),
  );
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new IdmlError(
      `Translation jobs accept 1-${MAX_FILES} files`,
      'translation_file_limit',
      400,
    );
  }
  let total = 0;
  for (const file of files) {
    if (!file?.file_id || !file?.filename || !file?.type || !Number.isFinite(file?.bytes)) {
      throw new IdmlError('Attached file metadata is incomplete', 'invalid_file_metadata', 400);
    }
    total += file.bytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new IdmlError(
      'Translation job exceeds the 250 MB aggregate limit',
      'translation_bytes_limit',
      400,
    );
  }
}

const slotOrder = (size, seed) => {
  const start = Number.parseInt(sha256(seed).slice(0, 8), 16) % size;
  return Array.from({ length: size }, (_, index) => (start + index) % size);
};

async function releaseOverdueQueuedTranslationJobs({ now = new Date() } = {}) {
  return getTranslationJobModel().updateMany(
    {
      active: true,
      status: { $in: ['queued', 'retrying'] },
      deadline_at: { $lte: now },
    },
    {
      $set: {
        status: 'failed',
        active: false,
        finished_at: now,
        expires_at: null,
        last_error_code: 'translation_job_deadline',
        last_error_detail: 'Translation job exceeded its maximum age',
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
      },
    },
  );
}

async function upgradeActiveTranslationJobs({ now = new Date(), limit = 100 } = {}) {
  const Model = getTranslationJobModel();
  const config = getTranslationJobConfig();
  const legacy = await Model.collection
    .find({
      $or: [
        {
          active: true,
          $or: [
            { deadline_at: null },
            { deadline_at: { $exists: false } },
            { target_generation: { $exists: false } },
            { attempt_outputs: { $exists: false } },
          ],
        },
        {
          status: { $in: ['retrying', 'failed', 'cancelled'] },
          'planned_output_file_ids.0': { $exists: true },
          $or: [
            { attempt_outputs: { $exists: false } },
            { attempt_outputs: { $size: 0 } },
            { attempt_outputs: { $elemMatch: { locator_fenced: { $exists: false } } } },
          ],
        },
      ],
    })
    .sort({ queued_at: 1, _id: 1 })
    .limit(limit)
    .toArray();
  for (const job of legacy) {
    const queuedAt = new Date(job.queued_at ?? now);
    const generation = Math.max(0, Number(job.target_generation) || 0);
    const legacyOutputIds =
      job.planned_output_file_ids?.length > 0
        ? job.planned_output_file_ids
        : (job.input_files ?? []).map((file) => file.output_file_id).filter(Boolean);
    const legacyProcessing = job.status === 'processing';
    const legacyCleanup = ['retrying', 'failed', 'cancelled'].includes(job.status);
    let attemptOutputs = job.attempt_outputs ?? [];
    let legacyGeneration = Math.max(1, generation);
    const exactLegacyAttempt = attemptOutputs.some(
      (attempt) =>
        attempt.output_file_ids?.length === legacyOutputIds.length &&
        attempt.output_file_ids.every((fileId, index) => fileId === legacyOutputIds[index]),
    );
    if (legacyCleanup && exactLegacyAttempt) {
      attemptOutputs = attemptOutputs.map((attempt) =>
        attempt.output_file_ids?.length === legacyOutputIds.length &&
        attempt.output_file_ids.every((fileId, index) => fileId === legacyOutputIds[index])
          ? {
              ...attempt,
              locator_fenced: attempt.locator_fenced ?? false,
              cleanup_status: 'cleanup_pending',
              cleanup_after: attempt.cleanup_after ?? now,
              cleaned_at: null,
            }
          : attempt,
      );
    }
    if (legacyCleanup && !exactLegacyAttempt && attemptOutputs.length) {
      legacyGeneration =
        Math.max(legacyGeneration, ...attemptOutputs.map((attempt) => attempt.generation ?? 0)) + 1;
    }
    const canAppendLegacyAttempt =
      legacyOutputIds.length > 0 &&
      !exactLegacyAttempt &&
      attemptOutputs.length < ATTEMPT_OUTPUT_LEDGER_LIMIT;
    const appendedLegacyAttempt = canAppendLegacyAttempt && (legacyProcessing || legacyCleanup);
    if (appendedLegacyAttempt) {
      attemptOutputs = [
        ...attemptOutputs,
        {
          generation: legacyGeneration,
          output_file_ids: legacyOutputIds,
          locator_fenced: false,
          cleanup_status: legacyCleanup ? 'cleanup_pending' : 'prepared',
          prepared_at: job.started_at ?? queuedAt,
          cleanup_after: legacyCleanup ? now : null,
        },
      ];
    }
    let currentOutputFileIds = job.current_output_file_ids ?? [];
    if (!currentOutputFileIds.length && legacyProcessing) {
      currentOutputFileIds = legacyOutputIds;
    }
    const migratedLegacyCleanup = legacyCleanup && (exactLegacyAttempt || canAppendLegacyAttempt);
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(job, key);
    await Model.collection.updateOne(
      {
        _id: job._id,
        status: job.status,
        active: job.active,
        execution_token: job.execution_token ?? null,
        updatedAt: hasOwn('updatedAt') ? job.updatedAt : { $exists: false },
        target_generation: hasOwn('target_generation') ? job.target_generation : { $exists: false },
        attempt_outputs: hasOwn('attempt_outputs') ? job.attempt_outputs : { $exists: false },
        current_output_file_ids: hasOwn('current_output_file_ids')
          ? job.current_output_file_ids
          : { $exists: false },
        planned_output_file_ids: hasOwn('planned_output_file_ids')
          ? job.planned_output_file_ids
          : { $exists: false },
      },
      {
        $set: {
          deadline_at: job.deadline_at ?? new Date(queuedAt.getTime() + config.maxJobAgeMs),
          target_generation: Math.max(
            generation || (legacyProcessing && legacyOutputIds.length ? 1 : 0),
            appendedLegacyAttempt ? legacyGeneration : 0,
          ),
          attempt_outputs: attemptOutputs,
          current_output_file_ids: currentOutputFileIds,
          updatedAt: new Date(),
          ...(migratedLegacyCleanup
            ? {
                planned_output_file_ids: [],
                expires_at: null,
                cleanup_swept_at: null,
              }
            : {}),
        },
      },
    );
  }
  return legacy.length;
}

async function enqueueTranslationJob({
  user,
  tenantId,
  conversationId,
  files,
  sourceLocale,
  targetLocale,
  outputExpiresAt = null,
  outputRetentionResolved = false,
}) {
  validateFiles(files);
  if (!(await translationConversationExists({ user, tenantId, conversationId }))) {
    throw new IdmlError(
      'The owning conversation no longer exists',
      'translation_conversation_not_found',
      404,
    );
  }
  const Model = getTranslationJobModel();
  await Model.init();
  await upgradeActiveTranslationJobs();
  await releaseOverdueQueuedTranslationJobs();
  const config = getTranslationJobConfig();
  const requestKey = makeIdempotencyKey({
    user,
    tenantId,
    conversationId,
    files,
    sourceLocale,
    targetLocale,
  });
  const scope = { user: String(user), tenantId: tenantKey(tenantId) };
  const userOrder = slotOrder(config.userSlots, `${requestKey}:user`);
  const globalOrder = slotOrder(config.globalSlots, `${requestKey}:global`);
  const attempted = new Set();
  const probeLimit = config.userSlots * config.globalSlots + 1;

  for (let probe = 0; probe < probeLimit; probe += 1) {
    const existing = await Model.findOne({
      ...scope,
      $or: [
        { request_key: requestKey },
        { request_key: { $exists: false }, idempotency_key: requestKey },
      ],
    })
      .sort({ queued_at: -1, _id: -1 })
      .lean();
    if (existing && !['failed', 'cancelled'].includes(existing.status)) {
      return { job: existing, created: false };
    }
    const idempotencyKey = existing ? sha256(`${requestKey}:${existing.job_id}`) : requestKey;
    const [userSlots, globalSlots] = await Promise.all([
      Model.distinct('user_slot', { ...scope, active: true }),
      Model.distinct('global_slot', { active: true }),
    ]);
    const usedUser = new Set(userSlots);
    const usedGlobal = new Set(globalSlots);
    const freeUser = userOrder.filter((slot) => !usedUser.has(slot));
    const freeGlobal = globalOrder.filter((slot) => !usedGlobal.has(slot));
    if (!freeUser.length) {
      throw new IdmlError(
        'Too many active translation jobs for this user',
        'translation_user_limit',
        429,
      );
    }
    if (!freeGlobal.length) {
      throw new IdmlError(
        'Translation capacity is currently full',
        'translation_capacity_full',
        503,
      );
    }
    let pair;
    for (const userSlot of freeUser) {
      const globalSlot = freeGlobal.find((slot) => !attempted.has(`${userSlot}:${slot}`));
      if (globalSlot != null) {
        pair = { userSlot, globalSlot };
        break;
      }
    }
    if (!pair) continue;
    attempted.add(`${pair.userSlot}:${pair.globalSlot}`);
    const now = new Date();
    try {
      if (!(await translationConversationExists({ user, tenantId, conversationId }))) {
        throw new IdmlError(
          'The owning conversation no longer exists',
          'translation_conversation_not_found',
          404,
        );
      }
      const jobId = crypto.randomUUID();
      const job = await Model.create({
        job_id: jobId,
        request_key: requestKey,
        idempotency_key: idempotencyKey,
        ...scope,
        conversation_id: conversationId ?? null,
        output_retention_resolved: outputRetentionResolved,
        output_expires_at: outputExpiresAt,
        input_files: files.map((file) => ({ ...file, output_file_id: null })),
        source_locale: sourceLocale ?? null,
        target_locale: targetLocale,
        glossary_revision: process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION || 'none',
        user_slot: pair.userSlot,
        global_slot: pair.globalSlot,
        next_attempt_at: now,
        deadline_at: new Date(now.getTime() + config.maxJobAgeMs),
        queued_at: now,
        expires_at: null,
      });
      if (!(await translationConversationExists({ user, tenantId, conversationId }))) {
        await requestTranslationCancellation({
          user,
          tenantId,
          jobId,
        });
        throw new IdmlError(
          'The owning conversation no longer exists',
          'translation_conversation_not_found',
          404,
        );
      }
      return { job: job.toObject(), created: true };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  await releaseOverdueQueuedTranslationJobs();
  const [userCount, globalCount] = await Promise.all([
    Model.countDocuments({ ...scope, active: true }),
    Model.countDocuments({ active: true }),
  ]);
  if (userCount >= config.userSlots) {
    throw new IdmlError(
      'Too many active translation jobs for this user',
      'translation_user_limit',
      429,
    );
  }
  if (globalCount >= config.globalSlots) {
    throw new IdmlError('Translation capacity is currently full', 'translation_capacity_full', 503);
  }
  throw new IdmlError(
    'Translation capacity changed; retry the request',
    'translation_admission_race',
    503,
  );
}

const ownedScope = ({ user, tenantId, jobId }) => ({
  job_id: jobId,
  user: String(user),
  tenantId: tenantKey(tenantId),
});

async function getOwnedTranslationJob(params) {
  return getTranslationJobModel().findOne(ownedScope(params)).lean();
}

async function requestTranslationCancellation(params) {
  const Model = getTranslationJobModel();
  const scope = ownedScope(params);
  const now = new Date();
  const queued = await Model.findOneAndUpdate(
    {
      ...scope,
      active: true,
      status: { $in: ['queued', 'retrying'] },
    },
    {
      $set: {
        status: 'cancelled',
        active: false,
        cancel_requested_at: now,
        finished_at: now,
        expires_at: null,
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
      },
    },
    { new: true },
  ).lean();
  if (queued) return queued;
  return Model.findOneAndUpdate(
    { ...scope, active: true, status: 'processing' },
    { $set: { cancel_requested_at: now } },
    { new: true },
  ).lean();
}

async function cancelTranslationJobsByConversation({
  user,
  tenantId,
  conversationIds,
  now = new Date(),
}) {
  if (!conversationIds?.length) return { queued: 0, processing: 0, terminal: 0 };
  const Model = getTranslationJobModel();
  const conversationScope = {
    user: String(user),
    tenantId: tenantKey(tenantId),
    conversation_id: { $in: conversationIds },
  };
  const queued = await Model.updateMany(
    { ...conversationScope, active: true, status: { $in: ['queued', 'retrying'] } },
    {
      $set: {
        status: 'cancelled',
        active: false,
        cancel_requested_at: now,
        finished_at: now,
        expires_at: null,
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
      },
    },
  );
  const processing = await Model.updateMany(
    { ...conversationScope, active: true, status: 'processing' },
    { $set: { cancel_requested_at: now } },
  );
  const terminalJobs = await Model.find({
    ...conversationScope,
    status: { $in: ['completed', 'partial'] },
  }).lean();
  let terminal = 0;
  for (const job of terminalJobs) {
    const generation = Math.max(1, job.published_generation ?? job.target_generation ?? 0);
    const publishedOutputFileIds =
      job.output_file_ids?.length > 0 ? job.output_file_ids : job.planned_output_file_ids;
    const publishedAttempt = (job.attempt_outputs ?? []).find(
      (attempt) => attempt.generation === generation,
    );
    const outputFileIds = [
      ...new Set([
        ...(publishedOutputFileIds ?? []),
        ...(publishedAttempt?.storage_locators ?? []).map((locator) => locator.file_id),
      ]),
    ];
    const cleanupAfter = new Date(now.getTime() + cleanupDelayMs());
    const cleanupAttempt = {
      generation,
      output_file_ids: outputFileIds,
      storage_locators: publishedAttempt?.storage_locators ?? [],
      locator_fenced: publishedAttempt?.locator_fenced ?? false,
      cleanup_status: 'cleanup_pending',
      prepared_at: publishedAttempt?.prepared_at ?? now,
      cleanup_after: cleanupAfter,
      cleaned_at: null,
    };
    const cancelled = await Model.collection.updateOne(
      { _id: job._id, status: { $in: ['completed', 'partial'] } },
      [
        {
          $set: {
            status: 'cancelled',
            active: false,
            cancel_requested_at: now,
            finished_at: now,
            expires_at: null,
            lease_owner: null,
            lease_expires_at: null,
            execution_token: null,
            cleanup_swept_at: null,
            attempt_outputs: outputFileIds.length
              ? {
                  $cond: [
                    {
                      $in: [
                        generation,
                        {
                          $map: {
                            input: { $ifNull: ['$attempt_outputs', []] },
                            as: 'attempt',
                            in: '$$attempt.generation',
                          },
                        },
                      ],
                    },
                    {
                      $map: {
                        input: { $ifNull: ['$attempt_outputs', []] },
                        as: 'attempt',
                        in: {
                          $cond: [
                            { $eq: ['$$attempt.generation', generation] },
                            {
                              $mergeObjects: [
                                '$$attempt',
                                {
                                  output_file_ids: { $literal: outputFileIds },
                                  cleanup_status: 'cleanup_pending',
                                  cleanup_after: cleanupAfter,
                                  cleaned_at: null,
                                },
                              ],
                            },
                            '$$attempt',
                          ],
                        },
                      },
                    },
                    {
                      $slice: [
                        {
                          $concatArrays: [
                            { $ifNull: ['$attempt_outputs', []] },
                            { $literal: [cleanupAttempt] },
                          ],
                        },
                        -ATTEMPT_OUTPUT_LEDGER_LIMIT,
                      ],
                    },
                  ],
                }
              : { $ifNull: ['$attempt_outputs', []] },
            updatedAt: now,
          },
        },
      ],
    );
    if (cancelled.matchedCount !== 1) {
      throw new Error(`Unable to persist translation cleanup barrier for ${job.job_id}`);
    }
    terminal += cancelled.modifiedCount;
  }
  return { queued: queued.modifiedCount, processing: processing.modifiedCount, terminal };
}

async function claimNextTranslationJob({ workerId, now = new Date() }) {
  const Model = getTranslationJobModel();
  const config = getTranslationJobConfig();
  await upgradeActiveTranslationJobs({ now });
  await releaseOverdueQueuedTranslationJobs({ now });
  for (let probe = 0; probe < 5; probe += 1) {
    const candidate = await Model.findOne({
      active: true,
      cancel_requested_at: null,
      status: { $in: ['queued', 'retrying'] },
      next_attempt_at: { $lte: now },
      deadline_at: { $gt: now },
    })
      .sort({ next_attempt_at: 1, queued_at: 1 })
      .lean();
    if (!candidate) return null;
    const token = crypto.randomUUID();
    const leaseExpiresAt = new Date(
      Math.min(now.getTime() + config.leaseMs, new Date(candidate.deadline_at).getTime()),
    );
    const claimed = await Model.findOneAndUpdate(
      {
        _id: candidate._id,
        active: true,
        cancel_requested_at: null,
        status: candidate.status,
        next_attempt_at: candidate.next_attempt_at,
        deadline_at: candidate.deadline_at,
      },
      {
        $set: {
          status: 'processing',
          lease_owner: workerId,
          lease_expires_at: leaseExpiresAt,
          execution_token: token,
          started_at: now,
          current_output_file_ids: [],
          completion_output_file_ids: [],
        },
        $inc: { attempt_count: 1, target_generation: 1 },
      },
      { new: true },
    ).lean();
    if (claimed) return claimed;
  }
  return null;
}

function deriveTranslationOutputId({ jobId, generation, inputFileId, index }) {
  const chars = sha256(`${jobId}:${generation}:${inputFileId}:${index}`).slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

async function prepareTranslationAttempt({ jobId, token, generation, now = new Date() }) {
  const Model = getTranslationJobModel();
  const claim = await Model.findOne({
    job_id: jobId,
    status: 'processing',
    active: true,
    execution_token: token,
    target_generation: generation,
    cancel_requested_at: null,
    deadline_at: { $gt: now },
  }).lean();
  if (!claim) return null;
  const outputFileIds = claim.input_files.map((file, index) =>
    deriveTranslationOutputId({
      jobId,
      generation,
      inputFileId: file.file_id,
      index,
    }),
  );
  const existing = claim.attempt_outputs?.find((attempt) => attempt.generation === generation);
  if (existing) {
    const exact =
      existing.output_file_ids.length === outputFileIds.length &&
      existing.output_file_ids.every((fileId, index) => fileId === outputFileIds[index]);
    if (!exact) return null;
    if (
      !(await translationConversationExists({
        user: claim.user,
        tenantId: claim.tenantId,
        conversationId: claim.conversation_id,
      }))
    ) {
      await cancelTranslationJobsByConversation({
        user: claim.user,
        tenantId: claim.tenantId,
        conversationIds: [claim.conversation_id],
        now,
      });
      await cancelClaimedTranslationJob({
        jobId,
        token,
        generation,
        now,
      });
      return null;
    }
    return claim;
  }
  const inputFiles = claim.input_files.map((file, index) => ({
    file_id: file.file_id,
    filename: file.filename,
    type: file.type,
    bytes: file.bytes,
    output_file_id: outputFileIds[index],
  }));
  const prepared = await Model.findOneAndUpdate(
    {
      _id: claim._id,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
      cancel_requested_at: null,
      deadline_at: { $gt: now },
      attempt_outputs: { $not: { $elemMatch: { generation } } },
    },
    {
      $set: {
        input_files: inputFiles,
        current_output_file_ids: outputFileIds,
        planned_output_file_ids: outputFileIds,
      },
      $push: {
        attempt_outputs: {
          $each: [
            {
              generation,
              output_file_ids: outputFileIds,
              locator_fenced: true,
              cleanup_status: 'prepared',
              prepared_at: now,
            },
          ],
          $slice: -ATTEMPT_OUTPUT_LEDGER_LIMIT,
        },
      },
    },
    { new: true },
  ).lean();
  if (
    prepared &&
    !(await translationConversationExists({
      user: prepared.user,
      tenantId: prepared.tenantId,
      conversationId: prepared.conversation_id,
    }))
  ) {
    await cancelTranslationJobsByConversation({
      user: prepared.user,
      tenantId: prepared.tenantId,
      conversationIds: [prepared.conversation_id],
      now,
    });
    await cancelClaimedTranslationJob({
      jobId,
      token,
      generation,
      now,
    });
    return null;
  }
  return prepared;
}

async function prepareTranslationStorageLocator({
  jobId,
  token,
  generation,
  locator,
  now = new Date(),
}) {
  const current = await assertTranslationWriteFence({
    jobId,
    token,
    generation,
    outputFileId: locator.file_id,
    now,
  });
  const attempt = current.attempt_outputs?.find((entry) => entry.generation === generation);
  if (!attempt) return false;
  const existing = attempt.storage_locators?.find((entry) => entry.file_id === locator.file_id);
  if (existing) {
    return (
      existing.source === locator.source &&
      existing.filepath === locator.filepath &&
      (existing.storageKey ?? null) === (locator.storageKey ?? null)
    );
  }
  const result = await getTranslationJobModel().updateOne(
    {
      job_id: jobId,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
      current_output_file_ids: locator.file_id,
      cancel_requested_at: null,
      deadline_at: { $gt: now },
      attempt_outputs: {
        $elemMatch: {
          generation,
          'storage_locators.file_id': { $ne: locator.file_id },
        },
      },
    },
    { $push: { 'attempt_outputs.$[attempt].storage_locators': locator } },
    { arrayFilters: [{ 'attempt.generation': generation }] },
  );
  return result.modifiedCount === 1;
}

async function heartbeatTranslationJob({ jobId, token, generation, now = new Date() }) {
  const Model = getTranslationJobModel();
  const current = await Model.findOne({
    job_id: jobId,
    status: 'processing',
    active: true,
    execution_token: token,
    target_generation: generation,
    cancel_requested_at: null,
    deadline_at: { $gt: now },
  })
    .select({ deadline_at: 1 })
    .lean();
  if (!current) return false;
  const leaseExpiresAt = new Date(
    Math.min(
      now.getTime() + getTranslationJobConfig().leaseMs,
      new Date(current.deadline_at).getTime(),
    ),
  );
  const result = await Model.updateOne(
    {
      _id: current._id,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
      cancel_requested_at: null,
      deadline_at: { $gt: now },
    },
    { $set: { lease_expires_at: leaseExpiresAt } },
  );
  return result.modifiedCount === 1;
}

async function assertTranslationWriteFence({
  jobId,
  token,
  generation,
  outputFileId,
  now = new Date(),
}) {
  const job = await getTranslationJobModel()
    .findOne({
      job_id: jobId,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
      current_output_file_ids: outputFileId,
      cancel_requested_at: null,
      deadline_at: { $gt: now },
    })
    .lean();
  if (!job) {
    throw new IdmlError('Translation attempt is no longer writable', 'translation_fence_lost', 409);
  }
  if (
    !(await translationConversationExists({
      user: job.user,
      tenantId: job.tenantId,
      conversationId: job.conversation_id,
    }))
  ) {
    await cancelTranslationJobsByConversation({
      user: job.user,
      tenantId: job.tenantId,
      conversationIds: [job.conversation_id],
      now,
    });
    throw new IdmlError(
      'The owning conversation no longer exists',
      'translation_conversation_not_found',
      409,
    );
  }
  return job;
}

async function recordTranslationCleanupDebt({
  jobId,
  generation,
  outputFileIds,
  replaceOutputFileIds = false,
  now = new Date(),
}) {
  const Model = getTranslationJobModel();
  const cleanupAfter = new Date(now.getTime() + cleanupDelayMs());
  const updated = await Model.updateOne(
    { job_id: jobId, 'attempt_outputs.generation': generation },
    {
      $set: {
        'attempt_outputs.$[attempt].cleanup_status': 'cleanup_pending',
        'attempt_outputs.$[attempt].cleanup_after': cleanupAfter,
        'attempt_outputs.$[attempt].cleaned_at': null,
        ...(replaceOutputFileIds
          ? { 'attempt_outputs.$[attempt].output_file_ids': outputFileIds }
          : {}),
        expires_at: null,
        cleanup_swept_at: null,
      },
    },
    { arrayFilters: [{ 'attempt.generation': generation }] },
  );
  if (updated.matchedCount === 1) return true;
  const inserted = await Model.updateOne(
    { job_id: jobId, attempt_outputs: { $not: { $elemMatch: { generation } } } },
    {
      $set: { expires_at: null, cleanup_swept_at: null },
      $push: {
        attempt_outputs: {
          $each: [
            {
              generation,
              output_file_ids: outputFileIds,
              cleanup_status: 'cleanup_pending',
              prepared_at: now,
              cleanup_after: cleanupAfter,
            },
          ],
          $slice: -ATTEMPT_OUTPUT_LEDGER_LIMIT,
        },
      },
    },
  );
  return inserted.matchedCount === 1;
}

async function clearTranslationCleanupDebt({ jobId, generation, now = new Date() }) {
  const result = await getTranslationJobModel().updateOne(
    {
      job_id: jobId,
      attempt_outputs: {
        $elemMatch: { generation, cleanup_status: 'cleanup_pending' },
      },
    },
    {
      $set: {
        'attempt_outputs.$[attempt].cleanup_status': 'clean',
        'attempt_outputs.$[attempt].cleaned_at': now,
        'attempt_outputs.$[attempt].cleanup_after': null,
      },
    },
    {
      arrayFilters: [
        { 'attempt.generation': generation, 'attempt.cleanup_status': 'cleanup_pending' },
      ],
    },
  );
  return result.modifiedCount === 1;
}

async function deferTranslationCleanupDebt({ jobId, generation, now = new Date() }) {
  const result = await getTranslationJobModel().updateOne(
    {
      job_id: jobId,
      attempt_outputs: {
        $elemMatch: { generation, cleanup_status: 'cleanup_pending' },
      },
    },
    {
      $set: {
        'attempt_outputs.$[attempt].cleanup_after': new Date(now.getTime() + cleanupDelayMs()),
      },
    },
    {
      arrayFilters: [
        { 'attempt.generation': generation, 'attempt.cleanup_status': 'cleanup_pending' },
      ],
    },
  );
  return result.modifiedCount === 1;
}

async function completeTranslationJob({
  jobId,
  token,
  generation,
  outputFileIds,
  report,
  now = new Date(),
}) {
  const current = await assertTranslationWriteFence({
    jobId,
    token,
    generation,
    outputFileId: outputFileIds[0],
    now,
  }).catch((error) => {
    if (error?.code === 'translation_fence_lost') return null;
    throw error;
  });
  if (!current) return null;
  const planned = new Set(current.current_output_file_ids);
  if (
    new Set(outputFileIds).size !== outputFileIds.length ||
    outputFileIds.some((fileId) => !planned.has(fileId))
  ) {
    return null;
  }
  const staged = await getTranslationJobModel().updateOne(
    {
      job_id: jobId,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
      cancel_requested_at: null,
      deadline_at: { $gt: now },
    },
    { $set: { completion_output_file_ids: outputFileIds } },
  );
  if (staged.matchedCount !== 1) return null;
  const status = report?.status === 'partial' ? 'partial' : 'completed';
  return getTranslationJobModel()
    .findOneAndUpdate(
      {
        job_id: jobId,
        status: 'processing',
        active: true,
        execution_token: token,
        target_generation: generation,
        completion_output_file_ids: outputFileIds,
        cancel_requested_at: null,
        deadline_at: { $gt: now },
      },
      {
        $set: {
          status,
          active: false,
          published_generation: generation,
          output_file_ids: outputFileIds,
          report,
          finished_at: now,
          expires_at: null,
          lease_owner: null,
          lease_expires_at: null,
          execution_token: null,
          'attempt_outputs.$[attempt].cleanup_status': 'published',
        },
      },
      {
        new: true,
        arrayFilters: [
          {
            'attempt.generation': generation,
            'attempt.output_file_ids': outputFileIds,
          },
        ],
      },
    )
    .lean();
}

function classifyTranslationError(error) {
  if (['translation_job_deadline', 'translation_conversation_not_found'].includes(error?.code)) {
    return 'permanent';
  }
  const status = error?.status ?? error?.response?.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return 'retryable';
  if (status >= 400 && status < 500) return 'permanent';
  if (
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN'].includes(
      error?.code,
    )
  ) {
    return 'retryable';
  }
  return 'retryable';
}

function retryAfterMs(error, now = new Date()) {
  const raw = error?.retryAfter ?? error?.response?.headers?.['retry-after'];
  if (raw == null) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw) - now.getTime();
  return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : 0;
}

function computeRetryAt({ attempt, error, now = new Date() }) {
  const config = getTranslationJobConfig();
  const ceiling = Math.min(
    config.backoffMaxMs,
    config.backoffBaseMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = crypto.randomInt(1, Math.max(2, ceiling + 1));
  const providerDelay = retryAfterMs(error, now);
  return new Date(now.getTime() + Math.max(providerDelay, jitter));
}

const safeErrorDetail = (error) =>
  error instanceof IdmlError
    ? String(error.message).slice(0, ERROR_DETAIL_MAX)
    : 'Translation temporarily failed';

async function failTranslationJob({ job, error, now = new Date() }) {
  const Model = getTranslationJobModel();
  const kind = classifyTranslationError(error);
  const config = getTranslationJobConfig();
  const cap = kind === 'auth' ? config.authAttemptCap : config.attemptCap;
  const retryAt = computeRetryAt({ attempt: job.attempt_count, error, now });
  const deadlineAt = new Date(job.deadline_at);
  const deadlineFailure =
    now >= deadlineAt ||
    retryAt.getTime() >= deadlineAt.getTime() ||
    error?.code === 'translation_job_deadline';
  const retry = !deadlineFailure && kind !== 'permanent' && job.attempt_count < cap;
  const update = retry
    ? { status: 'retrying', next_attempt_at: retryAt }
    : { status: 'failed', active: false, finished_at: now, expires_at: null };
  const errorCode = deadlineFailure
    ? 'translation_job_deadline'
    : (error?.code ?? 'translation_failed');
  const cleanupAfter = new Date(now.getTime() + cleanupDelayMs());
  const result = await Model.findOneAndUpdate(
    {
      job_id: job.job_id,
      status: 'processing',
      active: true,
      execution_token: job.execution_token,
      target_generation: job.target_generation,
      cancel_requested_at: null,
    },
    {
      $set: {
        ...update,
        last_error_code: errorCode,
        last_error_detail: deadlineFailure
          ? 'Translation job exceeded its maximum age'
          : safeErrorDetail(error),
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
        'attempt_outputs.$[attempt].cleanup_status': 'cleanup_pending',
        'attempt_outputs.$[attempt].cleanup_after': cleanupAfter,
        'attempt_outputs.$[attempt].cleaned_at': null,
      },
    },
    {
      new: true,
      arrayFilters: [{ 'attempt.generation': job.target_generation }],
    },
  ).lean();
  if (
    result &&
    !result.attempt_outputs?.some(
      (attempt) =>
        attempt.generation === job.target_generation &&
        attempt.cleanup_status === 'cleanup_pending',
    )
  ) {
    await recordTranslationCleanupDebt({
      jobId: job.job_id,
      generation: job.target_generation,
      outputFileIds: job.current_output_file_ids ?? [],
      now,
    });
    return Model.findOne({ job_id: job.job_id }).lean();
  }
  return result;
}

async function cancelClaimedTranslationJob({ jobId, token, generation, now = new Date() }) {
  const Model = getTranslationJobModel();
  const cleanupAfter = new Date(now.getTime() + cleanupDelayMs());
  const result = await Model.findOneAndUpdate(
    {
      job_id: jobId,
      status: 'processing',
      active: true,
      execution_token: token,
      target_generation: generation,
    },
    {
      $set: {
        status: 'cancelled',
        active: false,
        cancel_requested_at: now,
        finished_at: now,
        expires_at: null,
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
        'attempt_outputs.$[attempt].cleanup_status': 'cleanup_pending',
        'attempt_outputs.$[attempt].cleanup_after': cleanupAfter,
        'attempt_outputs.$[attempt].cleaned_at': null,
      },
    },
    {
      new: true,
      arrayFilters: [{ 'attempt.generation': generation }],
    },
  ).lean();
  if (
    result &&
    !result.attempt_outputs?.some(
      (attempt) =>
        attempt.generation === generation && attempt.cleanup_status === 'cleanup_pending',
    )
  ) {
    await recordTranslationCleanupDebt({
      jobId,
      generation,
      outputFileIds: result.current_output_file_ids ?? [],
      now,
    });
    return Model.findOne({ job_id: jobId }).lean();
  }
  return result;
}

async function recoverExpiredTranslationJob({ now = new Date() } = {}) {
  const Model = getTranslationJobModel();
  const config = getTranslationJobConfig();
  await upgradeActiveTranslationJobs({ now });
  await releaseOverdueQueuedTranslationJobs({ now });
  const candidate = await Model.findOne({
    active: true,
    status: 'processing',
    $or: [{ lease_expires_at: { $lte: now } }, { deadline_at: { $lte: now } }],
  })
    .sort({ lease_expires_at: 1 })
    .lean();
  if (!candidate) return null;
  const retryAt = computeRetryAt({
    attempt: candidate.attempt_count,
    error: { code: 'worker_lease_expired' },
    now,
  });
  const deadline =
    new Date(candidate.deadline_at).getTime() <= now.getTime() ||
    retryAt.getTime() >= new Date(candidate.deadline_at).getTime();
  const cancelled = candidate.cancel_requested_at != null;
  const exhausted = candidate.attempt_count >= config.attemptCap;
  const terminal = deadline || cancelled || exhausted;
  let status = 'retrying';
  let lastErrorCode = 'worker_lease_expired';
  let lastErrorDetail = 'Translation worker lease expired';
  if (deadline) {
    status = 'failed';
    lastErrorCode = 'translation_job_deadline';
    lastErrorDetail = 'Translation job exceeded its maximum age';
  } else if (cancelled) {
    status = 'cancelled';
    lastErrorCode = candidate.last_error_code;
    lastErrorDetail = candidate.last_error_detail;
  } else if (exhausted) {
    status = 'failed';
    lastErrorDetail = 'Translation worker lease expired at the retry limit';
  }
  const cleanupAfter = new Date(now.getTime() + cleanupDelayMs());
  const update = terminal
    ? { status, active: false, finished_at: now, expires_at: null }
    : {
        status,
        next_attempt_at: retryAt,
      };
  const recovered = await Model.findOneAndUpdate(
    {
      _id: candidate._id,
      active: true,
      status: 'processing',
      execution_token: candidate.execution_token,
      target_generation: candidate.target_generation,
      $or: [{ lease_expires_at: { $lte: now } }, { deadline_at: { $lte: now } }],
    },
    {
      $set: {
        ...update,
        last_error_code: lastErrorCode,
        last_error_detail: lastErrorDetail,
        lease_owner: null,
        lease_expires_at: null,
        execution_token: null,
        'attempt_outputs.$[attempt].cleanup_status': 'cleanup_pending',
        'attempt_outputs.$[attempt].cleanup_after': cleanupAfter,
        'attempt_outputs.$[attempt].cleaned_at': null,
      },
    },
    {
      new: true,
      arrayFilters: [{ 'attempt.generation': candidate.target_generation }],
    },
  ).lean();
  if (!recovered) return null;
  if (
    !recovered.attempt_outputs?.some(
      (attempt) =>
        attempt.generation === candidate.target_generation &&
        attempt.cleanup_status === 'cleanup_pending',
    )
  ) {
    await recordTranslationCleanupDebt({
      jobId: recovered.job_id,
      generation: candidate.target_generation,
      outputFileIds: candidate.current_output_file_ids ?? [],
      now,
    });
  }
  return Model.findOne({ job_id: recovered.job_id }).lean();
}

async function findTranslationReconcileCandidates({ now = new Date(), limit } = {}) {
  const config = getTranslationJobConfig();
  const batchLimit = limit ?? config.reconcileBatchLimit;
  await upgradeActiveTranslationJobs({ now, limit: batchLimit });
  const candidates = await getTranslationJobModel()
    .find({
      $or: [
        {
          attempt_outputs: {
            $elemMatch: {
              cleanup_status: 'cleanup_pending',
              cleanup_after: { $lte: now },
            },
          },
        },
        {
          status: { $in: TERMINAL_STATUSES },
          expires_at: null,
          updatedAt: { $lte: new Date(now.getTime() - cleanupDelayMs()) },
          attempt_outputs: {
            $not: { $elemMatch: { cleanup_status: 'cleanup_pending' } },
          },
        },
      ],
    })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(batchLimit)
    .lean();
  return candidates;
}

async function finalizeTranslationJobExpiry({ jobId, now = new Date() }) {
  return getTranslationJobModel()
    .findOneAndUpdate(
      {
        job_id: jobId,
        status: { $in: TERMINAL_STATUSES },
        expires_at: null,
        attempt_outputs: {
          $not: { $elemMatch: { cleanup_status: 'cleanup_pending' } },
        },
      },
      {
        $set: {
          cleanup_swept_at: now,
          expires_at: terminalExpiry(now),
        },
      },
      { new: true },
    )
    .lean();
}

let missingConversationCursor = null;

async function reconcileMissingConversationTranslationJobs({ now = new Date(), limit } = {}) {
  const batchLimit = limit ?? getTranslationJobConfig().reconcileBatchLimit;
  const jobs = await getTranslationJobModel()
    .find({
      conversation_id: { $nin: [null, '', Constants.NEW_CONVO] },
      $or: [{ active: true }, { status: { $in: ['completed', 'partial'] } }],
      ...(missingConversationCursor ? { _id: { $gt: missingConversationCursor } } : {}),
    })
    .sort({ _id: 1 })
    .limit(batchLimit)
    .lean();
  missingConversationCursor = jobs.length < batchLimit ? null : jobs[jobs.length - 1]._id;
  let cancelled = 0;
  for (const job of jobs) {
    if (
      await translationConversationExists({
        user: job.user,
        tenantId: job.tenantId,
        conversationId: job.conversation_id,
      })
    ) {
      continue;
    }
    const result = await cancelTranslationJobsByConversation({
      user: job.user,
      tenantId: job.tenantId,
      conversationIds: [job.conversation_id],
      now,
    });
    cancelled += result.queued + result.processing + result.terminal;
  }
  return { scanned: jobs.length, cancelled };
}

module.exports = {
  ACTIVE_STATUSES,
  ATTEMPT_OUTPUT_LEDGER_LIMIT,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  assertTranslationWriteFence,
  cancelClaimedTranslationJob,
  cancelTranslationJobsByConversation,
  claimNextTranslationJob,
  classifyTranslationError,
  clearTranslationCleanupDebt,
  completeTranslationJob,
  computeRetryAt,
  deferTranslationCleanupDebt,
  deriveTranslationOutputId,
  enqueueTranslationJob,
  failTranslationJob,
  finalizeTranslationJobExpiry,
  findTranslationReconcileCandidates,
  getOwnedTranslationJob,
  getTranslationJobConfig,
  getTranslationJobModel,
  heartbeatTranslationJob,
  makeIdempotencyKey,
  prepareTranslationAttempt,
  prepareTranslationStorageLocator,
  reconcileMissingConversationTranslationJobs,
  recordTranslationCleanupDebt,
  recoverExpiredTranslationJob,
  releaseOverdueQueuedTranslationJobs,
  requestTranslationCancellation,
  retryAfterMs,
  translationConversationExists,
  upgradeActiveTranslationJobs,
};

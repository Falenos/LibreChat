// [knauf] Generate immutable turn ownership without adding a dependency.
import { randomUUID } from 'node:crypto';
// End [knauf]
import { logger } from '@librechat/data-schemas';
import { createContentAggregator } from '@librechat/agents';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import {
  GenerationConflictError,
  type GenerationRef,
  type SerializableJobData,
  type UsageMetadata,
  type IJobStore,
  type JobStatus,
  type TerminalJobStatus,
} from '~/stream/interfaces/IJobStore';

/**
 * Key prefixes for Redis storage.
 * All keys include the streamId for easy cleanup.
 * Note: streamId === conversationId, so no separate mapping needed.
 *
 * IMPORTANT: Uses hash tags {streamId} for Redis Cluster compatibility.
 * All keys for the same stream hash to the same slot, enabling:
 * - Pipeline operations across related keys
 * - Atomic multi-key operations
 */
const KEYS = {
  /** Job metadata: stream:{streamId}:job */
  job: (streamId: string) => `stream:{${streamId}}:job`,
  // [knauf] Volatile content is isolated per generation; omitted IDs retain legacy keys.
  chunks: (streamId: string, generationId?: string) =>
    generationId == null
      ? `stream:{${streamId}}:chunks`
      : `stream:{${streamId}}:generation:${generationId}:chunks`,
  runSteps: (streamId: string, generationId?: string) =>
    generationId == null
      ? `stream:{${streamId}}:runsteps`
      : `stream:{${streamId}}:generation:${generationId}:runsteps`,
  // End [knauf]
  /** Running jobs set for cleanup (global set - single slot) */
  runningJobs: 'stream:running',
  /** User's active jobs set, tenant-qualified when tenantId is available */
  userJobs: (userId: string, tenantId?: string) =>
    tenantId ? `stream:user:{${tenantId}:${userId}}:jobs` : `stream:user:{${userId}}:jobs`,
};

// [knauf] Atomic owner claims/CAS and generation-aware active-set members.
const CREATE_JOB_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'running' then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`;

const UPDATE_JOB_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 4))
return 1
`;

// KK20-338 — status, payload and winner token commit in one running-to-terminal CAS.
const TERMINAL_TRANSITION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 4))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
local chunks_ttl = tonumber(ARGV[4])
if chunks_ttl == 0 then
  redis.call('DEL', KEYS[2])
else
  redis.call('EXPIRE', KEYS[2], chunks_ttl)
end
local runsteps_ttl = tonumber(ARGV[5])
if runsteps_ttl == 0 then
  redis.call('DEL', KEYS[3])
else
  redis.call('EXPIRE', KEYS[3], runsteps_ttl)
end
return 1
`;

const CLAIM_TERMINAL_EFFECTS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if (redis.call('HGET', KEYS[1], 'terminalId') or '') ~= ARGV[3] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') == 'running' then
  return 0
end
return redis.call('HSETNX', KEYS[1], 'terminalEffectsRecorded', '1')
`;

const ACKNOWLEDGE_TERMINAL_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') == 'running' then
  return 0
end
redis.call('HSET', KEYS[1], 'terminalAcknowledged', '1')
return 1
`;

const DELETE_JOB_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 1
`;

const APPEND_CHUNK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then
  return 0
end
redis.call('XADD', KEYS[2], '*', 'event', ARGV[4])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

const SAVE_RUN_STEPS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if ARGV[1] == '1' and (redis.call('HGET', KEYS[1], 'generationId') or '') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then
  return 0
end
redis.call('SET', KEYS[2], ARGV[4], 'EX', tonumber(ARGV[3]))
return 1
`;

function generationKey(streamId: string, generationId?: string): string {
  return generationId == null ? streamId : JSON.stringify([streamId, generationId]);
}

function parseGenerationKey(value: string): GenerationRef {
  if (!value.startsWith('[')) {
    return { streamId: value };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { streamId: parsed[0], generationId: parsed[1] };
    }
  } catch {
    // Fall through: pre-generation stream IDs remain valid opaque values.
  }

  return { streamId: value };
}

function exactlyOwnsGeneration(
  job: SerializableJobData | null,
  generationId?: string,
): job is SerializableJobData {
  return job != null && job.generationId === generationId;
}
// End [knauf]

/**
 * Default TTL values in seconds.
 * Can be overridden via constructor options.
 */
const DEFAULT_TTL = {
  /** TTL for completed jobs (5 minutes) */
  completed: 300,
  /** TTL for running jobs/chunks (20 minutes - failsafe for crashed jobs) */
  running: 1200,
  /** TTL for chunks after completion (0 = delete immediately) */
  chunksAfterComplete: 0,
  /** TTL for run steps after completion (0 = delete immediately) */
  runStepsAfterComplete: 0,
  /** Safety-net TTL for per-user job tracking sets (24 hours). Refreshed on each createJob. */
  userJobsSet: 86400,
};

/**
 * Redis implementation of IJobStore.
 * Enables horizontal scaling with multi-instance deployments.
 *
 * Storage strategy:
 * - Job metadata: Redis Hash (fast field access)
 * - Chunks: Redis Streams (append-only, efficient for streaming)
 * - Run steps: Redis String (JSON serialized)
 *
 * Note: streamId === conversationId, so getJob(conversationId) works directly.
 *
 * @example
 * ```ts
 * import { ioredisClient } from '~/cache';
 * const store = new RedisJobStore(ioredisClient);
 * await store.initialize();
 * ```
 */
/**
 * Configuration options for RedisJobStore
 */
export interface RedisJobStoreOptions {
  /** TTL for completed jobs in seconds (default: 300 = 5 minutes) */
  completedTtl?: number;
  /** TTL for running jobs/chunks in seconds (default: 1200 = 20 minutes) */
  runningTtl?: number;
  /** TTL for chunks after completion in seconds (default: 0 = delete immediately) */
  chunksAfterCompleteTtl?: number;
  /** TTL for run steps after completion in seconds (default: 0 = delete immediately) */
  runStepsAfterCompleteTtl?: number;
  /** TTL for per-user job tracking sets in seconds (default: 86400 = 24 hours). 0 = no TTL. */
  userJobsSetTtl?: number;
}

export class RedisJobStore implements IJobStore {
  private redis: Redis | Cluster;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private ttl: typeof DEFAULT_TTL;

  /** Whether Redis client is in cluster mode (affects pipeline usage) */
  private isCluster: boolean;

  /**
   * Local cache for graph references on THIS instance.
   * Enables fast reconnects when client returns to the same server.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  private localGraphCache = new Map<string, WeakRef<StandardGraph>>();

  /**
   * Local cache for collectedUsage arrays.
   * Generation happens on a single instance, so collectedUsage is only available locally.
   * For cross-replica abort, the abort handler falls back to text-based token counting.
   */
  private localCollectedUsageCache = new Map<string, UsageMetadata[]>();

  // [knauf] Lets synchronous local-cache APIs resolve legacy omitted owner arguments.
  private currentGenerationCache = new Map<string, string | null>();
  // End [knauf]

  /** Cleanup interval in ms (1 minute) */
  private cleanupIntervalMs = 60000;

  // [knauf] Resolve old call sites to the last observed current generation.
  private cachedGenerationId(streamId: string, generationId?: string): string | undefined {
    if (generationId != null) {
      return generationId;
    }
    return this.currentGenerationCache.get(streamId) ?? undefined;
  }

  private cacheKey(streamId: string, generationId?: string): string {
    return generationKey(streamId, this.cachedGenerationId(streamId, generationId));
  }

  private cacheMatchesOwner(streamId: string, generationId?: string): boolean {
    if (generationId == null || !this.currentGenerationCache.has(streamId)) {
      return true;
    }
    return this.currentGenerationCache.get(streamId) === generationId;
  }
  // End [knauf]

  constructor(redis: Redis | Cluster, options?: RedisJobStoreOptions) {
    this.redis = redis;
    this.ttl = {
      completed: options?.completedTtl ?? DEFAULT_TTL.completed,
      running: options?.runningTtl ?? DEFAULT_TTL.running,
      chunksAfterComplete: options?.chunksAfterCompleteTtl ?? DEFAULT_TTL.chunksAfterComplete,
      runStepsAfterComplete: options?.runStepsAfterCompleteTtl ?? DEFAULT_TTL.runStepsAfterComplete,
      userJobsSet: options?.userJobsSetTtl ?? DEFAULT_TTL.userJobsSet,
    };
    // Detect cluster mode using ioredis's isCluster property
    this.isCluster = (redis as Cluster).isCluster === true;
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((err) => {
        logger.error('[RedisJobStore] Cleanup error:', err);
      });
    }, this.cleanupIntervalMs);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.info('[RedisJobStore] Initialized with cleanup interval');
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    generationId: string = randomUUID(),
  ): Promise<SerializableJobData> {
    // [knauf] Redis atomically rejects active owners and clears every stale terminal field.
    const job: SerializableJobData = {
      streamId,
      generationId,
      userId,
      ...(tenantId && { tenantId }),
      status: 'running',
      createdAt: Date.now(),
      conversationId,
      syncSent: false,
    };

    const key = KEYS.job(streamId);
    const userJobsKey = KEYS.userJobs(userId, tenantId);
    const trackingMember = generationKey(streamId, generationId);
    const fields = Object.entries(this.serializeJob(job)).flat();
    const created = await this.redis.eval(
      CREATE_JOB_SCRIPT,
      1,
      key,
      String(this.ttl.running),
      ...fields,
    );

    if (Number(created) === 0) {
      throw new GenerationConflictError(streamId);
    }

    const previousGenerationId = this.currentGenerationCache.get(streamId) ?? undefined;
    if (previousGenerationId !== generationId) {
      this.localGraphCache.delete(generationKey(streamId, previousGenerationId));
      this.localCollectedUsageCache.delete(generationKey(streamId, previousGenerationId));
    }
    this.currentGenerationCache.set(streamId, generationId);

    // For cluster mode, we can't pipeline keys on different slots
    // The job key uses hash tag {streamId}, runningJobs and userJobs are on different slots
    try {
      if (this.isCluster) {
        await this.redis.sadd(KEYS.runningJobs, trackingMember);
        await this.redis.sadd(userJobsKey, trackingMember);
        if (this.ttl.userJobsSet > 0) {
          await this.redis.expire(userJobsKey, this.ttl.userJobsSet);
        }
      } else {
        const pipeline = this.redis.pipeline();
        pipeline.sadd(KEYS.runningJobs, trackingMember);
        pipeline.sadd(userJobsKey, trackingMember);
        if (this.ttl.userJobsSet > 0) {
          pipeline.expire(userJobsKey, this.ttl.userJobsSet);
        }
        await pipeline.exec();
      }
    } catch (error) {
      await this.deleteJob(streamId, generationId).catch(() => undefined);
      throw error;
    }
    // End [knauf]

    logger.debug(`[RedisJobStore] Created job: ${streamId}`);
    return job;
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    const data = await this.redis.hgetall(KEYS.job(streamId));
    if (!data || Object.keys(data).length === 0) {
      // [knauf] Cache absence too, so legacy synchronous calls do not reuse an old owner.
      this.currentGenerationCache.delete(streamId);
      // End [knauf]
      return null;
    }
    // [knauf] Remember the observed owner for synchronous graph/usage APIs.
    const job = this.deserializeJob(data);
    this.currentGenerationCache.set(streamId, job.generationId ?? null);
    return job;
    // End [knauf]
  }

  async updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    generationId?: string,
  ): Promise<void> {
    // [knauf] Read the owner before CAS so post-terminal cleanup cannot target a replacement.
    const key = KEYS.job(streamId);
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return;
    }
    const resolvedGenerationId = job.generationId;

    const safeUpdates = { ...updates };
    delete safeUpdates.generationId;
    if (safeUpdates.status && safeUpdates.status !== 'running') {
      await this.transitionToTerminal(
        streamId,
        {
          ...safeUpdates,
          status: safeUpdates.status,
          completedAt: safeUpdates.completedAt ?? Date.now(),
          terminalId: safeUpdates.terminalId ?? randomUUID(),
        },
        generationId,
      );
      return;
    }
    const serialized = this.serializeJob(safeUpdates as SerializableJobData);
    if (Object.keys(serialized).length === 0) {
      return;
    }

    const fields = Object.entries(serialized).flat();
    const updated = await this.redis.eval(
      UPDATE_JOB_SCRIPT,
      1,
      key,
      '1',
      resolvedGenerationId ?? '',
      '-1',
      ...fields,
    );

    if (Number(updated) === 0) {
      return;
    }

    // End [knauf]
  }

  // [knauf] KK20-338 — atomically commit one terminal owner and payload.
  async transitionToTerminal(
    streamId: string,
    updates: Partial<SerializableJobData> & {
      status: TerminalJobStatus;
      completedAt: number;
      terminalId: string;
    },
    generationId?: string,
  ): Promise<boolean> {
    const job = await this.getJob(streamId);
    if (
      !job ||
      (generationId != null && job.generationId !== generationId) ||
      job.status !== 'running'
    ) {
      return false;
    }
    const safeUpdates = { ...updates };
    delete safeUpdates.generationId;
    const serialized = this.serializeJob(safeUpdates as SerializableJobData);
    const fields = Object.entries(serialized).flat();
    const transitioned = await this.redis.eval(
      TERMINAL_TRANSITION_SCRIPT,
      3,
      KEYS.job(streamId),
      KEYS.chunks(streamId, job.generationId),
      KEYS.runSteps(streamId, job.generationId),
      '1',
      job.generationId ?? '',
      String(this.ttl.completed),
      String(this.ttl.chunksAfterComplete),
      String(this.ttl.runStepsAfterComplete),
      ...fields,
    );
    if (Number(transitioned) !== 1) {
      return false;
    }

    await this.cleanupTerminalTracking(job).catch((error) => {
      logger.warn(`[RedisJobStore] Terminal tracking cleanup failed for ${streamId}:`, error);
    });
    return true;
  }
  // End [knauf]

  // [knauf] KK20-338 — dedupe terminal metrics after the durable transition.
  async claimTerminalEffects(
    streamId: string,
    terminalId: string,
    generationId?: string,
  ): Promise<boolean> {
    const claimed = await this.redis.eval(
      CLAIM_TERMINAL_EFFECTS_SCRIPT,
      1,
      KEYS.job(streamId),
      generationId != null ? '1' : '0',
      generationId ?? '',
      terminalId,
    );
    return Number(claimed) === 1;
  }
  // End [knauf]

  // [knauf] KK20-338 — acknowledge that the owner observed durable cancellation.
  async acknowledgeTerminal(streamId: string, generationId?: string): Promise<void> {
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return;
    }
    const acknowledged = await this.redis.eval(
      ACKNOWLEDGE_TERMINAL_SCRIPT,
      1,
      KEYS.job(streamId),
      generationId != null ? '1' : '0',
      generationId ?? '',
    );
    if (Number(acknowledged) === 1 && job.userId) {
      await this.redis.srem(
        KEYS.userJobs(job.userId, job.tenantId),
        generationKey(streamId, job.generationId),
      );
    }
  }
  // End [knauf]

  private async cleanupTerminalTracking(job: SerializableJobData): Promise<void> {
    const { streamId, generationId } = job;
    const trackingMember = generationKey(streamId, generationId);
    this.localGraphCache.delete(trackingMember);
    this.localCollectedUsageCache.delete(trackingMember);

    if (this.isCluster) {
      await this.redis.srem(KEYS.runningJobs, trackingMember);
      return;
    }

    const pipeline = this.redis.pipeline();
    pipeline.srem(KEYS.runningJobs, trackingMember);
    const results = await pipeline.exec();
    if (results?.some(([error]) => error != null)) {
      throw new Error(`Failed to remove terminal job ${streamId} from running tracking`);
    }
  }

  async deleteJob(streamId: string, generationId?: string): Promise<void> {
    // [knauf] Capture the observed owner; deletion is atomically fenced to it.
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return;
    }
    return this.deleteJobInternal(job);
    // End [knauf]
  }

  private async deleteJobInternal(job: SerializableJobData): Promise<void> {
    // [knauf] Job/content keys share a Redis slot; tracking members are owner-scoped cross-slot.
    const { streamId, generationId } = job;
    const trackingMember = generationKey(streamId, generationId);
    const deleted = await this.redis.eval(
      DELETE_JOB_SCRIPT,
      3,
      KEYS.job(streamId),
      KEYS.chunks(streamId, generationId),
      KEYS.runSteps(streamId, generationId),
      '1',
      generationId ?? '',
    );
    if (Number(deleted) === 0) {
      return;
    }

    this.localGraphCache.delete(trackingMember);
    this.localCollectedUsageCache.delete(trackingMember);
    if (this.currentGenerationCache.get(streamId) === (generationId ?? null)) {
      this.currentGenerationCache.delete(streamId);
    }
    const userJobsKey = job.userId ? KEYS.userJobs(job.userId, job.tenantId) : null;

    if (this.isCluster) {
      await this.redis.srem(KEYS.runningJobs, trackingMember);
      if (userJobsKey) {
        await this.redis.srem(userJobsKey, trackingMember);
      }
    } else {
      const pipeline = this.redis.pipeline();
      pipeline.srem(KEYS.runningJobs, trackingMember);
      if (userJobsKey) {
        pipeline.srem(userJobsKey, trackingMember);
      }
      await pipeline.exec();
    }
    // End [knauf]
    logger.debug(`[RedisJobStore] Deleted job: ${streamId}`);
  }

  async hasJob(streamId: string, generationId?: string): Promise<boolean> {
    // [knauf] Preserve legacy existence checks; explicit owners require an exact match.
    if (generationId == null) {
      const exists = await this.redis.exists(KEYS.job(streamId));
      return exists === 1;
    }
    return (await this.redis.hget(KEYS.job(streamId), 'generationId')) === generationId;
    // End [knauf]
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    // [knauf] Running-set members identify an exact generation, with legacy bare-ID support.
    const trackedMembers = await this.redis.smembers(KEYS.runningJobs);
    if (trackedMembers.length === 0) {
      return [];
    }

    const jobs: SerializableJobData[] = [];
    for (const trackedMember of trackedMembers) {
      const ref = parseGenerationKey(trackedMember);
      const job = await this.getJob(ref.streamId);
      if (exactlyOwnsGeneration(job, ref.generationId) && job.status === 'running') {
        jobs.push(job);
      }
    }
    return jobs;
    // End [knauf]
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    // [knauf] Cleanup carries exact owners so stale set members cannot reap replacements.
    const trackedMembers = await this.redis.smembers(KEYS.runningJobs);
    let cleaned = 0;

    // Clean up stale local graph cache entries (WeakRefs that were collected)
    for (const [cacheKey, graphRef] of this.localGraphCache) {
      if (!graphRef.deref()) {
        this.localGraphCache.delete(cacheKey);
      }
    }

    // Process in batches of 50 to avoid sequential per-job round-trips
    const BATCH_SIZE = 50;
    for (let i = 0; i < trackedMembers.length; i += BATCH_SIZE) {
      const batch = trackedMembers.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (trackedMember) => {
          const ref = parseGenerationKey(trackedMember);
          const job = await this.getJob(ref.streamId);

          // Job no longer exists or this member belongs to an older generation.
          if (!exactlyOwnsGeneration(job, ref.generationId)) {
            await this.redis.srem(KEYS.runningJobs, trackedMember);
            this.localGraphCache.delete(trackedMember);
            this.localCollectedUsageCache.delete(trackedMember);
            return 1;
          }

          // Job completed but still in running set (shouldn't happen, but handle it)
          // Only remove from tracking sets — do NOT delete the job hash, which has
          // its own completedTtl so clients can still poll for final status.
          if (job.status !== 'running') {
            await this.redis.srem(KEYS.runningJobs, trackedMember);
            if (job.userId) {
              await this.redis.srem(KEYS.userJobs(job.userId, job.tenantId), trackedMember);
            }
            this.localGraphCache.delete(trackedMember);
            this.localCollectedUsageCache.delete(trackedMember);
            return 1;
          }

          // Stale running job (failsafe - running for > configured TTL)
          if (now - job.createdAt > this.ttl.running * 1000) {
            logger.warn(`[RedisJobStore] Cleaning up stale job: ${ref.streamId}`);
            await this.deleteJobInternal(job);
            return 1;
          }

          return 0;
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          cleaned += result.value;
        } else {
          logger.warn(`[RedisJobStore] Cleanup failed for a job:`, result.reason);
        }
      }
    }
    // End [knauf]

    if (cleaned > 0) {
      logger.debug(`[RedisJobStore] Cleaned up ${cleaned} jobs`);
    }

    return cleaned;
  }

  async getJobCount(): Promise<number> {
    // This is approximate - counts jobs in running set + scans for job keys
    // For exact count, would need to scan all job:* keys
    const runningCount = await this.redis.scard(KEYS.runningJobs);
    return runningCount;
  }

  async getJobCountByStatus(status: JobStatus): Promise<number> {
    if (status === 'running') {
      return this.redis.scard(KEYS.runningJobs);
    }

    // For other statuses, we'd need to scan - return 0 for now
    // In production, consider maintaining separate sets per status if needed
    return 0;
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    const userJobsKey = KEYS.userJobs(userId, tenantId);
    const trackedIds = await this.redis.smembers(userJobsKey);

    if (trackedIds.length === 0) {
      return [];
    }

    // [knauf] Return current generations once and self-heal exact stale members.
    const activeIds = new Set<string>();
    const staleIds: string[] = [];

    for (const trackedId of trackedIds) {
      const ref = parseGenerationKey(trackedId);
      const job = await this.getJob(ref.streamId);
      // Include running and terminal-but-unacknowledged owners so destructive
      // lifecycle cleanup cannot race a request that still has write-capable work.
      if (
        exactlyOwnsGeneration(job, ref.generationId) &&
        (job.status === 'running' || !job.terminalAcknowledged)
      ) {
        activeIds.add(ref.streamId);
      } else {
        // Self-healing: job completed/deleted but mapping wasn't cleaned - mark for removal
        staleIds.push(trackedId);
      }
    }

    if (staleIds.length > 0) {
      await this.redis.srem(userJobsKey, ...staleIds);
      logger.debug(
        `[RedisJobStore] Self-healed ${staleIds.length} stale job entries for user ${userId}`,
      );
    }

    return Array.from(activeIds);
    // End [knauf]
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Clear local caches
    this.localGraphCache.clear();
    this.localCollectedUsageCache.clear();
    // [knauf] Drop observed generation owners with the local caches.
    this.currentGenerationCache.clear();
    // End [knauf]
    // Don't close the Redis connection - it's shared
    logger.info('[RedisJobStore] Destroyed');
  }

  // ===== Content State Methods =====
  // For Redis, content is primarily reconstructed from chunks.
  // However, we keep a LOCAL graph cache for fast same-instance reconnects.

  /**
   * Store graph reference in local cache.
   * This enables fast reconnects when client returns to the same instance.
   * Falls back to Redis chunk reconstruction for cross-instance reconnects.
   *
   * @param streamId - The stream identifier
   * @param graph - The graph instance (stored as WeakRef)
   */
  setGraph(streamId: string, graph: StandardGraph, generationId?: string): void {
    // [knauf] A stale explicit owner cannot replace the current generation's graph cache.
    if (!this.cacheMatchesOwner(streamId, generationId)) {
      return;
    }
    this.localGraphCache.set(this.cacheKey(streamId, generationId), new WeakRef(graph));
    // End [knauf]
  }

  /**
   * No-op for Redis - content parts are reconstructed from chunks.
   * Metadata (agentId, groupId) is embedded directly on content parts by the agent runtime.
   */
  setContentParts(
    _streamId: string,
    _contentParts: Agents.MessageContentComplex[],
    _generationId?: string,
  ): void {
    // Content parts are reconstructed from chunks during getContentParts
    // No separate storage needed
  }

  /**
   * Store collectedUsage reference in local cache.
   * This is used for abort handling to spend tokens for all models.
   * Note: Only available on the generating instance; cross-replica abort uses fallback.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    generationId?: string,
  ): void {
    // [knauf] Usage caches are generation-scoped and stale explicit owners are ignored.
    if (!this.cacheMatchesOwner(streamId, generationId)) {
      return;
    }
    this.localCollectedUsageCache.set(this.cacheKey(streamId, generationId), collectedUsage);
    // End [knauf]
  }

  /**
   * Get collected usage for a job.
   * Only available if this is the generating instance.
   */
  getCollectedUsage(streamId: string, generationId?: string): UsageMetadata[] {
    // [knauf] Read only the requested/current generation cache.
    if (!this.cacheMatchesOwner(streamId, generationId)) {
      return [];
    }
    return this.localCollectedUsageCache.get(this.cacheKey(streamId, generationId)) ?? [];
    // End [knauf]
  }

  /**
   * Get aggregated content - tries local cache first, falls back to Redis reconstruction.
   *
   * Optimization: If this instance has the live graph (same-instance reconnect),
   * we return the content directly without Redis round-trip.
   * For cross-instance reconnects, we reconstruct from Redis Streams.
   *
   * @param streamId - The stream identifier
   * @returns Content parts array or null if not found
   */
  async getContentParts(
    streamId: string,
    generationId?: string,
  ): Promise<{
    content: Agents.MessageContentComplex[];
  } | null> {
    // [knauf] Resolve legacy callers to current content and reject stale explicit owners.
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return null;
    }
    const resolvedGenerationId = job.generationId;
    const localCacheKey = generationKey(streamId, resolvedGenerationId);
    // 1. Try local graph cache first (fast path for same-instance reconnect)
    const graphRef = this.localGraphCache.get(localCacheKey);
    if (graphRef) {
      const graph = graphRef.deref();
      if (graph) {
        const localParts = graph.getContentParts();
        if (localParts && localParts.length > 0) {
          return {
            content: localParts,
          };
        }
      } else {
        // WeakRef was collected, remove from cache
        this.localGraphCache.delete(localCacheKey);
      }
    }

    // 2. Fall back to Redis chunk reconstruction (cross-instance reconnect)
    const chunks = await this.getChunks(streamId, resolvedGenerationId);
    if (chunks.length === 0) {
      return null;
    }

    // Use the same content aggregator as live streaming
    const { contentParts, aggregateContent } = createContentAggregator();

    // Valid event types for content aggregation
    const validEvents = new Set([
      'on_run_step',
      'on_message_delta',
      'on_reasoning_delta',
      'on_run_step_delta',
      'on_run_step_completed',
      'on_agent_update',
    ]);

    for (const chunk of chunks) {
      const event = chunk as { event?: string; data?: unknown };
      if (!event.event || !event.data || !validEvents.has(event.event)) {
        continue;
      }

      // Pass event string directly - GraphEvents values are lowercase strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aggregateContent({ event: event.event as any, data: event.data as any });
    }

    // Filter out undefined entries
    const filtered: Agents.MessageContentComplex[] = [];
    for (const part of contentParts) {
      if (part !== undefined) {
        filtered.push(part);
      }
    }

    return {
      content: filtered,
    };
    // End [knauf]
  }

  /**
   * Get run steps - tries local cache first, falls back to Redis.
   *
   * Optimization: If this instance has the live graph, we get run steps
   * directly without Redis round-trip.
   *
   * @param streamId - The stream identifier
   * @returns Run steps array
   */
  async getRunSteps(streamId: string, generationId?: string): Promise<Agents.RunStep[]> {
    // [knauf] Resolve legacy callers to current steps and reject stale explicit owners.
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return [];
    }
    const resolvedGenerationId = job.generationId;
    const localCacheKey = generationKey(streamId, resolvedGenerationId);
    // 1. Try local graph cache first (fast path for same-instance reconnect)
    const graphRef = this.localGraphCache.get(localCacheKey);
    if (graphRef) {
      const graph = graphRef.deref();
      if (graph) {
        const localSteps = graph.getRunSteps();
        if (localSteps && localSteps.length > 0) {
          return localSteps;
        }
      }
      // Note: Don't delete from cache here - graph may still be valid
      // but just not have run steps yet
    }

    // 2. Fall back to Redis (cross-instance reconnect)
    const key = KEYS.runSteps(streamId, resolvedGenerationId);
    const data = await this.redis.get(key);
    if (!data) {
      return [];
    }
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
    // End [knauf]
  }

  /**
   * Clear content state for a job.
   * Removes both local cache and Redis data.
   */
  clearContentState(streamId: string, generationId?: string): void {
    // [knauf] Clear only the captured/current generation, never a replacement's keys.
    if (!this.cacheMatchesOwner(streamId, generationId)) {
      return;
    }
    const resolvedGenerationId = this.cachedGenerationId(streamId, generationId);
    const localCacheKey = generationKey(streamId, resolvedGenerationId);
    // Clear local caches immediately
    this.localGraphCache.delete(localCacheKey);
    this.localCollectedUsageCache.delete(localCacheKey);

    // Fire and forget - async cleanup for Redis
    this.clearContentStateAsync(streamId, resolvedGenerationId).catch((err) => {
      logger.error(`[RedisJobStore] Failed to clear content state for ${streamId}:`, err);
    });
    // End [knauf]
  }

  /**
   * Clear content state async.
   */
  private async clearContentStateAsync(streamId: string, generationId?: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(KEYS.chunks(streamId, generationId));
    pipeline.del(KEYS.runSteps(streamId, generationId));
    await pipeline.exec();
  }

  /**
   * Append a streaming chunk to Redis Stream.
   * Uses XADD for efficient append-only storage.
   * Sets TTL on first chunk to ensure cleanup if job crashes.
   */
  async appendChunk(streamId: string, event: unknown, generationId?: string): Promise<boolean> {
    // [knauf] Append and refresh TTL atomically only while this generation owns the job.
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return false;
    }
    const resolvedGenerationId = job.generationId;
    const appended = await this.redis.eval(
      APPEND_CHUNK_SCRIPT,
      2,
      KEYS.job(streamId),
      KEYS.chunks(streamId, resolvedGenerationId),
      '1',
      resolvedGenerationId ?? '',
      String(this.ttl.running),
      JSON.stringify(event),
    );
    return Number(appended) === 1;
    // End [knauf]
  }

  /**
   * Get all chunks from Redis Stream.
   */
  private async getChunks(streamId: string, generationId?: string): Promise<unknown[]> {
    const key = KEYS.chunks(streamId, generationId);
    const entries = await this.redis.xrange(key, '-', '+');

    return entries
      .map(([, fields]) => {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            return JSON.parse(fields[eventIdx + 1]);
          } catch {
            return null;
          }
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Save run steps for resume state.
   */
  async saveRunSteps(
    streamId: string,
    runSteps: Agents.RunStep[],
    generationId?: string,
  ): Promise<void> {
    // [knauf] Save steps only while this generation owns the job.
    const job = await this.getJob(streamId);
    if (!job || (generationId != null && job.generationId !== generationId)) {
      return;
    }
    const resolvedGenerationId = job.generationId;
    await this.redis.eval(
      SAVE_RUN_STEPS_SCRIPT,
      2,
      KEYS.job(streamId),
      KEYS.runSteps(streamId, resolvedGenerationId),
      '1',
      resolvedGenerationId ?? '',
      String(this.ttl.running),
      JSON.stringify(runSteps),
    );
    // End [knauf]
  }

  // ===== Consumer Group Methods =====
  // These enable tracking which chunks each client has seen.
  // Based on https://upstash.com/blog/resumable-llm-streams

  /**
   * Create a consumer group for a stream.
   * Used to track which chunks a client has already received.
   *
   * @param streamId - The stream identifier
   * @param groupName - Unique name for the consumer group (e.g., session ID)
   * @param startFrom - Where to start reading ('0' = from beginning, '$' = only new)
   */
  async createConsumerGroup(
    streamId: string,
    groupName: string,
    startFrom: '0' | '$' = '0',
    generationId?: string,
  ): Promise<void> {
    // [knauf] Consumer groups follow the generation-scoped chunk stream.
    const key = KEYS.chunks(streamId, this.cachedGenerationId(streamId, generationId));
    // End [knauf]
    try {
      await this.redis.xgroup('CREATE', key, groupName, startFrom, 'MKSTREAM');
      logger.debug(`[RedisJobStore] Created consumer group ${groupName} for ${streamId}`);
    } catch (err) {
      // BUSYGROUP error means group already exists - that's fine
      const error = err as Error;
      if (!error.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /**
   * Read chunks from a consumer group (only unseen chunks).
   * This is the key to the resumable stream pattern.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Name of the consumer within the group
   * @param count - Maximum number of chunks to read (default: all available)
   * @returns Array of { id, event } where id is the Redis stream entry ID
   */
  async readChunksFromGroup(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
    count?: number,
    generationId?: string,
  ): Promise<Array<{ id: string; event: unknown }>> {
    // [knauf] Consumer groups follow the generation-scoped chunk stream.
    const key = KEYS.chunks(streamId, this.cachedGenerationId(streamId, generationId));
    // End [knauf]

    try {
      // XREADGROUP GROUP groupName consumerName [COUNT count] STREAMS key >
      // The '>' means only read new messages not yet delivered to this consumer
      let result;
      if (count) {
        result = await this.redis.xreadgroup(
          'GROUP',
          groupName,
          consumerName,
          'COUNT',
          count,
          'STREAMS',
          key,
          '>',
        );
      } else {
        result = await this.redis.xreadgroup('GROUP', groupName, consumerName, 'STREAMS', key, '>');
      }

      if (!result || result.length === 0) {
        return [];
      }

      // Result format: [[streamKey, [[id, [field, value, ...]], ...]]]
      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch (err) {
      const error = err as Error;
      // NOGROUP error means the group doesn't exist yet
      if (error.message?.includes('NOGROUP')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Acknowledge that chunks have been processed.
   * This tells Redis we've successfully delivered these chunks to the client.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param messageIds - Array of Redis stream entry IDs to acknowledge
   */
  async acknowledgeChunks(
    streamId: string,
    groupName: string,
    messageIds: string[],
    generationId?: string,
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    // [knauf] Consumer groups follow the generation-scoped chunk stream.
    const key = KEYS.chunks(streamId, this.cachedGenerationId(streamId, generationId));
    // End [knauf]
    await this.redis.xack(key, groupName, ...messageIds);
  }

  /**
   * Delete a consumer group.
   * Called when a client disconnects and won't reconnect.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name to delete
   */
  async deleteConsumerGroup(
    streamId: string,
    groupName: string,
    generationId?: string,
  ): Promise<void> {
    // [knauf] Consumer groups follow the generation-scoped chunk stream.
    const key = KEYS.chunks(streamId, this.cachedGenerationId(streamId, generationId));
    // End [knauf]
    try {
      await this.redis.xgroup('DESTROY', key, groupName);
      logger.debug(`[RedisJobStore] Deleted consumer group ${groupName} for ${streamId}`);
    } catch {
      // Ignore errors - group may not exist
    }
  }

  /**
   * Get pending chunks for a consumer (chunks delivered but not acknowledged).
   * Useful for recovering from crashes.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Consumer name
   */
  async getPendingChunks(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
    generationId?: string,
  ): Promise<Array<{ id: string; event: unknown }>> {
    // [knauf] Consumer groups follow the generation-scoped chunk stream.
    const key = KEYS.chunks(streamId, this.cachedGenerationId(streamId, generationId));
    // End [knauf]

    try {
      // Read pending messages (delivered but not acked) by using '0' instead of '>'
      const result = await this.redis.xreadgroup(
        'GROUP',
        groupName,
        consumerName,
        'STREAMS',
        key,
        '0',
      );

      if (!result || result.length === 0) {
        return [];
      }

      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch {
      return [];
    }
  }

  /**
   * Serialize job data for Redis hash storage.
   * Converts complex types to strings.
   */
  private serializeJob(job: Partial<SerializableJobData>): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(job)) {
      if (value === undefined) {
        continue;
      }

      if (typeof value === 'object') {
        result[key] = JSON.stringify(value);
      } else if (typeof value === 'boolean') {
        result[key] = value ? '1' : '0';
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  /**
   * Deserialize job data from Redis hash.
   */
  private deserializeJob(data: Record<string, string>): SerializableJobData {
    return {
      streamId: data.streamId,
      // [knauf] Legacy Redis hashes deserialize without an owner token.
      generationId: data.generationId || undefined,
      // End [knauf]
      userId: data.userId,
      tenantId: data.tenantId || undefined,
      status: data.status as JobStatus,
      createdAt: parseInt(data.createdAt, 10),
      completedAt: data.completedAt ? parseInt(data.completedAt, 10) : undefined,
      conversationId: data.conversationId || undefined,
      error: data.error || undefined,
      terminalId: data.terminalId || undefined,
      terminalAcknowledged: data.terminalAcknowledged === '1',
      userMessage: data.userMessage ? JSON.parse(data.userMessage) : undefined,
      responseMessageId: data.responseMessageId || undefined,
      createdEventEmitted: data.createdEventEmitted === '1',
      sender: data.sender || undefined,
      syncSent: data.syncSent === '1',
      finalEvent: data.finalEvent || undefined,
      endpoint: data.endpoint || undefined,
      iconURL: data.iconURL || undefined,
      model: data.model || undefined,
      promptTokens: data.promptTokens ? parseInt(data.promptTokens, 10) : undefined,
      titleEvent: data.titleEvent || undefined,
      replayEvents: data.replayEvents || undefined,
      contextUsage: data.contextUsage || undefined,
      tokenUsage: data.tokenUsage || undefined,
    };
  }
}

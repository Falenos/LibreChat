// [knauf] Generate immutable turn ownership without adding a dependency.
import { randomUUID } from 'node:crypto';
// End [knauf]
import { logger } from '@librechat/data-schemas';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import {
  GenerationConflictError,
  type GenerationRef,
  type SerializableJobData,
  type UsageMetadata,
  type IJobStore,
  type JobStatus,
  type TerminalJobStatus,
} from '~/stream/interfaces/IJobStore';

// [knauf] Encode active-set/cache members with their owner while accepting legacy bare IDs.
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

function ownsGeneration(
  job: SerializableJobData | undefined,
  generationId?: string,
): job is SerializableJobData {
  return job != null && (generationId == null || job.generationId === generationId);
}

function exactlyOwnsGeneration(
  job: SerializableJobData | undefined,
  generationId?: string,
): job is SerializableJobData {
  return job != null && job.generationId === generationId;
}
// End [knauf]

/**
 * Content state for a job - volatile, in-memory only.
 * Uses WeakRef to allow garbage collection of graph when no longer needed.
 */
interface ContentState {
  contentParts: Agents.MessageContentComplex[];
  graphRef: WeakRef<StandardGraph> | null;
  collectedUsage: UsageMetadata[];
}

/**
 * In-memory implementation of IJobStore.
 * Suitable for single-instance deployments.
 * For horizontal scaling, use RedisJobStore.
 *
 * Content state is tied to jobs:
 * - Uses WeakRef to graph for live access to contentParts and contentData (run steps)
 * - No chunk persistence needed - same instance handles generation and reconnects
 */
export class InMemoryJobStore implements IJobStore {
  private jobs = new Map<string, SerializableJobData>();
  private contentState = new Map<string, ContentState>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Maps userId -> Set of streamIds (conversationIds) for active jobs */
  private userJobMap = new Map<string, Set<string>>();

  /**
   * Maps streamId -> last generation-activity timestamp. Refreshed via
   * recordActivity() on each emitted chunk so the stale-job failsafe reaps on
   * inactivity (a hung generation) rather than age (a long but live stream).
   */
  private lastActivity = new Map<string, number>();
  // [knauf] Deduplicate post-transition metrics without guarding job correctness.
  private terminalEffects = new Set<string>();
  // End [knauf]

  /** Time to keep completed jobs before cleanup (0 = immediate) */
  private ttlAfterComplete = 0;

  /** Maximum number of concurrent jobs */
  private maxJobs = 1000;

  /**
   * Failsafe timeout (ms) for jobs stuck in "running" status. Mirrors
   * RedisJobStore's running-job TTL: a crashed or hung generation that never
   * reaches a terminal state would otherwise retain its content state forever,
   * leaking the full message context until the process runs out of memory.
   * 0 disables the failsafe. Default: 20 minutes.
   */
  private staleJobTimeout = 1_200_000;

  // [knauf] Resolve legacy calls to the current owner and remove only exact tracking members.
  private resolveGenerationId(streamId: string, generationId?: string): string | undefined {
    return generationId ?? this.jobs.get(streamId)?.generationId;
  }

  private removeUserTracking(job: SerializableJobData): void {
    const userKey = job.tenantId ? `${job.tenantId}:${job.userId}` : job.userId;
    const userJobs = this.userJobMap.get(userKey);
    if (!userJobs) {
      return;
    }

    userJobs.delete(generationKey(job.streamId, job.generationId));
    if (userJobs.size === 0) {
      this.userJobMap.delete(userKey);
    }
  }
  // End [knauf]

  constructor(options?: { ttlAfterComplete?: number; maxJobs?: number; staleJobTimeout?: number }) {
    if (options?.ttlAfterComplete) {
      this.ttlAfterComplete = options.ttlAfterComplete;
    }
    if (options?.maxJobs) {
      this.maxJobs = options.maxJobs;
    }
    if (options?.staleJobTimeout !== undefined) {
      this.staleJobTimeout = options.staleJobTimeout;
    }
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[InMemoryJobStore] Initialized with cleanup interval');
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    generationId: string = randomUUID(),
  ): Promise<SerializableJobData> {
    // [knauf] A conversation has one active owner; terminal/legacy state may be replaced.
    const existingJob = this.jobs.get(streamId);
    if (existingJob?.status === 'running') {
      throw new GenerationConflictError(streamId);
    }

    if (!existingJob && this.jobs.size >= this.maxJobs) {
      await this.evictOldest();
    }

    if (existingJob) {
      this.removeUserTracking(existingJob);
      this.contentState.delete(generationKey(streamId, existingJob.generationId));
      this.lastActivity.delete(generationKey(streamId, existingJob.generationId));
    }

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

    this.jobs.set(streamId, job);

    // Track job by userId (tenant-qualified when available) for efficient user-scoped queries
    const userKey = tenantId ? `${tenantId}:${userId}` : userId;
    let userJobs = this.userJobMap.get(userKey);
    if (!userJobs) {
      userJobs = new Set();
      this.userJobMap.set(userKey, userJobs);
    }
    userJobs.add(generationKey(streamId, generationId));
    // End [knauf]

    logger.debug(`[InMemoryJobStore] Created job: ${streamId}`);

    return job;
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    return this.jobs.get(streamId) ?? null;
  }

  async updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    generationId?: string,
  ): Promise<void> {
    const job = this.jobs.get(streamId);
    // [knauf] Stale owners cannot mutate the current job or its immutable owner token.
    if (!ownsGeneration(job, generationId)) {
      return;
    }

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
    if (job.status !== 'running') {
      return;
    }
    Object.assign(job, safeUpdates);
    // End [knauf]
  }

  // [knauf] KK20-338 — single-threaded CAS mirrors the Redis transition script.
  async transitionToTerminal(
    streamId: string,
    updates: Partial<SerializableJobData> & {
      status: TerminalJobStatus;
      completedAt: number;
      terminalId: string;
    },
    generationId?: string,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId) || job.status !== 'running') {
      return false;
    }

    const safeUpdates = { ...updates };
    delete safeUpdates.generationId;
    Object.assign(job, safeUpdates);
    return true;
  }
  // End [knauf]

  // [knauf] KK20-338 — claim effects only for the exact committed terminal token.
  async claimTerminalEffects(
    streamId: string,
    terminalId: string,
    generationId?: string,
  ): Promise<boolean> {
    const job = this.jobs.get(streamId);
    if (
      !ownsGeneration(job, generationId) ||
      job.status === 'running' ||
      job.terminalId !== terminalId
    ) {
      return false;
    }
    const key = generationKey(streamId, job.generationId);
    if (this.terminalEffects.has(key)) {
      return false;
    }
    this.terminalEffects.add(key);
    return true;
  }
  // End [knauf]

  // [knauf] KK20-338 — durable acknowledgement used by destructive lifecycle work.
  async acknowledgeTerminal(streamId: string, generationId?: string): Promise<void> {
    const job = this.jobs.get(streamId);
    if (ownsGeneration(job, generationId) && job.status !== 'running') {
      job.terminalAcknowledged = true;
      this.removeUserTracking(job);
    }
  }
  // End [knauf]

  async deleteJob(streamId: string, generationId?: string): Promise<void> {
    // [knauf] Delete only the owner captured by the caller.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return;
    }

    const stateKey = generationKey(streamId, job.generationId);
    this.removeUserTracking(job);
    this.jobs.delete(streamId);
    this.contentState.delete(stateKey);
    this.lastActivity.delete(stateKey);
    this.terminalEffects.delete(stateKey);
    // End [knauf]
    logger.debug(`[InMemoryJobStore] Deleted job: ${streamId}`);
  }

  /**
   * Refresh a job's last-activity timestamp (called on each emitted chunk) so the
   * stale-job failsafe in cleanup() reaps on inactivity rather than total age,
   * mirroring RedisJobStore refreshing the running TTL on each appendChunk.
   */
  recordActivity(streamId: string, generationId?: string): void {
    // [knauf] Refresh activity only for the generation that still owns the job.
    const job = this.jobs.get(streamId);
    if (ownsGeneration(job, generationId)) {
      this.lastActivity.set(generationKey(streamId, job.generationId), Date.now());
    }
    // End [knauf]
  }

  async hasJob(streamId: string, generationId?: string): Promise<boolean> {
    // [knauf] Optional owner check preserves the legacy existence-only API.
    return ownsGeneration(this.jobs.get(streamId), generationId);
    // End [knauf]
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    const running: SerializableJobData[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        running.push(job);
      }
    }
    return running;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    // [knauf] Cleanup carries the observed owner through deletion.
    const toDelete: GenerationRef[] = [];
    let staleRunning = 0;

    for (const [streamId, job] of this.jobs) {
      const isFinished = ['complete', 'error', 'aborted'].includes(job.status);
      if (isFinished && job.completedAt) {
        // TTL of 0 means immediate cleanup, otherwise wait for TTL to expire
        if (this.ttlAfterComplete === 0 || now - job.completedAt > this.ttlAfterComplete) {
          toDelete.push({ streamId, generationId: job.generationId });
        }
      } else if (this.staleJobTimeout > 0 && job.status === 'running') {
        // Failsafe: reap jobs stuck in "running" with no generation activity for
        // longer than the stale timeout. These are crashed/hung generations that
        // never reached a terminal state; without this they accumulate their
        // content state in memory until the process OOMs. Reaping keys off last
        // activity (not creation time) so a long but live stream is never reaped,
        // mirroring RedisJobStore refreshing the running TTL on each chunk.
        const lastActive =
          this.lastActivity.get(generationKey(streamId, job.generationId)) ?? job.createdAt;
        if (now - lastActive > this.staleJobTimeout) {
          toDelete.push({ streamId, generationId: job.generationId });
          staleRunning++;
        }
      }
    }

    for (const ref of toDelete) {
      await this.deleteJob(ref.streamId, ref.generationId);
    }
    // End [knauf]

    if (staleRunning > 0) {
      logger.warn(
        `[InMemoryJobStore] Reaped ${staleRunning} stale running job(s) exceeding ${this.staleJobTimeout}ms (likely crashed/hung generations)`,
      );
    }

    if (toDelete.length > 0) {
      logger.debug(`[InMemoryJobStore] Cleaned up ${toDelete.length} expired jobs`);
    }

    return toDelete.length;
  }

  private async evictOldest(): Promise<void> {
    // [knauf] Eviction deletes the owner that was selected, not a later replacement.
    let oldestRef: GenerationRef | null = null;
    let oldestTime = Infinity;

    for (const [streamId, job] of this.jobs) {
      if (job.createdAt < oldestTime) {
        oldestTime = job.createdAt;
        oldestRef = { streamId, generationId: job.generationId };
      }
    }

    if (oldestRef) {
      logger.warn(`[InMemoryJobStore] Evicting oldest job: ${oldestRef.streamId}`);
      await this.deleteJob(oldestRef.streamId, oldestRef.generationId);
    }
    // End [knauf]
  }

  /** Get job count (for monitoring) */
  async getJobCount(): Promise<number> {
    return this.jobs.size;
  }

  /** Get job count by status (for monitoring) */
  async getJobCountByStatus(status: JobStatus): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === status) {
        count++;
      }
    }
    return count;
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.jobs.clear();
    this.contentState.clear();
    this.userJobMap.clear();
    // [knauf] Activity is generation-scoped state too.
    this.lastActivity.clear();
    this.terminalEffects.clear();
    // End [knauf]
    logger.debug('[InMemoryJobStore] Destroyed');
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   */
  async getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    const userKey = tenantId ? `${tenantId}:${userId}` : userId;
    const trackedIds = this.userJobMap.get(userKey);
    if (!trackedIds || trackedIds.size === 0) {
      return [];
    }

    // [knauf] Ignore stale members from prior generations and return each conversation once.
    const activeIds = new Set<string>();

    for (const trackedId of trackedIds) {
      const ref = parseGenerationKey(trackedId);
      const job = this.jobs.get(ref.streamId);
      // Only include if job exists AND is still running
      if (
        exactlyOwnsGeneration(job, ref.generationId) &&
        (job.status === 'running' || !job.terminalAcknowledged)
      ) {
        activeIds.add(ref.streamId);
      } else {
        // Self-healing: job completed/deleted but mapping wasn't cleaned - fix it now
        trackedIds.delete(trackedId);
      }
    }

    // Clean up empty set
    if (trackedIds.size === 0) {
      this.userJobMap.delete(userKey);
    }

    return Array.from(activeIds);
    // End [knauf]
  }

  // ===== Content State Methods =====

  /**
   * Set the graph reference for a job.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  setGraph(streamId: string, graph: StandardGraph, generationId?: string): void {
    // [knauf] Content state belongs to the current generation only.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return;
    }
    const stateKey = generationKey(streamId, job.generationId);
    const existing = this.contentState.get(stateKey);
    if (existing) {
      existing.graphRef = new WeakRef(graph);
    } else {
      this.contentState.set(stateKey, {
        contentParts: [],
        graphRef: new WeakRef(graph),
        collectedUsage: [],
      });
    }
    // End [knauf]
  }

  /**
   * Set content parts reference for a job.
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    generationId?: string,
  ): void {
    // [knauf] Content state belongs to the current generation only.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return;
    }
    const stateKey = generationKey(streamId, job.generationId);
    const existing = this.contentState.get(stateKey);
    if (existing) {
      existing.contentParts = contentParts;
    } else {
      this.contentState.set(stateKey, { contentParts, graphRef: null, collectedUsage: [] });
    }
    // End [knauf]
  }

  /**
   * Set collected usage reference for a job.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    generationId?: string,
  ): void {
    // [knauf] Usage belongs to the current generation only.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return;
    }
    const stateKey = generationKey(streamId, job.generationId);
    const existing = this.contentState.get(stateKey);
    if (existing) {
      existing.collectedUsage = collectedUsage;
    } else {
      this.contentState.set(stateKey, { contentParts: [], graphRef: null, collectedUsage });
    }
    // End [knauf]
  }

  /**
   * Get collected usage for a job.
   */
  getCollectedUsage(streamId: string, generationId?: string): UsageMetadata[] {
    // [knauf] Reject stale reads and resolve legacy callers to the current owner.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return [];
    }
    const state = this.contentState.get(
      generationKey(streamId, this.resolveGenerationId(streamId, generationId)),
    );
    return state?.collectedUsage ?? [];
    // End [knauf]
  }

  /**
   * Get content parts for a job.
   * Returns live content from stored reference.
   */
  async getContentParts(
    streamId: string,
    generationId?: string,
  ): Promise<{
    content: Agents.MessageContentComplex[];
  } | null> {
    // [knauf] Reject stale reads and resolve legacy callers to the current owner.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return null;
    }
    const state = this.contentState.get(
      generationKey(streamId, this.resolveGenerationId(streamId, generationId)),
    );
    if (!state?.contentParts) {
      return null;
    }
    return {
      content: state.contentParts,
    };
    // End [knauf]
  }

  /**
   * Get run steps for a job from graph.contentData.
   * Uses WeakRef - may return empty if graph has been GC'd.
   */
  async getRunSteps(streamId: string, generationId?: string): Promise<Agents.RunStep[]> {
    // [knauf] Reject stale reads and resolve legacy callers to the current owner.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return [];
    }
    const state = this.contentState.get(
      generationKey(streamId, this.resolveGenerationId(streamId, generationId)),
    );
    if (!state?.graphRef) {
      return [];
    }

    // Dereference WeakRef - may return undefined if GC'd
    const graph = state.graphRef.deref();
    return graph?.contentData ?? [];
    // End [knauf]
  }

  /**
   * No-op for in-memory - content available via graph reference.
   */
  async appendChunk(streamId: string, _event: unknown, generationId?: string): Promise<boolean> {
    const job = this.jobs.get(streamId);
    return ownsGeneration(job, generationId) && job.status === 'running';
  }

  /**
   * Clear content state for a job.
   */
  clearContentState(streamId: string, generationId?: string): void {
    // [knauf] Clear only the captured generation; omitted IDs retain legacy current behavior.
    const job = this.jobs.get(streamId);
    if (!ownsGeneration(job, generationId)) {
      return;
    }
    this.contentState.delete(
      generationKey(streamId, this.resolveGenerationId(streamId, generationId)),
    );
    // End [knauf]
  }
}

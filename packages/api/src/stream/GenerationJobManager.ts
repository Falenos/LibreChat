// [knauf] Standard-library generation identity/context fences stale asynchronous callbacks.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
// End [knauf]
import { logger, getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import {
  Constants,
  UsageEvents,
  parseTextParts,
  reconcileContextUsage,
  promptTokensFromUsage,
} from 'librechat-data-provider';
import type {
  TMessageContentParts,
  TContextUsageEvent,
  TTokenUsageEvent,
  Agents,
} from 'librechat-data-provider';
import type { StandardGraph } from '@librechat/agents';
import type {
  SerializableJobData,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  IJobStore,
  GenerationRef,
  TerminalJobStatus,
} from './interfaces/IJobStore';
// [knauf] NO-TICKET — bounded generation metric failure classes.
import type { GenerationJobReason, GenerationJobStore } from '~/app/metrics';
// End [knauf]
import type * as t from '~/types';
import {
  recordGenerationStreamResumePendingEvents,
  recordGenerationStreamSubscription,
  setGenerationJobsInFlight,
  recordGenerationJob,
} from '~/app/metrics';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';
import { filterPersistableAbortContent } from './abortContent';

/** Error surfaced to any client still attached when a stale/hung job is reaped. */
const REAPED_JOB_ERROR = 'Generation timed out';
const OAUTH_TOOL_CALL_PREFIX = `oauth${Constants.mcp_delimiter}`;

// [knauf] NO-TICKET — keep generation metric tags bounded and actionable.
function getGenerationJobFailureReason(error: string): GenerationJobReason {
  if (
    error === 'provider_bad_request' ||
    error === 'provider_request_failed' ||
    error === 'attachment_unavailable'
  ) {
    return error;
  }
  return error === REAPED_JOB_ERROR ? 'generation_timeout' : 'unknown';
}
// End [knauf]

// [knauf] KK20-338 — one privacy-safe, deduplicated terminal-cause log per logical
// call so KK20-324 dashboards can map an HTTP 408/499 to a supported initiating
// layer instead of raw, possibly-duplicated cancellation callbacks. Only bounded
// IDs and enum-like reasons are logged, never message content or provider payloads.
type GenerationTerminalCause = 'completed' | 'user_abort' | 'system_abort' | GenerationJobReason;

function logGenerationTerminalCause(
  store: GenerationJobStore,
  streamId: string,
  generationId: string | undefined,
  cause: GenerationTerminalCause,
): void {
  logger.info('[GenerationJobManager] Generation terminal', {
    streamId,
    generationId,
    store,
    cause,
  });
}
// End [knauf]

function getToolCallName(toolCall: unknown): unknown {
  return toolCall != null && typeof toolCall === 'object' && 'name' in toolCall
    ? toolCall.name
    : undefined;
}

function hasOAuthToolCall(toolCalls: unknown): boolean {
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((toolCall) => {
      const name = getToolCallName(toolCall);
      return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
    })
  );
}

function getReplayStepId(event: t.ServerSentEvent): unknown {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return undefined;
  }

  if (event.event === 'on_run_step' || event.event === 'on_run_step_delta') {
    return 'id' in event.data ? event.data.id : undefined;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    return result != null && typeof result === 'object' && 'id' in result ? result.id : undefined;
  }

  return undefined;
}

function isOAuthReplayEvent(event: t.ServerSentEvent): boolean {
  if (!('event' in event) || !event.data || typeof event.data !== 'object') {
    return false;
  }

  if (event.event === 'on_run_step') {
    const stepDetails = 'stepDetails' in event.data ? event.data.stepDetails : undefined;
    return (
      stepDetails != null &&
      typeof stepDetails === 'object' &&
      'tool_calls' in stepDetails &&
      hasOAuthToolCall(stepDetails.tool_calls)
    );
  }

  if (event.event === 'on_run_step_delta') {
    const delta = 'delta' in event.data ? event.data.delta : undefined;
    if (delta == null || typeof delta !== 'object') {
      return false;
    }
    if (!('tool_calls' in delta) || !hasOAuthToolCall(delta.tool_calls)) {
      return false;
    }

    return true;
  }

  if (event.event === 'on_run_step_completed') {
    const result = 'result' in event.data ? event.data.result : undefined;
    if (result == null || typeof result !== 'object' || !('tool_call' in result)) {
      return false;
    }
    const name = getToolCallName(result.tool_call);
    return typeof name === 'string' && name.startsWith(OAUTH_TOOL_CALL_PREFIX);
  }

  return false;
}

/**
 * Configuration options for GenerationJobManager
 */
export interface GenerationJobManagerOptions {
  jobStore?: IJobStore;
  eventTransport?: IEventTransport;
  /**
   * If true, cleans up event transport immediately when job completes.
   * If false, keeps EventEmitters until periodic cleanup for late reconnections.
   * Default: true (immediate cleanup to save memory)
   */
  cleanupOnComplete?: boolean;
}

/**
 * Runtime state for active jobs - not serializable, kept in-memory per instance.
 * Contains AbortController, ready promise, and other non-serializable state.
 *
 * @property abortController - Controller to abort the generation
 * @property readyPromise - Resolves immediately (legacy, kept for API compatibility)
 * @property resolveReady - Function to resolve readyPromise
 * @property finalEvent - Cached final event for late subscribers
 * @property errorEvent - Cached error event for late subscribers (errors before client connects)
 * @property syncSent - Whether sync event was sent (reset when all subscribers leave)
 * @property earlyEventBuffer - Buffer for events emitted before first subscriber connects
 * @property hasSubscriber - Whether at least one subscriber has connected
 * @property allSubscribersLeftHandlers - Internal handlers for disconnect events.
 *   These are stored separately from eventTransport subscribers to avoid being counted
 *   in subscriber count. This is critical: if these were registered via subscribe(),
 *   they would count as subscribers, causing isFirstSubscriber() to return false
 *   when the real client connects, which would prevent readyPromise from resolving.
 */
interface RuntimeJobState {
  // [knauf] Bind every local callback and terminal action to one immutable turn.
  generationId?: string;
  terminal: boolean;
  completionRecorded: boolean;
  terminalTransition?: { status: TerminalJobStatus; terminalId: string };
  // End [knauf]
  abortController: AbortController;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  finalEvent?: t.ServerSentEvent;
  errorEvent?: string;
  syncSent: boolean;
  earlyEventBuffer: t.ServerSentEvent[];
  hasSubscriber: boolean;
  allSubscribersLeftHandlers?: Array<(...args: unknown[]) => void>;
}

/**
 * Manages generation jobs for resumable LLM streams.
 *
 * Architecture: Composes two pluggable services via dependency injection:
 * - jobStore: Job metadata + content state (InMemory → Redis for horizontal scaling)
 * - eventTransport: Pub/sub events (InMemory → Redis Pub/Sub for horizontal scaling)
 *
 * Content state is tied to jobs:
 * - In-memory: jobStore holds WeakRef to graph for live content/run steps access
 * - Redis: jobStore persists chunks, reconstructs content on demand
 *
 * All storage methods are async to support both in-memory and external stores (Redis, etc.).
 *
 * @example Redis injection:
 * ```ts
 * const manager = new GenerationJobManagerClass({
 *   jobStore: new RedisJobStore(redisClient),
 *   eventTransport: new RedisPubSubTransport(redisClient),
 * });
 * ```
 */
class GenerationJobManagerClass {
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private jobStore: IJobStore;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private eventTransport: IEventTransport;

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  // [knauf] Preserve generation ownership through downstream tool/model callbacks without
  // changing every upstream emitChunk(streamId, ...) call site.
  private generationContext = new AsyncLocalStorage<GenerationRef>();
  // End [knauf]

  /** Jobs actively generating in this process. */
  private runningJobs = new Set<string>();

  /** Serializes replay-event read/modify/write updates per stream. */
  private replayEventWriteQueues = new Map<string, Promise<void>>();

  /** Serializes token-usage read/modify/write updates per stream. */
  private tokenUsageWriteQueues = new Map<string, Promise<void>>();

  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;

  constructor(options?: GenerationJobManagerOptions) {
    this.jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    this.eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }

  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  initialize(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.jobStore.initialize();

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[GenerationJobManager] Initialized');
  }

  /**
   * Configure the manager with custom stores.
   * Call this BEFORE initialize() to use Redis or other stores.
   *
   * @example Using Redis
   * ```ts
   * import { createStreamServicesFromCache } from '~/stream/createStreamServices';
   * import { cacheConfig, ioredisClient } from '~/cache';
   *
   * const services = createStreamServicesFromCache({ cacheConfig, ioredisClient });
   * GenerationJobManager.configure(services);
   * GenerationJobManager.initialize();
   * ```
   */
  configure(services: {
    jobStore: IJobStore;
    eventTransport: IEventTransport;
    isRedis?: boolean;
    cleanupOnComplete?: boolean;
  }): void {
    const previousStore = this.storeLabel;
    if (this.cleanupInterval) {
      logger.warn(
        '[GenerationJobManager] Reconfiguring after initialization - destroying existing services',
      );
      this.destroy();
    }

    this.runningJobs.clear();
    setGenerationJobsInFlight(previousStore, 0);

    this.jobStore = services.jobStore;
    this.eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.syncRunningJobMetrics();

    logger.info(
      `[GenerationJobManager] Configured with ${this._isRedis ? 'Redis' : 'in-memory'} stores`,
    );
  }

  /**
   * Check if using Redis stores.
   */
  get isRedis(): boolean {
    return this._isRedis;
  }

  private get storeLabel(): GenerationJobStore {
    return this._isRedis ? 'redis' : 'memory';
  }

  private syncRunningJobMetrics(store: GenerationJobStore = this.storeLabel): void {
    setGenerationJobsInFlight(store, this.runningJobs.size);
  }

  // [knauf] Resolve bare upstream stream calls against the generation that created them.
  runWithGeneration<T>(streamId: string, generationId: string | undefined, callback: () => T): T {
    return this.generationContext.run({ streamId, generationId }, callback);
  }

  private resolveGenerationId(streamId: string, generationId?: string): string | undefined {
    if (generationId != null) {
      return generationId;
    }
    const context = this.generationContext.getStore();
    if (context?.streamId === streamId) {
      return context.generationId;
    }
    return this.runtimeState.get(streamId)?.generationId;
  }

  private getRuntimeState(streamId: string, generationId?: string): RuntimeJobState | undefined {
    const runtime = this.runtimeState.get(streamId);
    const resolvedGenerationId = this.resolveGenerationId(streamId, generationId);
    return runtime?.generationId === resolvedGenerationId ? runtime : undefined;
  }

  private generationKey(streamId: string, generationId?: string): string {
    return generationId == null ? streamId : `${streamId}:${generationId}`;
  }

  // [knauf] KK20-338 — commit ownership, status and payload together. The caller
  // token resolves the only ambiguous Redis case: the script committed but the
  // connection dropped before its reply reached this process.
  private async transitionToTerminal(
    streamId: string,
    status: TerminalJobStatus,
    updates: Partial<SerializableJobData>,
    generationId?: string,
  ): Promise<{ won: boolean; terminalId: string }> {
    const terminalId = randomUUID();
    if (!this.jobStore.transitionToTerminal) {
      const current = await this.jobStore.getJob(streamId);
      if (!current || current.generationId !== generationId || current.status !== 'running') {
        return { won: false, terminalId };
      }
      await this.jobStore.updateJob(
        streamId,
        { ...updates, status, completedAt: Date.now(), terminalId },
        generationId,
      );
      const persisted = await this.jobStore.getJob(streamId);
      return { won: persisted?.terminalId === terminalId, terminalId };
    }
    try {
      const won = await this.jobStore.transitionToTerminal(
        streamId,
        { ...updates, status, completedAt: Date.now(), terminalId },
        generationId,
      );
      return { won, terminalId };
    } catch (transitionError) {
      let persisted: SerializableJobData | null;
      try {
        persisted = await this.jobStore.getJob(streamId);
      } catch {
        throw transitionError;
      }
      if (
        persisted != null &&
        persisted.generationId === generationId &&
        persisted.terminalId === terminalId
      ) {
        return { won: true, terminalId };
      }
      if (!persisted) {
        return { won: false, terminalId };
      }
      if (persisted.generationId !== generationId || persisted.status !== 'running') {
        return { won: false, terminalId };
      }
      throw transitionError;
    }
  }
  // End [knauf]

  // [knauf] KK20-338 — post-commit telemetry failure must never turn a durable
  // terminal result back into an application error or a retryable transition.
  private async claimTerminalEffectsOnce(
    streamId: string,
    terminalId: string,
    generationId?: string,
  ): Promise<boolean> {
    if (!this.jobStore.claimTerminalEffects) {
      return true;
    }
    try {
      return await this.jobStore.claimTerminalEffects(streamId, terminalId, generationId);
    } catch (error) {
      logger.error('[GenerationJobManager] Terminal state committed but effects claim failed', {
        streamId,
        generationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
  // End [knauf]

  // [knauf] KK20-338 — acknowledge durable cancellation only after this worker
  // has stopped its local generation path.
  async acknowledgeTerminal(streamId: string, generationId?: string): Promise<void> {
    if (!this.jobStore.acknowledgeTerminal) {
      return;
    }
    await this.jobStore.acknowledgeTerminal(streamId, generationId);
  }

  private async waitForTerminalAcknowledgement(
    streamId: string,
    generationId?: string,
    timeoutMs = 5000,
  ): Promise<void> {
    if (!this.jobStore.acknowledgeTerminal) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.jobStore.getJob(streamId);
      if (
        job != null &&
        job.generationId === generationId &&
        job.status !== 'running' &&
        job.terminalAcknowledged
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for generation ${generationId ?? streamId} to stop`);
  }
  // End [knauf]

  /**
   * Get the job store instance (for advanced use cases).
   */
  getJobStore(): IJobStore {
    return this.jobStore;
  }

  /**
   * Create a new generation job.
   *
   * This sets up:
   * 1. Serializable job data in the job store
   * 2. Runtime state including readyPromise (resolves when first SSE client connects)
   * 3. allSubscribersLeft callback for handling client disconnections
   *
   * The readyPromise mechanism ensures generation doesn't start before the client
   * is ready to receive events. The controller awaits this promise (with a short timeout)
   * before starting LLM generation.
   *
   * @param streamId - Unique identifier for this stream
   * @param userId - User who initiated the request
   * @param conversationId - Optional conversation ID for lookup
   * @returns A facade object for the GenerationJob
   */
  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
  ): Promise<t.GenerationJob> {
    const tenantId = getTenantId();
    const safeTenantId = tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
    // [knauf] Atomically claim a UUID owner; no shared sequence reset is needed.
    const generationId = randomUUID();
    const jobData = await this.jobStore.createJob(
      streamId,
      userId,
      conversationId,
      safeTenantId,
      generationId,
    );
    const previousRuntime = this.runtimeState.get(streamId);
    if (previousRuntime && previousRuntime.generationId !== jobData.generationId) {
      previousRuntime.terminal = true;
      previousRuntime.abortController.abort();
    }
    // End [knauf]

    /**
     * Create runtime state with readyPromise.
     *
     * With the resumable stream architecture, we no longer need to wait for the
     * first subscriber before starting generation:
     * - Redis mode: Events are persisted and can be replayed via sync
     * - In-memory mode: Content is aggregated and sent via sync on connect
     *
     * We resolve readyPromise immediately to eliminate startup latency.
     * The sync mechanism handles late-connecting clients.
     */
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const runtime: RuntimeJobState = {
      generationId: jobData.generationId,
      terminal: false,
      completionRecorded: false,
      abortController: new AbortController(),
      readyPromise,
      resolveReady: resolveReady!,
      syncSent: false,
      earlyEventBuffer: [],
      hasSubscriber: false,
    };
    this.runtimeState.set(streamId, runtime);
    this.runningJobs.add(streamId);
    this.syncRunningJobMetrics();
    recordGenerationJob(this.storeLabel, 'created');

    // Resolve immediately - early event buffer handles late subscribers
    resolveReady!();

    /**
     * Set up all-subscribers-left callback.
     * When all SSE clients disconnect, this:
     * 1. Resets syncSent so reconnecting clients get sync event (persisted to Redis)
     * 2. Calls any registered allSubscribersLeft handlers (e.g., to save partial responses)
     */
    // [knauf] These are two signals, not one. The reconnect reset is per-replica and must fire
    // the instant THIS replica's last viewer leaves — a browser reconnects faster than a Redis
    // round-trip, and a late reset skips syncReorderBuffer and loses chunks. The partial save must
    // wait until NO replica has a viewer, or a second tab elsewhere gets a premature snapshot,
    // and it must run HERE because the handlers live in this process. So: local signal for the
    // reset, verified global signal for the save.
    this.eventTransport.onAllSubscribersLeft(
      streamId,
      () => {
        const currentRuntime = this.getRuntimeState(streamId, jobData.generationId);
        if (currentRuntime) {
          currentRuntime.syncSent = false;
          currentRuntime.hasSubscriber = false;
          // Persist syncSent=false to Redis for cross-replica consistency
          this.jobStore
            .updateJob(streamId, { syncSent: false }, jobData.generationId)
            .catch((err) => {
              logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
            });
        }
      },
      jobData.generationId,
    );

    const runDepartureHandlers = () => {
      const currentRuntime = this.getRuntimeState(streamId, jobData.generationId);
      if (!currentRuntime?.allSubscribersLeftHandlers) {
        return;
      }
      // A departure that lands after completeJob finds nothing here: cleanup() has removed these
      // callbacks and clearContentState() the parts. So this cannot cover a provider failure that
      // wins the race with a remote viewer's departure; the controller persists the error-path
      // partial itself, before completeJob, through the same exactly-once latch. Ordering against
      // a completed response is safe either way: saveMessage refuses to let an unfinished write
      // replace a finished row.
      this.jobStore
        .getContentParts(streamId, jobData.generationId)
        .then((result) => {
          const parts = result?.content ?? [];
          for (const handler of currentRuntime.allSubscribersLeftHandlers ?? []) {
            try {
              handler(parts);
            } catch (err) {
              logger.error(`[GenerationJobManager] Error in allSubscribersLeft handler:`, err);
            }
          }
        })
        .catch((err) => {
          logger.error(
            `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers:`,
            err,
          );
        });
    };
    if (this.eventTransport.onGlobalDeparture) {
      this.eventTransport.onGlobalDeparture(streamId, runDepartureHandlers, jobData.generationId);
    } else {
      this.eventTransport.onAllSubscribersLeft(
        streamId,
        runDepartureHandlers,
        jobData.generationId,
      );
    }
    // End [knauf]

    /**
     * Set up cross-replica abort listener (Redis mode only).
     * When abort is triggered on ANY replica, this replica receives the signal
     * and aborts its local AbortController (if it's the one running generation).
     */
    if (this.eventTransport.onAbort) {
      this.eventTransport.onAbort(
        streamId,
        () => {
          const currentRuntime = this.getRuntimeState(streamId, jobData.generationId);
          if (currentRuntime && !currentRuntime.abortController.signal.aborted) {
            logger.debug(`[GenerationJobManager] Received cross-replica abort for ${streamId}`);
            currentRuntime.abortController.abort();
          }
        },
        jobData.generationId,
      );
    }

    logger.debug(`[GenerationJobManager] Created job: ${streamId}`);

    // Return facade for backwards compatibility
    return this.buildJobFacade(streamId, jobData, runtime);
  }

  /**
   * Build a GenerationJob facade from composed services.
   *
   * This facade provides a unified API (job.emitter, job.abortController, etc.)
   * while internally delegating to the injected services (jobStore, eventTransport,
   * contentState). This allows swapping implementations (e.g., Redis) without
   * changing consumer code.
   *
   * IMPORTANT: The emitterProxy.on('allSubscribersLeft') handler registration
   * does NOT use eventTransport.subscribe(). This is intentional:
   *
   * If we used subscribe() for internal handlers, those handlers would count
   * as subscribers. When the real SSE client connects, isFirstSubscriber()
   * would return false (because internal handler was "first"), and readyPromise
   * would never resolve - causing a 5-second timeout delay before generation starts.
   *
   * Instead, allSubscribersLeft handlers are stored in runtime.allSubscribersLeftHandlers
   * and called directly from the onAllSubscribersLeft callback in createJob().
   *
   * @param streamId - The stream identifier
   * @param jobData - Serializable job metadata from job store
   * @param runtime - Non-serializable runtime state (abort controller, promises, etc.)
   * @returns A GenerationJob facade object
   */
  private buildJobFacade(
    streamId: string,
    jobData: SerializableJobData,
    runtime: RuntimeJobState,
  ): t.GenerationJob {
    /**
     * Proxy emitter that delegates to eventTransport for most operations.
     * Exception: allSubscribersLeft handlers are stored separately to avoid
     * incrementing subscriber count (see class JSDoc above).
     */
    const emitterProxy = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'allSubscribersLeft') {
          // Store handler for internal callback - don't use subscribe() to avoid counting as a subscriber
          if (!runtime.allSubscribersLeftHandlers) {
            runtime.allSubscribersLeftHandlers = [];
          }
          runtime.allSubscribersLeftHandlers.push(handler);
        }
      },
      emit: () => {
        /* handled via eventTransport */
      },
      listenerCount: () => this.eventTransport.getSubscriberCount(streamId, jobData.generationId),
      setMaxListeners: () => {
        /* no-op for proxy */
      },
      removeAllListeners: () => this.eventTransport.cleanup(streamId, jobData.generationId),
      off: () => {
        /* handled via unsubscribe */
      },
    };

    return {
      streamId,
      generationId: jobData.generationId,
      emitter: emitterProxy as unknown as t.GenerationJob['emitter'],
      status: jobData.status as t.GenerationJobStatus,
      createdAt: jobData.createdAt,
      completedAt: jobData.completedAt,
      abortController: runtime.abortController,
      error: jobData.error,
      metadata: {
        userId: jobData.userId,
        tenantId: jobData.tenantId,
        conversationId: jobData.conversationId,
        userMessage: jobData.userMessage,
        responseMessageId: jobData.responseMessageId,
        sender: jobData.sender,
        endpoint: jobData.endpoint,
        iconURL: jobData.iconURL,
        model: jobData.model,
        promptTokens: jobData.promptTokens,
      },
      readyPromise: runtime.readyPromise,
      resolveReady: runtime.resolveReady,
      finalEvent: runtime.finalEvent,
      syncSent: runtime.syncSent,
    };
  }

  /**
   * Get or create runtime state for a job.
   *
   * This enables cross-replica support in Redis mode:
   * - If runtime exists locally (same replica), return it
   * - If job exists in Redis but not locally (cross-replica), create minimal runtime
   *
   * The lazily-created runtime state is sufficient for:
   * - Subscribing to events (via Redis pub/sub)
   * - Getting resume state
   * - Handling reconnections
   * - Receiving cross-replica abort signals (via Redis pub/sub)
   *
   * @param streamId - The stream identifier
   * @returns Runtime state or null if job doesn't exist anywhere
   */
  private async getOrCreateRuntimeState(
    streamId: string,
    jobData: SerializableJobData,
  ): Promise<RuntimeJobState | null> {
    // [knauf] Use one metadata snapshot, then validate it before replacing local state.
    let existingRuntime = this.runtimeState.get(streamId);
    if (existingRuntime?.generationId === jobData.generationId) {
      return existingRuntime;
    }

    const currentJob = await this.jobStore.getJob(streamId);
    if (!currentJob || currentJob.generationId !== jobData.generationId) {
      return null;
    }

    existingRuntime = this.runtimeState.get(streamId);
    if (existingRuntime?.generationId === jobData.generationId) {
      return existingRuntime;
    }
    if (existingRuntime) {
      existingRuntime.terminal = true;
      existingRuntime.abortController.abort();
    }
    // End [knauf]

    // Cross-replica scenario: job exists in Redis but not locally
    // Create minimal runtime state for handling reconnection/subscription
    logger.debug(`[GenerationJobManager] Creating cross-replica runtime for ${streamId}`);

    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // For jobs created on other replicas, readyPromise should be pre-resolved
    // since generation has already started
    resolveReady!();

    // Parse finalEvent from Redis if available
    let finalEvent: t.ServerSentEvent | undefined;
    if (jobData.finalEvent) {
      try {
        finalEvent = JSON.parse(jobData.finalEvent) as t.ServerSentEvent;
      } catch {
        // Ignore parse errors
      }
    }

    const runtime: RuntimeJobState = {
      generationId: jobData.generationId,
      terminal: jobData.status !== 'running',
      completionRecorded: jobData.status !== 'running',
      abortController: new AbortController(),
      readyPromise,
      resolveReady: resolveReady!,
      syncSent: jobData.syncSent ?? false,
      earlyEventBuffer: [],
      hasSubscriber: false,
      finalEvent,
      errorEvent: jobData.error,
    };

    this.runtimeState.set(streamId, runtime);

    // Set up all-subscribers-left callback for this replica
    // [knauf] Local reconnect reset only. This runtime was built for a generation another replica
    // owns, so it never has save handlers; registering the save here would only add an observer
    // that can never do anything. The owner registers the verified global signal in createJob.
    this.eventTransport.onAllSubscribersLeft(
      streamId,
      () => {
        const currentRuntime = this.getRuntimeState(streamId, jobData.generationId);
        if (currentRuntime) {
          currentRuntime.syncSent = false;
          currentRuntime.hasSubscriber = false;
          // Persist syncSent=false to Redis
          this.jobStore
            .updateJob(streamId, { syncSent: false }, jobData.generationId)
            .catch((err) => {
              logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
            });
        }
      },
      jobData.generationId,
    );
    // End [knauf]

    // Set up cross-replica abort listener (Redis mode only)
    // This ensures lazily-initialized jobs can receive abort signals
    if (this.eventTransport.onAbort) {
      this.eventTransport.onAbort(
        streamId,
        () => {
          const currentRuntime = this.getRuntimeState(streamId, jobData.generationId);
          if (currentRuntime && !currentRuntime.abortController.signal.aborted) {
            logger.debug(
              `[GenerationJobManager] Received cross-replica abort for lazily-init job ${streamId}`,
            );
            currentRuntime.abortController.abort();
          }
        },
        jobData.generationId,
      );
    }

    return runtime;
  }

  /**
   * Get a job by streamId.
   */
  async getJob(streamId: string): Promise<t.GenerationJob | undefined> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return undefined;
    }

    // [knauf] Build metadata and runtime from the same validated generation.
    const runtime = await this.getOrCreateRuntimeState(streamId, jobData);
    if (!runtime) {
      return undefined;
    }

    return this.buildJobFacade(streamId, jobData, runtime);
    // End [knauf]
  }

  /**
   * Check if a job exists.
   */
  async hasJob(streamId: string): Promise<boolean> {
    return this.jobStore.hasJob(streamId);
  }

  /**
   * Get job status.
   */
  async getJobStatus(streamId: string): Promise<t.GenerationJobStatus | undefined> {
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.status as t.GenerationJobStatus | undefined;
  }

  // [knauf] Document bounded Redis terminal retention for late reconnects.
  /**
   * Mark job as complete.
   * If cleanupOnComplete is true (default), in-memory jobs are removed immediately;
   * Redis keeps only terminal metadata until its completed TTL.
   * Exception: Jobs with errors are NOT immediately deleted to allow late-connecting
   * clients to receive the error (race condition where error occurs before client connects).
   * Note: eventTransport is NOT cleaned up here to allow the final event to be
   * fully transmitted. It will be cleaned up when subscribers disconnect or
   * by the periodic cleanup job.
   */
  // End [knauf]
  async completeJob(streamId: string, error?: string, generationId?: string): Promise<void> {
    // [knauf] NO-TICKET — abortJob owns abort persistence and accounting. Its
    // request callback may arrive later and must not relabel the abort as error.
    if (error === 'Request aborted' || error === 'Request aborted during initialization') {
      return;
    }
    // End [knauf]

    // [knauf] Capture ownership before awaiting; a later turn may claim the conversation.
    let ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    if (ownerGenerationId == null) {
      ownerGenerationId = (await this.jobStore.getJob(streamId))?.generationId;
    }
    const runtime = this.getRuntimeState(streamId, ownerGenerationId);
    const ownerKey = this.generationKey(streamId, ownerGenerationId);
    const terminalStatus: TerminalJobStatus = error ? 'error' : 'complete';
    if (runtime) {
      if (runtime.completionRecorded) {
        return;
      }
      runtime.terminal = true;
    }
    // End [knauf]

    // [knauf] emitDone()/emitError() may already have committed the transition on
    // this runtime. Otherwise completeJob performs the same atomic CAS itself.
    let terminalId =
      runtime?.terminalTransition?.status === terminalStatus
        ? runtime.terminalTransition.terminalId
        : undefined;
    let transitionedNow = false;
    if (!terminalId) {
      const transition = await this.transitionToTerminal(
        streamId,
        terminalStatus,
        error ? { error } : {},
        ownerGenerationId,
      );
      if (runtime && transition.won) {
        runtime.terminalTransition = {
          status: terminalStatus,
          terminalId: transition.terminalId,
        };
      }
      if (transition.won) {
        terminalId = transition.terminalId;
        transitionedNow = true;
      } else {
        const persisted = await this.jobStore.getJob(streamId);
        if (
          persisted != null &&
          persisted.generationId === ownerGenerationId &&
          persisted.status === terminalStatus
        ) {
          terminalId = persisted.terminalId;
        }
      }
    }
    if (!terminalId) {
      return;
    }
    if (error && transitionedNow) {
      try {
        await this.eventTransport.emitError(streamId, error, ownerGenerationId);
      } catch (publishError) {
        logger.error('[GenerationJobManager] Error state committed but publish failed', {
          streamId,
          generationId: ownerGenerationId,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });
      }
    }
    const ownsTerminalEffects = await this.claimTerminalEffectsOnce(
      streamId,
      terminalId,
      ownerGenerationId,
    );
    if (runtime) {
      runtime.completionRecorded = true;
    }
    // End [knauf]

    // Abort the controller to signal all pending operations (e.g., OAuth flow monitors)
    // that the job is done and they should clean up
    if (runtime) {
      runtime.abortController.abort();
    }

    // Clear content state and run step buffer (Redis only)
    this.jobStore.clearContentState(streamId, ownerGenerationId);
    this.runStepBuffers?.delete(ownerKey);
    this.replayEventWriteQueues.delete(ownerKey);
    this.tokenUsageWriteQueues.delete(ownerKey);

    // For error jobs, DON'T delete immediately - keep around so late-connecting
    // clients can receive the error. This handles the race condition where error
    // occurs before client connects to SSE stream.
    //
    // Cleanup strategy: Error jobs are cleaned up by periodic cleanup (every 60s)
    // via jobStore.cleanup() which checks for jobs with status 'error' and
    // completedAt set. The TTL is configurable via jobStore options (default: 0,
    // meaning cleanup on next interval). This gives clients ~60s to connect and
    // receive the error before the job is removed.
    if (error) {
      // [knauf] Redis late replay needs the hash, not five minutes of local runtime/listeners.
      if (this.runtimeState.get(streamId) === runtime) {
        this.runningJobs.delete(streamId);
        if (this._isRedis) {
          this.runtimeState.delete(streamId);
        }
      }
      if (
        this._isRedis &&
        this.eventTransport.getSubscriberCount(streamId, ownerGenerationId) === 0
      ) {
        this.eventTransport.cleanup(streamId, ownerGenerationId);
      }
      // End [knauf]
      this.syncRunningJobMetrics();
      // [knauf] NO-TICKET — emit only the allow-listed failure class.
      const failureReason = getGenerationJobFailureReason(error);
      if (ownsTerminalEffects) {
        recordGenerationJob(this.storeLabel, 'error', failureReason);
      }
      // End [knauf]
      // [knauf] KK20-338 — single deduplicated terminal-cause log for dashboards.
      if (ownsTerminalEffects) {
        logGenerationTerminalCause(this.storeLabel, streamId, ownerGenerationId, failureReason);
      }
      // End [knauf]
      logger.debug(
        `[GenerationJobManager] Job completed with error (persisted for late subscribers): ${streamId}`,
      );
      return;
    }

    // [knauf] Redis keeps the terminal hash for its short completed TTL so a reconnect that
    // missed pub/sub can still recover the final response. In-memory delivery is synchronous.
    if (this._cleanupOnComplete && !this._isRedis) {
      if (this.runtimeState.get(streamId) === runtime) {
        this.runtimeState.delete(streamId);
      }
      // Don't cleanup eventTransport here - let the done event fully transmit first.
      // EventTransport will be cleaned up when subscribers disconnect or by periodic cleanup.
      await this.jobStore.deleteJob(streamId, ownerGenerationId);
    } else {
      // Redis terminal metadata was already committed by the atomic transition.
    }
    if (this._isRedis && this.runtimeState.get(streamId) === runtime) {
      this.runtimeState.delete(streamId);
    }
    if (
      this._isRedis &&
      this.eventTransport.getSubscriberCount(streamId, ownerGenerationId) === 0
    ) {
      this.eventTransport.cleanup(streamId, ownerGenerationId);
    }
    // End [knauf]

    if (this.runtimeState.get(streamId) === runtime || !this.runtimeState.has(streamId)) {
      this.runningJobs.delete(streamId);
    }
    this.syncRunningJobMetrics();
    if (ownsTerminalEffects) {
      recordGenerationJob(this.storeLabel, 'completed');
    }
    // [knauf] KK20-338 — single deduplicated terminal-cause log for dashboards.
    if (ownsTerminalEffects) {
      logGenerationTerminalCause(this.storeLabel, streamId, ownerGenerationId, 'completed');
    }
    // End [knauf]
    logger.debug(`[GenerationJobManager] Job completed: ${streamId}`);
  }

  /**
   * Abort a job (user-initiated by default).
   * Returns all data needed for token spending and message saving.
   *
   * Cross-replica support (Redis mode):
   * - Emits abort signal via Redis pub/sub
   * - The replica running generation receives signal and aborts its AbortController
   *
   * @param streamId - The job/stream to abort.
   * @param options.initiatedBy - [knauf] KK20-338 — who triggered the abort, so the
   *   terminal-cause log can distinguish an explicit user Stop from a system-initiated
   *   cleanup (e.g. account deactivation). Defaults to 'user' to preserve existing
   *   call-site behavior.
   * @param options.waitForAcknowledgement - Wait until the owning request confirms it
   *   has stopped writing. Used before destructive account-data cleanup.
   */
  async abortJob(
    streamId: string,
    options?: { initiatedBy?: 'user' | 'system'; waitForAcknowledgement?: boolean },
  ): Promise<AbortResult> {
    const initiatedBy = options?.initiatedBy ?? 'user';
    const jobData = await this.jobStore.getJob(streamId);

    if (!jobData) {
      logger.warn(`[GenerationJobManager] Cannot abort - job not found: ${streamId}`);
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData: null,
        success: false,
        finalEvent: null,
        collectedUsage: [],
      };
    }

    // [knauf] Abort only the authenticated generation and synchronously claim its terminal metric.
    const generationId = jobData.generationId;
    const runtime = this.getRuntimeState(streamId, generationId);
    const ownerKey = this.generationKey(streamId, generationId);
    // End [knauf]

    /** Content before clearing state */
    const result = await this.jobStore.getContentParts(streamId, generationId);
    const content = result?.content ?? [];
    const abortContent = filterPersistableAbortContent(content);
    const shouldPersistAbortContent = abortContent.length > 0;

    /** Collected usage for all models */
    const collectedUsage = this.jobStore.getCollectedUsage(streamId, generationId);

    /** Text from content parts for fallback token counting */
    const text = shouldPersistAbortContent
      ? parseTextParts(abortContent as TMessageContentParts[])
      : '';

    /** Detect "early abort" - aborted before any generation happened (e.g., during tool loading)
      In this case, no messages were saved to DB, so frontend shouldn't navigate to conversation */
    const isEarlyAbort = !shouldPersistAbortContent && jobData.createdEventEmitted !== true;

    /** Final event for abort */
    const userMessageId = jobData.userMessage?.messageId;

    const abortFinalEvent: t.ServerSentEvent = {
      final: true,
      // Don't include conversation for early aborts - it doesn't exist in DB
      conversation: isEarlyAbort ? null : { conversationId: jobData.conversationId },
      title: 'New Chat',
      requestMessage: jobData.userMessage
        ? {
            messageId: userMessageId,
            parentMessageId: jobData.userMessage.parentMessageId,
            conversationId: jobData.conversationId,
            text: jobData.userMessage.text ?? '',
            quotes: jobData.userMessage.quotes,
            isCreatedByUser: true,
          }
        : null,
      responseMessage: isEarlyAbort
        ? null
        : {
            messageId: jobData.responseMessageId ?? `${userMessageId ?? 'aborted'}_`,
            parentMessageId: userMessageId,
            conversationId: jobData.conversationId,
            content: abortContent,
            sender: jobData.sender ?? 'AI',
            endpoint: jobData.endpoint,
            iconURL: jobData.iconURL,
            model: jobData.model,
            unfinished: true,
            error: false,
            isCreatedByUser: false,
          },
      aborted: true,
      // Flag for early abort - no messages saved, frontend should go to new chat
      earlyAbort: isEarlyAbort,
      // [knauf] KK20-338 — lets the SSE route (which has no other visibility into
      // GenerationJobManager's initiatedBy option) record system_abort vs user_abort
      // in its own independent stream telemetry instead of always assuming user_abort.
      initiatedBy,
      // End [knauf]
    } satisfies t.FinalEvent as t.ServerSentEvent;

    // [knauf] Only the atomic running-to-aborted winner may publish or clean up.
    const transition = await this.transitionToTerminal(
      streamId,
      'aborted',
      { finalEvent: JSON.stringify(abortFinalEvent) },
      generationId,
    );
    if (!transition.won) {
      if (options?.waitForAcknowledgement) {
        await this.waitForTerminalAcknowledgement(streamId, generationId);
      }
      recordGenerationJob(this.storeLabel, 'abort_failed');
      return {
        text: '',
        content: [],
        jobData,
        success: false,
        finalEvent: null,
        collectedUsage: [],
      };
    }
    const ownsTerminalEffects = await this.claimTerminalEffectsOnce(
      streamId,
      transition.terminalId,
      generationId,
    );

    if (runtime) {
      runtime.finalEvent = abortFinalEvent;
      runtime.terminal = true;
      runtime.completionRecorded = true;
      runtime.terminalTransition = { status: 'aborted', terminalId: transition.terminalId };
      runtime.abortController.abort();
    }

    if (this.eventTransport.emitAbort) {
      try {
        await this.eventTransport.emitAbort(streamId, generationId);
      } catch (publishError) {
        logger.error('[GenerationJobManager] Abort committed but abort signal publish failed', {
          streamId,
          generationId,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });
      }
      if (options?.waitForAcknowledgement) {
        await this.waitForTerminalAcknowledgement(streamId, generationId);
      }
    }
    try {
      await this.eventTransport.emitDone(streamId, abortFinalEvent, generationId);
    } catch (publishError) {
      logger.error('[GenerationJobManager] Aborted state committed but publish failed', {
        streamId,
        generationId,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
    // End [knauf]
    this.jobStore.clearContentState(streamId, generationId);
    this.runStepBuffers?.delete(ownerKey);
    this.replayEventWriteQueues.delete(ownerKey);
    this.tokenUsageWriteQueues.delete(ownerKey);

    // [knauf] Retain Redis terminal metadata until its completed TTL for late reconnects.
    if (this._cleanupOnComplete && !this._isRedis) {
      if (this.runtimeState.get(streamId) === runtime) {
        this.runtimeState.delete(streamId);
      }
      // Don't cleanup eventTransport here - let the abort event fully transmit first.
      await this.jobStore.deleteJob(streamId, generationId);
    } else {
      // Redis terminal metadata was already committed by the atomic transition.
    }
    if (this._isRedis && this.runtimeState.get(streamId) === runtime) {
      this.runtimeState.delete(streamId);
    }
    if (this._isRedis && this.eventTransport.getSubscriberCount(streamId, generationId) === 0) {
      this.eventTransport.cleanup(streamId, generationId);
    }
    // End [knauf]

    if (this.runtimeState.get(streamId) === runtime || !this.runtimeState.has(streamId)) {
      this.runningJobs.delete(streamId);
    }
    this.syncRunningJobMetrics();
    if (ownsTerminalEffects) {
      recordGenerationJob(this.storeLabel, 'aborted');
      // [knauf] KK20-338 — single deduplicated terminal-cause log for dashboards.
      logGenerationTerminalCause(
        this.storeLabel,
        streamId,
        generationId,
        initiatedBy === 'system' ? 'system_abort' : 'user_abort',
      );
      // End [knauf]
    }
    logger.debug(`[GenerationJobManager] Job aborted: ${streamId}`);

    return {
      success: true,
      jobData,
      content: abortContent,
      finalEvent: abortFinalEvent,
      text,
      collectedUsage,
    };
  }

  /**
   * Subscribe to a job's event stream.
   *
   * This is called when an SSE client connects to /chat/stream/:streamId.
   * On first subscription:
   * - Resolves readyPromise (legacy, for API compatibility)
   * - Replays any buffered early events (e.g., 'created' event)
   *
   * Supports cross-replica reconnection in Redis mode:
   * - If job exists in Redis but not locally, creates minimal runtime state
   * - Events are delivered via Redis pub/sub, not in-memory EventEmitter
   *
   * @param streamId - The stream to subscribe to
   * @param onChunk - Handler for chunk events (streamed tokens, run steps, etc.)
   * @param onDone - Handler for completion event (includes final message)
   * @param onError - Handler for error events
   * @param options - Subscription configuration
   * @param options.skipBufferReplay - When true, skips replaying the earlyEventBuffer.
   *   Use this when a sync event was already sent (resume), since the sync's
   *   aggregatedContent already includes all buffered events.
   * @returns Subscription object with unsubscribe function, or null if job not found
   */
  async subscribe(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    options?: t.SubscribeOptions,
  ): Promise<{ unsubscribe: t.UnsubscribeFn } | null> {
    const subscriptionType = options?.skipBufferReplay ? 'resume' : 'initial';
    // [knauf] Use one validated generation snapshot for runtime, terminal replay, and transport.
    const jobData = await this.jobStore.getJob(streamId);
    if (
      !jobData ||
      (options?.requireGenerationMatch && jobData.generationId !== options.generationId)
    ) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
      return null;
    }

    // Use lazy initialization to support cross-replica subscriptions
    const runtime = await this.getOrCreateRuntimeState(streamId, jobData);
    if (!runtime) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'not_found');
      return null;
    }

    let terminalDelivered = false;
    const deliverDone = (event: t.ServerSentEvent) => {
      if (!terminalDelivered) {
        terminalDelivered = true;
        onDone?.(event);
      }
    };
    const deliverError = (error: string) => {
      if (!terminalDelivered) {
        terminalDelivered = true;
        onError?.(error);
      }
    };
    const replayTerminal = (terminalJob: SerializableJobData) => {
      if (!['complete', 'error', 'aborted'].includes(terminalJob.status)) {
        return;
      }
      runtime.terminal = true;
      if (terminalJob.status === 'error' && (runtime.errorEvent || terminalJob.error)) {
        const errorToSend = runtime.errorEvent ?? terminalJob.error;
        if (errorToSend) {
          logger.debug(
            `[GenerationJobManager] Sending stored error to late subscriber: ${streamId}`,
          );
          runtime.errorEvent = errorToSend;
          deliverError(errorToSend);
        }
        return;
      }
      if (terminalJob.finalEvent) {
        try {
          runtime.finalEvent = JSON.parse(terminalJob.finalEvent) as t.ServerSentEvent;
        } catch {
          // Ignore malformed persisted terminal events.
        }
      }
      if (runtime.finalEvent) {
        deliverDone(runtime.finalEvent);
      }
    };

    // Subscribe/reorder only within the persisted generation snapshot.
    const subscription = this.eventTransport.subscribe(
      streamId,
      {
        onChunk: (event) => {
          const e = event as t.ServerSentEvent;
          if (!(e as Record<string, unknown>)._internal) {
            onChunk(e);
          }
        },
        onDone: (event) => deliverDone(event as t.ServerSentEvent),
        onError: deliverError,
      },
      runtime.generationId,
    );
    const releaseSubscription = () => {
      subscription.unsubscribe();
      if (this.eventTransport.getSubscriberCount(streamId, runtime.generationId) === 0) {
        this.eventTransport.cleanup(streamId, runtime.generationId);
      }
    };

    try {
      if (subscription.ready) {
        await subscription.ready;
      }
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'success');
    } catch (err) {
      recordGenerationStreamSubscription(this.storeLabel, subscriptionType, 'error');
      throw err;
    }

    const isFirst = this.eventTransport.isFirstSubscriber(streamId, runtime.generationId);

    if (!runtime.hasSubscriber) {
      runtime.hasSubscriber = true;

      /**
       * Pass earlyReplayCount to syncReorderBuffer so it can prune duplicate pub/sub
       * entries (seqs 0..count-1) without touching live in-flight chunks.
       *
       * Only set when the buffer was actually replayed — those specific seqs were
       * delivered via onChunk and their pub/sub copies are duplicates.
       * When skipBufferReplay is true, the resume sync payload delivers aggregated
       * content up to the Redis counter, so syncReorderBuffer should trust currentSeq
       * as the frontier (earlyReplayCount = 0).
       */
      let earlyReplayCount = 0;

      if (runtime.earlyEventBuffer.length > 0) {
        if (options?.skipBufferReplay) {
          logger.debug(
            `[GenerationJobManager] Skipping ${runtime.earlyEventBuffer.length} buffered events for ${streamId} (skipBufferReplay)`,
          );
        } else {
          earlyReplayCount = runtime.earlyEventBuffer.length;
          logger.debug(
            `[GenerationJobManager] Replaying ${earlyReplayCount} buffered events for ${streamId}`,
          );
          for (const bufferedEvent of runtime.earlyEventBuffer) {
            onChunk(bufferedEvent);
          }
        }
        runtime.earlyEventBuffer = [];
      } else if (this._isRedis && !options?.skipBufferReplay && jobData?.userMessage) {
        /**
         * Cross-replica fallback: the created event was buffered on the generating
         * instance and published via Redis pub/sub before this subscriber was active.
         * Reconstruct from persisted metadata. Only fields stored by trackUserMessage()
         * are available (messageId, parentMessageId, conversationId, text);
         * sender/isCreatedByUser are invariant for user messages and added back here.
         */
        logger.debug(
          `[GenerationJobManager] Cross-replica subscribe: emitting created event from metadata for ${streamId}`,
        );
        const createdEvent: t.CreatedEvent = {
          created: true,
          message: {
            ...jobData.userMessage,
            sender: 'User',
            isCreatedByUser: true,
          },
          streamId,
        };
        onChunk(createdEvent);
      }

      try {
        await this.eventTransport.syncReorderBuffer?.(
          streamId,
          earlyReplayCount,
          runtime.generationId,
        );
      } catch (err) {
        logger.warn(
          `[GenerationJobManager] Failed to sync reorder buffer for ${streamId}; proceeding with current nextSeq:`,
          err,
        );
      }
    }

    // A terminal publish can land after the first job snapshot but before the Redis
    // channel is ready. Re-read after subscription and replay the persisted final once.
    const currentJob = await this.jobStore.getJob(streamId);
    if (!currentJob || currentJob.generationId !== runtime.generationId) {
      releaseSubscription();
      return null;
    }
    replayTerminal(currentJob);
    if (terminalDelivered) {
      releaseSubscription();
    }
    // End [knauf]

    if (isFirst) {
      runtime.resolveReady();
      logger.debug(
        `[GenerationJobManager] First subscriber ready, resolving promise for ${streamId}`,
      );
    }

    return subscription;
  }

  /**
   * Atomic resume + subscribe: snapshots resume state and drains the early event buffer
   * in one synchronous step, then subscribes with skipBufferReplay.
   *
   * Closes the timing gap between separate `getResumeState()` and `subscribe()` calls
   * where events could arrive in earlyEventBuffer after the snapshot but before subscribe
   * clears the buffer.
   *
   * In-memory mode: drained buffer events are returned as `pendingEvents` since
   * they exist nowhere else. The caller must deliver them after the sync payload.
   * Redis mode: `pendingEvents` is empty — chunks are persisted via appendChunk
   * and will appear in aggregatedContent on the next resume.
   */
  async subscribeWithResume(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
  ): Promise<t.SubscribeWithResumeResult> {
    // [knauf] Snapshot, gap events, subscription, and returned owner must be one generation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const jobData = await this.jobStore.getJob(streamId);
      if (!jobData) {
        recordGenerationStreamSubscription(this.storeLabel, 'resume_state', 'missing');
        return { subscription: null, resumeState: null, pendingEvents: [] };
      }
      const generationId = jobData.generationId;
      const runtimeAtSnapshot = this.getRuntimeState(streamId, generationId);
      const bufferLengthAtSnapshot = !this._isRedis
        ? (runtimeAtSnapshot?.earlyEventBuffer.length ?? 0)
        : 0;

      const resumeState = await this.getResumeState(streamId, generationId, true);
      recordGenerationStreamSubscription(
        this.storeLabel,
        'resume_state',
        resumeState ? 'found' : 'missing',
      );
      if (!resumeState) {
        continue;
      }

      let pendingEvents: t.ServerSentEvent[] = [];
      if (!this._isRedis) {
        const runtime = this.getRuntimeState(streamId, generationId);
        if (runtime) {
          pendingEvents = runtime.earlyEventBuffer.slice(bufferLengthAtSnapshot);
          runtime.earlyEventBuffer = [];
          if (pendingEvents.length > 0) {
            recordGenerationStreamResumePendingEvents(this.storeLabel, pendingEvents.length);
            logger.debug(
              `[GenerationJobManager] Captured ${pendingEvents.length} gap events for ${streamId}`,
            );
          }
        }
      }

      const subscription = await this.subscribe(streamId, onChunk, onDone, onError, {
        skipBufferReplay: true,
        generationId,
        requireGenerationMatch: true,
      });
      if (subscription) {
        return { subscription, resumeState, pendingEvents, generationId };
      }
    }
    return { subscription: null, resumeState: null, pendingEvents: [] };
    // End [knauf]
  }

  /**
   * Emit a chunk event to all subscribers.
   * Uses runtime state check for performance (avoids async job store lookup per token).
   *
   * If no subscriber has connected yet, buffers the event for replay when they do.
   * This ensures early events (like 'created') aren't lost due to race conditions.
   *
   * In Redis mode, awaits the publish to guarantee event ordering.
   * This is critical for streaming deltas (tool args, message content) to arrive in order.
   */
  async emitChunk(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    // [knauf] A detached callback may finish after the next turn starts. Its captured
    // generation cannot publish into, persist into, or terminate the new turn.
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    const runtime = this.getRuntimeState(streamId, ownerGenerationId);
    if (!runtime || runtime.abortController.signal.aborted || runtime.terminal) {
      return;
    }

    // [knauf] Redis status is authoritative for every SSE envelope, including
    // created/title events that are not appended to the resumable chunk stream.
    if (this._isRedis) {
      const durableJob = await this.jobStore.getJob(streamId);
      if (
        !durableJob ||
        durableJob.generationId !== ownerGenerationId ||
        durableJob.status !== 'running'
      ) {
        runtime.abortController.abort();
        runtime.terminal = true;
        return;
      }
    }
    // End [knauf]

    // Refresh job activity so the store's stale-job failsafe reaps on inactivity
    // (a hung generation), not on age (a long but live stream). Parity with
    // RedisJobStore refreshing the running TTL on each appendChunk.
    this.jobStore.recordActivity?.(streamId, ownerGenerationId);

    await this.trackUserMessage(streamId, event, ownerGenerationId);
    await this.trackTitleEvent(streamId, event, ownerGenerationId);
    await this.trackReplayEvent(streamId, event, ownerGenerationId);
    await this.trackContextUsage(streamId, event, ownerGenerationId);
    await this.trackTokenUsage(streamId, event, ownerGenerationId);

    if (this.getRuntimeState(streamId, ownerGenerationId)?.terminal !== false) {
      return;
    }

    // For Redis mode, persist chunk for later reconstruction (fire-and-forget for resumability)
    if (this._isRedis) {
      // The SSE event structure is { event: string, data: unknown, ... }
      // The aggregator expects { event: string, data: unknown } where data is the payload
      const eventObj = event as Record<string, unknown>;
      const eventType = eventObj.event as string | undefined;
      const eventData = eventObj.data;

      if (eventType && eventData !== undefined) {
        // Store in format expected by aggregateContent: { event, data }
        let appended: void | boolean;
        try {
          appended = await this.jobStore.appendChunk(
            streamId,
            { event: eventType, data: eventData },
            ownerGenerationId,
          );
        } catch (appendError) {
          const durableJob = await this.jobStore.getJob(streamId);
          if (
            durableJob != null &&
            durableJob.generationId === ownerGenerationId &&
            durableJob.status === 'running'
          ) {
            throw appendError;
          }
          runtime.abortController.abort();
          runtime.terminal = true;
          return;
        }
        if (appended === false) {
          runtime.abortController.abort();
          runtime.terminal = true;
          return;
        }

        // For run step events, also save to run steps key for quick retrieval
        if (eventType === 'on_run_step' || eventType === 'on_run_step_completed') {
          this.saveRunStepFromEvent(
            streamId,
            eventData as Record<string, unknown>,
            ownerGenerationId,
          );
        }
      }
    }

    if (!runtime.hasSubscriber) {
      runtime.earlyEventBuffer.push(event);
      if (!this._isRedis) {
        return;
      }
    }

    await this.eventTransport.emitChunk(streamId, event, ownerGenerationId);
    // End [knauf]
  }

  /**
   * Extract and save run step from event data.
   * The data is already the run step object from the event payload.
   */
  private saveRunStepFromEvent(
    streamId: string,
    data: Record<string, unknown>,
    generationId?: string,
  ): void {
    // The data IS the run step object
    const runStep = data as Agents.RunStep;
    if (!runStep.id) {
      return;
    }

    // Fire and forget - accumulate run steps
    this.accumulateRunStep(streamId, runStep, generationId);
  }

  /**
   * Accumulate run steps for a stream (Redis mode only).
   * Uses a simple in-memory buffer that gets flushed to Redis.
   * Not used in in-memory mode - run steps come from live graph via WeakRef.
   */
  private runStepBuffers: Map<string, Agents.RunStep[]> | null = null;

  private accumulateRunStep(
    streamId: string,
    runStep: Agents.RunStep,
    generationId?: string,
  ): void {
    // Lazy initialization - only create map when first used (Redis mode)
    if (!this.runStepBuffers) {
      this.runStepBuffers = new Map();
    }

    // [knauf] Run-step buffers and persistence belong to one generation.
    const ownerKey = this.generationKey(streamId, generationId);
    let buffer = this.runStepBuffers.get(ownerKey);
    if (!buffer) {
      buffer = [];
      this.runStepBuffers.set(ownerKey, buffer);
    }

    // Update or add run step
    const existingIdx = buffer.findIndex((rs) => rs.id === runStep.id);
    if (existingIdx >= 0) {
      buffer[existingIdx] = runStep;
    } else {
      buffer.push(runStep);
    }

    // Save to Redis
    if (this.jobStore.saveRunSteps) {
      this.jobStore.saveRunSteps(streamId, buffer, generationId).catch((err) => {
        logger.error(`[GenerationJobManager] Failed to save run steps:`, err);
      });
    }
    // End [knauf]
  }

  /**
   * Persist the last title event so resume sync can replay it. Content
   * aggregation only reconstructs message parts, so UI-only events need their
   * own metadata slot.
   */
  private async trackTitleEvent(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    if (!('event' in event) || event.event !== 'title') {
      return;
    }

    await this.jobStore.updateJob(streamId, { titleEvent: JSON.stringify(event) }, generationId);
  }

  /**
   * Persist the latest context usage snapshot (one per model call) so a
   * resuming client can restore the context gauge without waiting for the
   * next model call.
   */
  private async trackContextUsage(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    if (!('event' in event) || event.event !== UsageEvents.ON_CONTEXT_USAGE) {
      return;
    }

    /** Share the token-usage queue so snapshot + usage writes are serialized per
     *  stream: `persistTokenUsage` reconciles the stored snapshot (read-modify-
     *  write), and a snapshot landing between its read and write — or a stale
     *  reconciled write landing after a newer snapshot — would clobber the newer
     *  run's gauge when visible calls interleave. FIFO ordering keeps each call's
     *  pre-invoke snapshot ahead of its own usage and behind the next snapshot. */
    const ownerKey = this.generationKey(streamId, generationId);
    await this.queueJobWrite(this.tokenUsageWriteQueues, ownerKey, () =>
      this.jobStore.updateJob(
        streamId,
        { contextUsage: JSON.stringify((event as { data?: unknown }).data ?? null) },
        generationId,
      ),
    );
  }

  /**
   * Chains a read/modify/write job update onto the stream's queue so
   * concurrent writers can't clobber each other's merged state.
   */
  private async queueJobWrite(
    queues: Map<string, Promise<void>>,
    queueKey: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const previousWrite = queues.get(queueKey) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => {
        // Keep the queue moving even if a prior metadata write failed.
      })
      .then(write);

    queues.set(queueKey, nextWrite);

    try {
      await nextWrite;
    } finally {
      if (queues.get(queueKey) === nextWrite) {
        queues.delete(queueKey);
      }
    }
  }

  /**
   * Persist replay-only stream events that are needed to reconstruct active
   * UI state on resume but are not represented by aggregated message content.
   */
  private async trackReplayEvent(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    if (!isOAuthReplayEvent(event)) {
      return;
    }

    const ownerKey = this.generationKey(streamId, generationId);
    await this.queueJobWrite(this.replayEventWriteQueues, ownerKey, () =>
      this.persistReplayEvent(streamId, event, generationId),
    );
  }

  /**
   * Persist per-model-call token usage so resuming clients can rebuild
   * usage totals on any replica (the live collectedUsage array only exists
   * on the generating instance).
   */
  private async trackTokenUsage(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    if (!('event' in event) || event.event !== UsageEvents.ON_TOKEN_USAGE) {
      return;
    }

    const ownerKey = this.generationKey(streamId, generationId);
    await this.queueJobWrite(this.tokenUsageWriteQueues, ownerKey, () =>
      this.persistTokenUsage(streamId, event as { data?: unknown }, generationId),
    );
  }

  private async persistTokenUsage(
    streamId: string,
    event: { data?: unknown },
    generationId?: string,
  ): Promise<void> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData || jobData.generationId !== generationId || event.data == null) {
      return;
    }

    let tokenUsage: unknown[] = [];
    if (jobData.tokenUsage) {
      try {
        tokenUsage = JSON.parse(jobData.tokenUsage) as unknown[];
      } catch {
        tokenUsage = [];
      }
    }
    tokenUsage.push(event.data);

    const update: Partial<SerializableJobData> = { tokenUsage: JSON.stringify(tokenUsage) };

    /** Reconcile the resume snapshot to this call's ACTUAL prompt tokens. A primary
     *  usage is the post-invoke truth for the call the latest stored snapshot
     *  precedes (no snapshot is captured between a call's pre-invoke dispatch and
     *  its usage), so a resuming client restores the real context instead of the
     *  calibration-inflated estimate — and a mid-call resume (no usage yet) simply
     *  keeps the raw snapshot rather than mis-applying an earlier call's tokens. */
    const usage = event.data as TTokenUsageEvent;
    if (usage.usage_type == null && jobData.contextUsage) {
      try {
        const snapshot = JSON.parse(jobData.contextUsage) as TContextUsageEvent | null;
        if (
          snapshot != null &&
          (snapshot.runId == null || usage.runId == null || snapshot.runId === usage.runId)
        ) {
          update.contextUsage = JSON.stringify(
            reconcileContextUsage(snapshot, promptTokensFromUsage(usage)),
          );
        }
      } catch {
        /* leave the stored snapshot as-is on parse failure */
      }
    }

    await this.jobStore.updateJob(streamId, update, generationId);
  }

  private async persistReplayEvent(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData || jobData.generationId !== generationId) {
      return;
    }

    let replayEvents: t.ServerSentEvent[] = [];
    if (jobData.replayEvents) {
      try {
        replayEvents = JSON.parse(jobData.replayEvents) as t.ServerSentEvent[];
      } catch {
        replayEvents = [];
      }
    }

    const stepId = getReplayStepId(event);
    const eventName = 'event' in event ? event.event : undefined;
    const existingIndex =
      stepId == null
        ? -1
        : replayEvents.findIndex((candidate) => {
            if (!('event' in candidate) || candidate.event !== eventName) {
              return false;
            }
            return getReplayStepId(candidate) === stepId;
          });

    if (existingIndex >= 0) {
      replayEvents[existingIndex] = event;
    } else {
      replayEvents.push(event);
    }

    await this.jobStore.updateJob(
      streamId,
      { replayEvents: JSON.stringify(replayEvents) },
      generationId,
    );
  }

  /**
   * Persist user message metadata from the created event.
   * Awaited in emitChunk so the HSET commits before the PUBLISH,
   * guaranteeing any cross-replica getJob() after the pub/sub window
   * finds userMessage in Redis.
   */
  private async trackUserMessage(
    streamId: string,
    event: t.ServerSentEvent,
    generationId?: string,
  ): Promise<void> {
    if (!('created' in event)) {
      return;
    }

    const { message } = event;
    const updates: Partial<SerializableJobData> = {
      createdEventEmitted: true,
      userMessage: {
        messageId: message.messageId,
        parentMessageId: message.parentMessageId,
        conversationId: message.conversationId,
        text: message.text,
        quotes: message.quotes,
      },
    };

    if (message.conversationId) {
      updates.conversationId = message.conversationId;
    }

    await this.jobStore.updateJob(streamId, updates, generationId);
  }

  /**
   * Update job metadata.
   */
  async updateMetadata(
    streamId: string,
    metadata: Partial<t.GenerationJobMetadata>,
    generationId?: string,
  ): Promise<void> {
    // [knauf] Metadata from a detached generation cannot overwrite the current turn.
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    const updates: Partial<SerializableJobData> = {};
    if (metadata.responseMessageId) {
      updates.responseMessageId = metadata.responseMessageId;
    }
    if (metadata.sender) {
      updates.sender = metadata.sender;
    }
    if (metadata.conversationId) {
      updates.conversationId = metadata.conversationId;
    }
    if (metadata.userMessage) {
      updates.userMessage = metadata.userMessage;
    }
    if (metadata.endpoint) {
      updates.endpoint = metadata.endpoint;
    }
    if (metadata.iconURL) {
      updates.iconURL = metadata.iconURL;
    }
    if (metadata.model) {
      updates.model = metadata.model;
    }
    if (metadata.promptTokens !== undefined) {
      updates.promptTokens = metadata.promptTokens;
    }
    await this.jobStore.updateJob(streamId, updates, ownerGenerationId);
    // End [knauf]
  }

  /**
   * Set reference to the graph's contentParts array.
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    generationId?: string,
  ): void {
    // Use runtime state check for performance (sync check)
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    if (!this.getRuntimeState(streamId, ownerGenerationId)) {
      return;
    }
    this.jobStore.setContentParts(streamId, contentParts, ownerGenerationId);
  }

  /**
   * Set reference to the collectedUsage array.
   * This array accumulates token usage from all models during generation.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    generationId?: string,
  ): void {
    // Use runtime state check for performance (sync check)
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    if (!this.getRuntimeState(streamId, ownerGenerationId)) {
      return;
    }
    this.jobStore.setCollectedUsage(streamId, collectedUsage, ownerGenerationId);
  }

  /**
   * Set reference to the graph instance.
   */
  setGraph(streamId: string, graph: StandardGraph, generationId?: string): void {
    // Use runtime state check for performance (sync check)
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    if (!this.getRuntimeState(streamId, ownerGenerationId)) {
      return;
    }
    this.jobStore.setGraph(streamId, graph, ownerGenerationId);
  }

  /**
   * Get resume state for reconnecting clients.
   */
  async getResumeState(
    streamId: string,
    generationId?: string,
    requireGenerationMatch: boolean = generationId !== undefined,
  ): Promise<t.ResumeState | null> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData || (requireGenerationMatch && jobData.generationId !== generationId)) {
      return null;
    }

    // [knauf] Resume reads the same generation snapshot as the job metadata.
    const result = await this.jobStore.getContentParts(streamId, jobData.generationId);
    const aggregatedContent = result?.content ?? [];
    const runSteps = await this.jobStore.getRunSteps(streamId, jobData.generationId);
    // End [knauf]
    let titleEvent: t.ResumeState['titleEvent'];
    if (jobData.titleEvent) {
      try {
        titleEvent = JSON.parse(jobData.titleEvent) as t.ResumeState['titleEvent'];
      } catch {
        // Ignore malformed persisted title events.
      }
    }
    let replayEvents: t.ResumeState['replayEvents'];
    if (jobData.replayEvents) {
      try {
        replayEvents = JSON.parse(jobData.replayEvents) as t.ResumeState['replayEvents'];
      } catch {
        // Ignore malformed persisted replay events.
      }
    }

    let contextUsage: t.ResumeState['contextUsage'];
    if (jobData.contextUsage) {
      try {
        contextUsage = JSON.parse(jobData.contextUsage) as t.ResumeState['contextUsage'];
      } catch {
        // Ignore malformed persisted context usage.
      }
    }

    /** Persisted per model call by trackTokenUsage — unlike the live
     *  collectedUsage reference, this survives cross-replica resumes. */
    let collectedUsage: t.ResumeState['collectedUsage'];
    if (jobData.tokenUsage) {
      try {
        const parsed = JSON.parse(jobData.tokenUsage) as t.ResumeState['collectedUsage'];
        collectedUsage = parsed && parsed.length > 0 ? parsed : undefined;
      } catch {
        // Ignore malformed persisted token usage.
      }
    }

    logger.debug(`[GenerationJobManager] getResumeState:`, {
      streamId,
      runStepsLength: runSteps.length,
      aggregatedContentLength: aggregatedContent.length,
      collectedUsageLength: collectedUsage?.length ?? 0,
    });

    return {
      runSteps,
      aggregatedContent,
      userMessage: jobData.userMessage,
      responseMessageId: jobData.responseMessageId,
      conversationId: jobData.conversationId,
      sender: jobData.sender,
      iconURL: jobData.iconURL,
      model: jobData.model,
      titleEvent,
      replayEvents,
      collectedUsage,
      contextUsage,
    };
  }

  /**
   * Mark that sync has been sent.
   * Persists to Redis for cross-replica consistency.
   */
  markSyncSent(streamId: string, generationId?: string): void {
    // [knauf] Fence sync state to the subscribed generation.
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    const runtime = this.getRuntimeState(streamId, ownerGenerationId);
    if (runtime) {
      runtime.syncSent = true;
    }
    // Persist to Redis for cross-replica consistency
    this.jobStore.updateJob(streamId, { syncSent: true }, ownerGenerationId).catch((err) => {
      logger.error(`[GenerationJobManager] Failed to persist syncSent flag:`, err);
    });
    // End [knauf]
  }

  /**
   * Check if sync has been sent.
   * Checks local runtime first, then falls back to Redis for cross-replica scenarios.
   */
  async wasSyncSent(streamId: string): Promise<boolean> {
    const localSyncSent = this.runtimeState.get(streamId)?.syncSent;
    if (localSyncSent !== undefined) {
      return localSyncSent;
    }
    // Cross-replica: check Redis
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.syncSent ?? false;
  }

  /**
   * Emit a done event.
   * Persists finalEvent to Redis for cross-replica access.
   */
  async emitDone(streamId: string, event: t.ServerSentEvent, generationId?: string): Promise<void> {
    // [knauf] Capture and close one generation before any asynchronous terminal work.
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    const runtime = this.getRuntimeState(streamId, ownerGenerationId);
    if (runtime) {
      runtime.terminal = true;
    }
    const transition = await this.transitionToTerminal(
      streamId,
      'complete',
      { finalEvent: JSON.stringify(event) },
      ownerGenerationId,
    );
    if (!transition.won) {
      return;
    }
    if (runtime) {
      runtime.finalEvent = event;
      runtime.terminalTransition = {
        status: 'complete',
        terminalId: transition.terminalId,
      };
    }
    try {
      await this.eventTransport.emitDone(streamId, event, ownerGenerationId);
    } catch (publishError) {
      logger.error('[GenerationJobManager] Completed state committed but publish failed', {
        streamId,
        generationId: ownerGenerationId,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
    // End [knauf]
  }

  /**
   * Emit an error event.
   * Stores the error for late-connecting subscribers (race condition where error
   * occurs before client connects to SSE stream).
   */
  async emitError(streamId: string, error: string, generationId?: string): Promise<void> {
    // [knauf] Errors terminate only the generation that raised them.
    const ownerGenerationId = this.resolveGenerationId(streamId, generationId);
    const runtime = this.getRuntimeState(streamId, ownerGenerationId);
    if (runtime) {
      runtime.terminal = true;
    }
    const transition = await this.transitionToTerminal(
      streamId,
      'error',
      { error },
      ownerGenerationId,
    );
    if (!transition.won) {
      return;
    }
    if (runtime) {
      runtime.errorEvent = error;
      runtime.terminalTransition = { status: 'error', terminalId: transition.terminalId };
    }
    try {
      await this.eventTransport.emitError(streamId, error, ownerGenerationId);
    } catch (publishError) {
      logger.error('[GenerationJobManager] Error state committed but publish failed', {
        streamId,
        generationId: ownerGenerationId,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
    }
    // End [knauf]
  }

  /**
   * Cleanup expired jobs.
   * Also cleans up any orphaned runtime state, buffers, and event transport entries.
   */
  private async cleanup(): Promise<void> {
    const count = await this.jobStore.cleanup();
    let runningJobsChanged = false;

    // Cleanup runtime state for deleted jobs
    // [knauf] Cleanup must target the generation it inspected, never the current stream owner.
    for (const [streamId, runtime] of this.runtimeState) {
      const generationId = runtime.generationId;
      if (!(await this.jobStore.hasJob(streamId, generationId))) {
        /**
         * Abort any still-pending generation whose job has been reaped (e.g. a
         * stale "running" job removed by the store's failsafe timeout). This
         * unwinds the hung in-flight work so its client/graph references can be
         * garbage collected, rather than leaking via the pending promise.
         */
        if (!runtime.abortController.signal.aborted) {
          runtime.abortController.abort();
        }
        // If a client is still attached when the job is reaped, send a terminal
        // error first so the SSE connection closes instead of hanging open with no
        // final/done event (the route only ends the response from onDone/onError).
        if (this.eventTransport.getSubscriberCount(streamId, generationId) > 0) {
          try {
            await this.eventTransport.emitError(streamId, REAPED_JOB_ERROR, generationId);
          } catch (err) {
            logger.error(`[GenerationJobManager] Failed to notify reaped stream ${streamId}:`, err);
          }
        }
        if (this.runtimeState.get(streamId) === runtime) {
          this.runtimeState.delete(streamId);
          runningJobsChanged = this.runningJobs.delete(streamId) || runningJobsChanged;
        }
        const ownerKey = this.generationKey(streamId, generationId);
        this.runStepBuffers?.delete(ownerKey);
        this.replayEventWriteQueues.delete(ownerKey);
        this.tokenUsageWriteQueues.delete(ownerKey);
        this.jobStore.clearContentState(streamId, generationId);
        this.eventTransport.cleanup(streamId, generationId);
      }
    }

    // Check eventTransport for orphaned streams (e.g., connections dropped without clean close)
    // These are streams that exist in eventTransport but have no corresponding job
    const trackedGenerations =
      this.eventTransport.getTrackedGenerations?.() ??
      this.eventTransport.getTrackedStreamIds().map((streamId) => ({ streamId }));
    for (const { streamId, generationId } of trackedGenerations) {
      if (
        !(await this.jobStore.hasJob(streamId, generationId)) &&
        !this.getRuntimeState(streamId, generationId)
      ) {
        this.eventTransport.cleanup(streamId, generationId);
      }
    }
    // End [knauf]

    if (runningJobsChanged) {
      this.syncRunningJobMetrics();
    }

    if (count > 0) {
      logger.debug(`[GenerationJobManager] Cleaned up ${count} expired jobs`);
    }
  }

  /**
   * Get stream info for status endpoint.
   */
  async getStreamInfo(streamId: string): Promise<{
    active: boolean;
    status: t.GenerationJobStatus;
    aggregatedContent?: Agents.MessageContentComplex[];
    createdAt: number;
  } | null> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return null;
    }

    const result = await this.jobStore.getContentParts(streamId, jobData.generationId);
    const aggregatedContent = result?.content ?? [];

    return {
      active: jobData.status === 'running',
      status: jobData.status as t.GenerationJobStatus,
      aggregatedContent,
      createdAt: jobData.createdAt,
    };
  }

  /**
   * Get total job count.
   */
  async getJobCount(): Promise<number> {
    return this.jobStore.getJobCount();
  }

  /** Returns sizes of internal runtime maps for diagnostics */
  getRuntimeStats(): {
    runtimeStateSize: number;
    runStepBufferSize: number;
    eventTransportStreams: number;
  } {
    return {
      runtimeStateSize: this.runtimeState.size,
      runStepBufferSize: this.runStepBuffers?.size ?? 0,
      eventTransportStreams: this.eventTransport.getTrackedStreamIds().length,
    };
  }

  /**
   * Get job count by status.
   */
  async getJobCountByStatus(): Promise<Record<t.GenerationJobStatus, number>> {
    const [running, complete, error, aborted] = await Promise.all([
      this.jobStore.getJobCountByStatus('running'),
      this.jobStore.getJobCountByStatus('complete'),
      this.jobStore.getJobCountByStatus('error'),
      this.jobStore.getJobCountByStatus('aborted'),
    ]);
    return { running, complete, error, aborted };
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsForUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.jobStore.getActiveJobIdsByUser(userId, tenantId);
  }

  /**
   * Destroy the manager.
   * Cleans up all resources including runtime state, buffers, and stores.
   */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    await this.jobStore.destroy();
    this.eventTransport.destroy();
    this.runtimeState.clear();
    this.runningJobs.clear();
    this.syncRunningJobMetrics();
    this.runStepBuffers?.clear();
    this.replayEventWriteQueues.clear();
    this.tokenUsageWriteQueues.clear();

    logger.debug('[GenerationJobManager] Destroyed');
  }
}

export const GenerationJobManager: GenerationJobManagerClass = new GenerationJobManagerClass();
export { GenerationJobManagerClass };

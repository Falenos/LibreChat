import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';

/**
 * Job status enum
 */
export type JobStatus = 'running' | 'complete' | 'error' | 'aborted';
export type TerminalJobStatus = Exclude<JobStatus, 'running'>;

// [knauf] Generation ownership prevents stale pods from mutating a later turn.
export interface GenerationRef {
  streamId: string;
  generationId?: string;
}

export const GENERATION_CONFLICT_CODE = 'generation_already_running';

export class GenerationConflictError extends Error {
  readonly code: typeof GENERATION_CONFLICT_CODE = GENERATION_CONFLICT_CODE;

  constructor(readonly streamId: string) {
    super(`A generation is already running for stream ${streamId}`);
    this.name = 'GenerationConflictError';
  }
}
// End [knauf]

/**
 * Serializable job data - no object references, suitable for Redis/external storage
 */
export interface SerializableJobData {
  streamId: string;
  // [knauf] Immutable owner token for this conversation turn.
  generationId?: string;
  // End [knauf]
  userId: string;
  tenantId?: string;
  status: JobStatus;
  createdAt: number;
  completedAt?: number;
  conversationId?: string;
  error?: string;
  /** Unique token for the caller that atomically committed the terminal state. */
  terminalId?: string;
  /** Set by the owning worker after it observes a durable terminal transition. */
  terminalAcknowledged?: boolean;

  /** User message metadata */
  userMessage?: {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
    /** Quoted excerpts referenced on this turn, carried so resumable/aborted
     *  reconstructions of the user message keep their `MessageQuotes`. */
    quotes?: string[];
  };

  /** Response message ID for reconnection */
  responseMessageId?: string;

  /** Whether the user-message created event has been emitted */
  createdEventEmitted?: boolean;

  /** Sender name for UI display */
  sender?: string;

  /** Whether sync has been sent to a client */
  syncSent: boolean;

  /** Serialized final event for replay */
  finalEvent?: string;

  /** Serialized title event for replay during active-stream resume */
  titleEvent?: string;

  /** Serialized replay-only stream events for active-stream resume */
  replayEvents?: string;

  /** Serialized latest context usage snapshot for active-stream resume */
  contextUsage?: string;

  /** Serialized token usage events for active-stream resume (cross-replica safe) */
  tokenUsage?: string;

  /** Endpoint metadata for abort handling - avoids storing functions */
  endpoint?: string;
  iconURL?: string;
  model?: string;
  promptTokens?: number;
}

/**
 * Usage metadata for token spending across different LLM providers.
 *
 * This interface supports two mutually exclusive cache token formats:
 *
 * **OpenAI format** (GPT-4, o1, etc.):
 * - Uses `input_token_details.cache_creation` and `input_token_details.cache_read`
 * - Cache tokens are nested under the `input_token_details` object
 *
 * **Anthropic format** (Claude models):
 * - Uses `cache_creation_input_tokens` and `cache_read_input_tokens`
 * - Cache tokens are top-level properties
 *
 * When processing usage data, check both formats:
 * ```typescript
 * const cacheCreation = usage.input_token_details?.cache_creation
 *   || usage.cache_creation_input_tokens || 0;
 * ```
 */
export interface UsageMetadata {
  /** Logical usage bucket for accounting/reporting. Defaults to model response usage. */
  usage_type?: 'message' | 'summarization' | 'subagent' | 'sequential';
  /** Total input tokens (prompt tokens) */
  input_tokens?: number;
  /** Total output tokens (completion tokens) */
  output_tokens?: number;
  /** Total billed tokens when provided by the model/runtime */
  total_tokens?: number;
  /** Model identifier that generated this usage */
  model?: string;
  /** Provider identifier that generated this usage */
  provider?: string;
  /** Agent that produced this usage (graph agent id / subagent agent id). Lets
   *  multi-endpoint graphs price each call with its own endpoint token config. */
  agentId?: string;
  /**
   * OpenAI-style cache token details.
   * Present for OpenAI models (GPT-4, o1, etc.)
   */
  input_token_details?: {
    /** Tokens written to cache */
    cache_creation?: number;
    /** Tokens read from cache */
    cache_read?: number;
  };
  /**
   * Anthropic-style cache creation tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_creation_input_tokens?: number;
  /**
   * Anthropic-style cache read tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_read_input_tokens?: number;
  /**
   * Breakdown of output token counts. Per the LangChain core contract,
   * `output_tokens` is the sum of all output token types — these fields
   * are subsets of `output_tokens`, *not* additional charges.
   */
  output_token_details?: {
    /** Reasoning/thinking tokens generated as chain-of-thought (o1, Gemini thinking, etc.) */
    reasoning?: number;
    audio?: number;
  };
}

/**
 * Result returned from aborting a job - contains all data needed
 * for token spending and message saving without storing callbacks
 */
export interface AbortResult {
  /** Whether the abort was successful */
  success: boolean;
  /** The job data at time of abort */
  jobData: SerializableJobData | null;
  /** Aggregated content from the stream */
  content: Agents.MessageContentComplex[];
  /** Final event to send to client */
  finalEvent: unknown;
  /** Concatenated text from all content parts for token counting fallback */
  text: string;
  /** Collected usage metadata from all models for token spending */
  collectedUsage: UsageMetadata[];
}

/**
 * Resume state for reconnecting clients
 */
export interface ResumeState {
  runSteps: Agents.RunStep[];
  aggregatedContent: Agents.MessageContentComplex[];
  userMessage?: SerializableJobData['userMessage'];
  responseMessageId?: string;
  conversationId?: string;
  sender?: string;
  iconURL?: string;
  model?: string;
  titleEvent?: {
    event: 'title';
    data?: {
      conversationId?: string;
      title?: string;
    };
  };
  replayEvents?: Array<{
    event: string;
    data?: unknown;
    [key: string]: unknown;
  }>;
}

/**
 * Interface for job storage backend.
 * Implementations can use in-memory Map, Redis, KV store, etc.
 *
 * Content state is tied to jobs:
 * - In-memory: Holds WeakRef to graph for live content/run steps access
 * - Redis: Persists chunks, reconstructs content on reconnect
 *
 * This consolidates job metadata + content state into a single interface.
 */
export interface IJobStore {
  /** Initialize the store (e.g., connect to Redis, start cleanup intervals) */
  initialize(): Promise<void>;

  /** Create a new job */
  createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    generationId?: string,
  ): Promise<SerializableJobData>;

  /** Get a job by streamId (streamId === conversationId) */
  getJob(streamId: string): Promise<SerializableJobData | null>;

  /** Update job data */
  updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    generationId?: string,
  ): Promise<void>;

  /**
   * Atomically changes the owning generation from `running` to one terminal state.
   * The status, terminal payload and caller token are committed together, so there
   * is no claim-before-persist crash window and terminal states cannot overwrite
   * each other.
   */
  // [knauf] KK20-338 — one durable CAS owns every terminal transition.
  transitionToTerminal?(
    streamId: string,
    updates: Partial<SerializableJobData> & {
      status: TerminalJobStatus;
      completedAt: number;
      terminalId: string;
    },
    generationId?: string,
  ): Promise<boolean>;

  /**
   * Claims post-transition metrics/cleanup for the exact committed terminal token.
   * A lost claim cannot strand the job because terminal state is already durable.
   */
  claimTerminalEffects?(
    streamId: string,
    terminalId: string,
    generationId?: string,
  ): Promise<boolean>;

  /** Record that the owning worker observed the durable terminal state and stopped. */
  acknowledgeTerminal?(streamId: string, generationId?: string): Promise<void>;
  // End [knauf]

  /** Delete a job */
  deleteJob(streamId: string, generationId?: string): Promise<void>;

  /** Check if job exists */
  hasJob(streamId: string, generationId?: string): Promise<boolean>;

  /** Get all running jobs (for cleanup) */
  getRunningJobs(): Promise<SerializableJobData[]>;

  /** Cleanup expired jobs */
  cleanup(): Promise<number>;

  /**
   * Record generation activity for a job (e.g. a chunk was emitted), refreshing
   * its "last active" timestamp so the stale-running-job failsafe does not reap a
   * stream that is still producing output.
   *
   * In-memory: updates an internal last-activity timestamp used by cleanup().
   * Redis: no-op — the running-job TTL is already refreshed on each appendChunk.
   *
   * @param streamId - The stream identifier
   */
  recordActivity?(streamId: string, generationId?: string): void;

  /** Get total job count */
  getJobCount(): Promise<number>;

  /** Get job count by status */
  getJobCountByStatus(status: JobStatus): Promise<number>;

  /** Destroy the store and release resources */
  destroy(): Promise<void>;

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]>;

  // ===== Content State Methods =====
  // These methods manage volatile content state tied to each job.
  // In-memory: Uses WeakRef to graph for live access
  // Redis: Persists chunks and reconstructs on demand

  /**
   * Set the graph reference for a job (in-memory only).
   * The graph provides live access to contentParts and contentData (run steps).
   *
   * In-memory: Stores WeakRef to graph
   * Redis: No-op (graph not transferable, uses chunks instead)
   *
   * @param streamId - The stream identifier
   * @param graph - The StandardGraph instance
   */
  setGraph(streamId: string, graph: StandardGraph, generationId?: string): void;

  /**
   * Set content parts reference for a job.
   *
   * In-memory: Stores direct reference to content array
   * Redis: No-op (content built from chunks)
   *
   * @param streamId - The stream identifier
   * @param contentParts - The content parts array
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    generationId?: string,
  ): void;

  /**
   * Get aggregated content for a job.
   *
   * In-memory: Returns live content from graph.contentParts or stored reference
   * Redis: Reconstructs from stored chunks
   *
   * @param streamId - The stream identifier
   * @returns Content parts or null if not available
   */
  getContentParts(
    streamId: string,
    generationId?: string,
  ): Promise<{
    content: Agents.MessageContentComplex[];
  } | null>;

  /**
   * Get run steps for a job (for resume state).
   *
   * In-memory: Returns live run steps from graph.contentData
   * Redis: Fetches from persistent storage
   *
   * @param streamId - The stream identifier
   * @returns Run steps or empty array
   */
  getRunSteps(streamId: string, generationId?: string): Promise<Agents.RunStep[]>;

  /**
   * Append a streaming chunk for later reconstruction.
   *
   * In-memory: No-op (content available via graph reference)
   * Redis: Uses XADD for append-only log efficiency
   *
   * @param streamId - The stream identifier
   * @param event - The SSE event to append
   */
  appendChunk(streamId: string, event: unknown, generationId?: string): Promise<void | boolean>;

  /**
   * Clear all content state for a job.
   * Called on job completion/cleanup.
   *
   * @param streamId - The stream identifier
   */
  clearContentState(streamId: string, generationId?: string): void;

  /**
   * Save run steps to persistent storage.
   * In-memory: No-op (run steps accessed via graph reference)
   * Redis: Persists for resume across instances
   *
   * @param streamId - The stream identifier
   * @param runSteps - Run steps to save
   */
  saveRunSteps?(streamId: string, runSteps: Agents.RunStep[], generationId?: string): Promise<void>;

  /**
   * Set collected usage reference for a job.
   * This array accumulates token usage from all models during generation.
   *
   * @param streamId - The stream identifier
   * @param collectedUsage - Array of usage metadata from all models
   */
  setCollectedUsage(streamId: string, collectedUsage: UsageMetadata[], generationId?: string): void;

  /**
   * Get collected usage for a job.
   *
   * @param streamId - The stream identifier
   * @returns Array of usage metadata or empty array
   */
  getCollectedUsage(streamId: string, generationId?: string): UsageMetadata[];
}

/**
 * Interface for pub/sub event transport.
 * Implementations can use EventEmitter, Redis Pub/Sub, etc.
 */
export interface IEventTransport {
  /** Subscribe to events for a stream. `ready` resolves once the transport can receive messages. */
  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    },
    generationId?: string,
  ): { unsubscribe: () => void; ready?: Promise<void> };

  /** Publish a chunk event - returns Promise in Redis mode for ordered delivery */
  emitChunk(streamId: string, event: unknown, generationId?: string): void | Promise<void>;

  /** Publish a done event - returns Promise in Redis mode for ordered delivery */
  emitDone(streamId: string, event: unknown, generationId?: string): void | Promise<void>;

  /** Publish an error event - returns Promise in Redis mode for ordered delivery */
  emitError(streamId: string, error: string, generationId?: string): void | Promise<void>;

  /**
   * Publish an abort signal to all replicas (Redis mode).
   * Enables cross-replica abort: user aborts on Replica B,
   * generating Replica A receives signal and stops.
   * Optional - only implemented in Redis transport.
   */
  emitAbort?(streamId: string, generationId?: string): void | Promise<void>;

  /**
   * Register callback for abort signals from any replica (Redis mode).
   * Called when abort is triggered from any replica.
   * Optional - only implemented in Redis transport.
   */
  onAbort?(streamId: string, callback: () => void, generationId?: string): void;

  /** Get subscriber count for a stream */
  getSubscriberCount(streamId: string, generationId?: string): number;

  /** Check if this is the first subscriber (for ready signaling) */
  isFirstSubscriber(streamId: string, generationId?: string): boolean;

  /** Listen for all subscribers leaving */
  onAllSubscribersLeft(streamId: string, callback: () => void, generationId?: string): void;

  // [knauf] Cross-replica departure, distinct from the process-local signal above.
  /**
   * Register a callback for when NO replica has a subscriber left for this generation,
   * verified against shared state. Distinct from onAllSubscribersLeft, which is local to this
   * process: the generating replica registers here so the partial-response save runs where the
   * handlers live, even when the SSE was served elsewhere. Transports without cross-replica
   * visibility may omit it; in a single process the two signals coincide.
   */
  onGlobalDeparture?(streamId: string, callback: () => void, generationId?: string): void;
  // End [knauf]

  /**
   * Advance subscriber reorder buffer to match publisher sequence (cross-replica safe).
   * @param earlyReplayCount - Number of events replayed from earlyEventBuffer (same-replica).
   *   Pending entries with seq < earlyReplayCount are duplicates and are pruned; entries at or
   *   above are live chunks that arrived during the async GET window and are preserved.
   *   When 0/undefined (cross-replica), all pending entries are treated as live.
   */
  syncReorderBuffer?(
    streamId: string,
    earlyReplayCount?: number,
    generationId?: string,
  ): void | Promise<void>;

  /** Cleanup transport resources for a specific stream */
  cleanup(streamId: string, generationId?: string): void;

  /** Get all tracked stream IDs (for orphan cleanup) */
  getTrackedStreamIds(): string[];

  // [knauf] Lets cleanup fence resources to the generation that owns them.
  getTrackedGenerations?(): GenerationRef[];
  // End [knauf]

  /** Destroy all transport resources */
  destroy(): void;
}

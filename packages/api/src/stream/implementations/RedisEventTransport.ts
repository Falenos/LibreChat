import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Redis, Cluster } from 'ioredis';
import type { GenerationRef, IEventTransport } from '~/stream/interfaces/IJobStore';

/**
 * Redis key prefixes for pub/sub channels
 */
const CHANNELS = {
  /** Main event channel: stream:{streamId}:events (hash tag for cluster compatibility) */
  events: (streamId: string) => `stream:{${streamId}}:events`,
  /** Shared heartbeat channel exercises the actual dedicated Pub/Sub socket. */
  keepalive: 'stream:subscriber:keepalive',
};

/**
 * Redis keys for shared state (hash-tagged for cluster slot compatibility)
 */
const KEYS = {
  // [knauf] Sequence ownership follows an immutable generation while legacy jobs keep their key.
  sequence: (streamId: string, generationId?: string) =>
    generationId != null
      ? `stream:{${streamId}}:generation:${generationId}:seq`
      : `stream:{${streamId}}:seq`,
  /**
   * Which replicas currently hold a viewer for a generation: a ZSET with one member per replica,
   * scored by the Redis server clock at that replica's last heartbeat. A dead replica stops
   * heartbeating and is pruned by score; it never has to say goodbye. Renamed from the scalar
   * `:subscribers` counter so a rolling deploy cannot hit WRONGTYPE on a shared key.
   */
  leases: (streamId: string, generationId?: string) =>
    generationId != null
      ? `stream:{${streamId}}:generation:${generationId}:leases`
      : `stream:{${streamId}}:leases`,
  /**
   * Bumped each time membership revives from zero. Its presence is the evidence that a viewer once
   * attached — Redis deletes an empty sorted set, so the set alone cannot distinguish "everyone
   * left" from "nobody ever came" — and its value scopes "announce once" to one membership epoch.
   */
  leaseEpoch: (streamId: string, generationId?: string) =>
    generationId != null
      ? `stream:{${streamId}}:generation:${generationId}:leases:epoch`
      : `stream:{${streamId}}:leases:epoch`,
  // End [knauf]
};

/**
 * Event types for pub/sub messages
 */
const EventTypes = {
  CHUNK: 'chunk',
  DONE: 'done',
  ERROR: 'error',
  ABORT: 'abort',
  // [knauf] A replica that dropped its last viewer asks the observer to re-check membership.
  // Distinct from the retired 'all_subscribers_left' command so mixed-version pods ignore each other.
  DEPARTURE_CHECK: 'departure_check',
  // End [knauf]
} as const;

interface PubSubMessage {
  type: (typeof EventTypes)[keyof typeof EventTypes];
  // [knauf] Additive wire field; old pods ignore it and legacy jobs omit it.
  generationId?: string;
  // End [knauf]
  /** Sequence number for ordering (critical for Redis Cluster) */
  seq?: number;
  data?: unknown;
  error?: string;
}

/**
 * Reorder buffer state for a stream subscription.
 * Handles out-of-order message delivery in Redis Cluster mode.
 */
interface ReorderBuffer {
  /** Next expected sequence number */
  nextSeq: number;
  /** Buffered messages waiting for earlier sequences */
  pending: Map<number, PubSubMessage>;
  /** Timeout handle for flushing stale messages */
  flushTimeout: ReturnType<typeof setTimeout> | null;
}

/** Max time (ms) to wait for out-of-order messages before force-flushing */
const REORDER_TIMEOUT_MS = 500;
/** Max messages to buffer before force-flushing (prevents memory issues) */
const MAX_BUFFER_SIZE = 100;

/**
 * Subscriber state for a stream
 */
interface StreamSubscribers {
  // [knauf] State belongs to one generation even though generations share the Redis channel.
  streamId: string;
  generationId?: string;
  // End [knauf]
  count: number;
  handlers: Map<
    string,
    {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    }
  >;
  allSubscribersLeftCallbacks: Array<() => void>;
  /** Fired when NO replica has a viewer left, verified against Redis. Owner-registered. */
  globalDepartureCallbacks: Array<() => void>;
  /** Abort callbacks - called when abort signal is received from any replica */
  abortCallbacks: Array<() => void>;
  /** Reorder buffer for handling out-of-order delivery in Redis Cluster */
  reorderBuffer: ReorderBuffer;
}

/**
 * Redis Pub/Sub implementation of IEventTransport.
 * Enables real-time event delivery across multiple instances.
 *
 * Architecture (inspired by https://upstash.com/blog/resumable-llm-streams):
 * - Publisher: Emits events to Redis channel when chunks arrive
 * - Subscriber: Listens to Redis channel and forwards to SSE clients
 * - Decoupled: Generator and consumer don't need direct connection
 *
 * Note: Requires TWO Redis connections - one for publishing, one for subscribing.
 * This is a Redis limitation: a client in subscribe mode can't publish.
 *
 * @example
 * ```ts
 * const transport = new RedisEventTransport(publisherClient, subscriberClient);
 * transport.subscribe(streamId, { onChunk: (e) => res.write(e) });
 * transport.emitChunk(streamId, { text: 'Hello' });
 * ```
 */
export class RedisEventTransport implements IEventTransport {
  /** Redis client for publishing events */
  private publisher: Redis | Cluster;
  /** Redis client for subscribing to events (separate connection required) */
  private subscriber: Redis | Cluster;
  // [knauf] Per-generation state prevents overlapping turns on one conversation from crossing.
  private generations = new Map<string, StreamSubscribers>();
  private streamGenerations = new Map<string, Set<string>>();
  // End [knauf]
  /** Track channel subscription state: resolved promise = active, pending = in-flight */
  private channelSubscriptions = new Map<string, Promise<void>>();
  // [knauf] KK20-338 — heartbeat traffic must traverse the Pub/Sub socket.
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private destroyed = false;
  // End [knauf]
  /** Counter for generating unique subscriber IDs */
  private subscriberIdCounter = 0;

  // [knauf] Lease bookkeeping. `instanceId` is this replica's ZSET member. One timer per
  // generation heartbeats a held lease and/or sweeps for a lapsed last viewer. `departureChecks`
  // is the in-flight guard; `departureFiredEpoch` makes "announce once" mean once per epoch;
  // `leaseGraceUntil` refuses to honour a zero right after a Redis gap, when every lease looks
  // dead at once. See the lease section below for the two-signal contract.
  private readonly instanceId = randomUUID();
  private leaseTimers = new Map<string, NodeJS.Timeout>();
  private departureChecks = new Set<string>();
  private departureFiredEpoch = new Map<string, number>();
  private leaseGraceUntil = 0;
  private readonly leaseTtlMs: number;
  private readonly leaseSweepMs: number;
  private readonly leaseEvidenceTtlMs: number;
  // End [knauf]

  /**
   * Create a new Redis event transport.
   *
   * @param publisher - Redis client for publishing (can be shared)
   * @param subscriber - Redis client for subscribing (must be dedicated)
   */
  constructor(
    publisher: Redis | Cluster,
    subscriber: Redis | Cluster,
    options?: {
      keepaliveIntervalSeconds?: number;
      /** How long a replica's lease survives without a heartbeat before it counts as dead. */
      leaseTtlMs?: number;
      /** Heartbeat and departure-sweep period. Must sit well inside leaseTtlMs; derived if omitted. */
      leaseSweepMs?: number;
      /** How long the "a viewer once attached" evidence outlives the leases themselves. */
      leaseEvidenceTtlMs?: number;
    },
  ) {
    this.publisher = publisher;
    this.subscriber = subscriber;

    // [knauf] Lease timings. The sweep is forced inside the TTL: a sweep at or past the TTL lets a
    // live lease appear and lapse entirely between two ticks, which evicts a live viewer.
    this.leaseTtlMs = options?.leaseTtlMs ?? RedisEventTransport.DEFAULT_LEASE_TTL_MS;
    const requestedSweep = options?.leaseSweepMs ?? Math.floor(this.leaseTtlMs / 3);
    if (requestedSweep >= this.leaseTtlMs) {
      logger.warn(
        `[RedisEventTransport] leaseSweepMs ${requestedSweep} must be below leaseTtlMs ${this.leaseTtlMs}; using a third of the TTL.`,
      );
    }
    this.leaseSweepMs =
      requestedSweep >= this.leaseTtlMs ? Math.floor(this.leaseTtlMs / 3) : requestedSweep;
    this.leaseEvidenceTtlMs =
      options?.leaseEvidenceTtlMs ?? RedisEventTransport.DEFAULT_LEASE_EVIDENCE_TTL_MS;
    // End [knauf]

    // Set up message handler for all subscriptions
    this.subscriber.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    const keepaliveIntervalSeconds = options?.keepaliveIntervalSeconds ?? 0;
    if (keepaliveIntervalSeconds > 0) {
      this.subscriber
        .subscribe(CHANNELS.keepalive)
        .then(() => {
          if (this.destroyed) {
            this.subscriber.unsubscribe(CHANNELS.keepalive).catch(() => {});
            return;
          }
          this.keepaliveInterval = setInterval(() => {
            this.publisher.publish(CHANNELS.keepalive, '1').catch((error) => {
              logger.error('[RedisEventTransport] Subscriber heartbeat failed:', error);
            });
          }, keepaliveIntervalSeconds * 1000);
          this.keepaliveInterval.unref?.();
        })
        .catch((error) => {
          logger.error('[RedisEventTransport] Failed to subscribe to heartbeat channel:', error);
        });
    }
  }

  // [knauf] Allocate a sequence and its safety TTL in one Redis operation so a disconnect
  // cannot leave a permanent generation key between INCR and EXPIRE.
  private static readonly NEXT_SEQUENCE_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

  /** Safety-net TTL set for new or legacy no-expiry counters. Never refreshed while valid. */
  private static readonly SEQUENCE_TTL_SECONDS = 86400;
  // End [knauf]

  // [knauf] Keep lifecycle and subscription state generation-scoped on the shared channel.
  private generationKey(streamId: string, generationId?: string): string {
    return JSON.stringify([streamId, generationId ?? null]);
  }

  private getGeneration(streamId: string, generationId?: string): StreamSubscribers | undefined {
    return this.generations.get(this.generationKey(streamId, generationId));
  }

  private getOrCreateGeneration(streamId: string, generationId?: string): StreamSubscribers {
    const key = this.generationKey(streamId, generationId);
    let state = this.generations.get(key);
    if (state) {
      return state;
    }

    state = {
      streamId,
      generationId,
      count: 0,
      handlers: new Map(),
      allSubscribersLeftCallbacks: [],
      globalDepartureCallbacks: [],
      abortCallbacks: [],
      reorderBuffer: {
        nextSeq: 0,
        pending: new Map(),
        flushTimeout: null,
      },
    };
    this.generations.set(key, state);

    let keys = this.streamGenerations.get(streamId);
    if (!keys) {
      keys = new Set();
      this.streamGenerations.set(streamId, keys);
    }
    keys.add(key);
    return state;
  }

  private deleteGeneration(streamId: string, generationId?: string): void {
    const key = this.generationKey(streamId, generationId);
    this.generations.delete(key);
    const keys = this.streamGenerations.get(streamId);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.streamGenerations.delete(streamId);
    }
  }

  private streamNeedsSubscription(streamId: string): boolean {
    const keys = this.streamGenerations.get(streamId);
    if (!keys) {
      return false;
    }
    for (const key of keys) {
      const state = this.generations.get(key);
      // A departure observer keeps the channel open: it hears re-check hints over it.
      if (
        state &&
        (state.count > 0 ||
          state.abortCallbacks.length > 0 ||
          state.globalDepartureCallbacks.length > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  private ensureChannelSubscription(streamId: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    let ready = this.channelSubscriptions.get(channel);
    if (!ready) {
      ready = this.subscriber
        .subscribe(channel)
        .then(() => {
          logger.debug(`[RedisEventTransport] Subscription active for channel ${channel}`);
        })
        .catch((err) => {
          this.channelSubscriptions.delete(channel);
          logger.error(`[RedisEventTransport] Failed to subscribe to ${channel}:`, err);
        });
      this.channelSubscriptions.set(channel, ready);
    }
    return ready;
  }

  private unsubscribeChannelIfUnused(streamId: string): void {
    const channel = CHANNELS.events(streamId);
    if (this.streamNeedsSubscription(streamId) || !this.channelSubscriptions.has(channel)) {
      return;
    }
    this.subscriber.unsubscribe(channel).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to unsubscribe from ${channel}:`, err);
    });
    this.channelSubscriptions.delete(channel);
  }
  // End [knauf]

  /**
   * Get next sequence number for a stream (0-indexed, backed by Redis INCR).
   * A 24-hour TTL is set on the first INCR, or repaired when a legacy counter
   * has no expiry. It is never refreshed while valid, so an active stream cannot
   * have its counter reset mid-generation.
   * Generation-scoped counters expire by TTL; cleanup never deletes shared ordering state.
   */
  private async getNextSequence(streamId: string, generationId?: string): Promise<number> {
    const key = KEYS.sequence(streamId, generationId);
    // [knauf] Redis 6-compatible Lua keeps INCR and the first safety TTL atomic while
    // repairing any legacy counter that exists without an expiry.
    const val = Number(
      await this.publisher.eval(
        RedisEventTransport.NEXT_SEQUENCE_SCRIPT,
        1,
        key,
        String(RedisEventTransport.SEQUENCE_TTL_SECONDS),
      ),
    );
    // End [knauf]
    return val - 1;
  }

  // [knauf] ---- leased replica membership ----------------------------------------------------
  //
  // Two signals leave this section, and they are deliberately different:
  //
  //   onAllSubscribersLeft — THIS replica's local viewer count hit zero. Fired synchronously in
  //     unsubscribe(), exactly as the in-memory transport does. It drives per-replica reconnect
  //     bookkeeping (hasSubscriber / syncSent) and must never wait on Redis: a browser reconnects
  //     faster than a round-trip, and gating this on global membership skips syncReorderBuffer
  //     and loses chunks.
  //
  //   onGlobalDeparture — NO replica has a viewer left, verified against Redis. It drives the
  //     partial-response save, so it is registered by the generating replica, which is then the
  //     observer whether or not it ever served a viewer itself. It is announced once per
  //     membership epoch; a reconnect starts a new epoch.
  //
  // Membership is one ZSET member per replica, scored by the Redis server clock so pods with
  // skewed clocks cannot evict each other. A live replica heartbeats its member; a dead one is
  // pruned by score on the next check. The epoch key is bumped whenever membership revives from
  // zero and is the evidence a viewer ever attached — Redis deletes an empty sorted set, so the
  // set cannot carry that evidence itself. Neither key is deleted at zero; both expire.

  /** Join or refresh this replica's lease. Idempotent. Bumps the epoch when reviving from zero. */
  private static readonly TOUCH_LEASE_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if before == 0 then
  redis.call('INCR', KEYS[2])
end
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return {redis.call('ZCARD', KEYS[1]), tonumber(redis.call('GET', KEYS[2]) or '0')}
`;

  /** Release this replica's lease. Leaves the evidence and any peers' leases untouched. */
  private static readonly LEAVE_LEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return {redis.call('ZCARD', KEYS[1])}
`;

  /**
   * Prune lapsed leases and report {seen, remaining, epoch}. `seen` is 0 until a viewer has ever
   * attached, so an observer armed before the first connection cannot fire on an empty world.
   */
  private static readonly CHECK_DEPARTURE_SCRIPT = `
local epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
if epoch == 0 then
  return {0, 0, 0}
end
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]))
return {1, redis.call('ZCARD', KEYS[1]), epoch}
`;

  /** A lease older than this is a dead replica. */
  private static readonly DEFAULT_LEASE_TTL_MS = 30000;
  /** Matches RedisJobStore's running-job failsafe, so the evidence outlives the generation. */
  private static readonly DEFAULT_LEASE_EVIDENCE_TTL_MS = 1200000;

  private async runLeaseScript(
    script: string,
    streamId: string,
    generationId: string | undefined,
    args: string[],
  ): Promise<number[]> {
    const raw = await this.publisher.eval(
      script,
      2,
      KEYS.leases(streamId, generationId),
      KEYS.leaseEpoch(streamId, generationId),
      ...args,
    );
    return (raw as unknown[]).map(Number);
  }

  /** Any failed lease operation means Redis was unreachable and every lease may look dead. */
  private enterLeaseGrace(): void {
    this.leaseGraceUntil = Date.now() + this.leaseTtlMs;
  }

  /** Called when this replica gains its first local viewer, and on every heartbeat after. */
  private touchLease(streamId: string, generationId?: string): void {
    this.runLeaseScript(RedisEventTransport.TOUCH_LEASE_SCRIPT, streamId, generationId, [
      this.instanceId,
      String(this.leaseEvidenceTtlMs),
    ]).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to heartbeat subscriber lease:`, err);
      this.enterLeaseGrace();
    });
  }

  /**
   * Called when this replica loses its last local viewer. If that emptied the set, hint the
   * observer so it checks now instead of on its next sweep — a latency optimisation only; the
   * observer verifies for itself and its sweep catches a lost hint.
   */
  private leaveLease(streamId: string, generationId: string | undefined, announce: boolean): void {
    this.runLeaseScript(RedisEventTransport.LEAVE_LEASE_SCRIPT, streamId, generationId, [
      this.instanceId,
      String(this.leaseEvidenceTtlMs),
    ])
      .then(([remaining]) => {
        if (announce && remaining === 0) {
          this.publishDepartureCheck(streamId, generationId);
        }
      })
      .catch((err) => {
        logger.error(`[RedisEventTransport] Failed to release subscriber lease:`, err);
        this.enterLeaseGrace();
      });
  }

  /**
   * One timer per generation, shared by both roles: a replica holding a viewer heartbeats; a
   * replica observing departures sweeps. Stops itself when neither role applies.
   */
  private ensureLeaseTimer(streamId: string, generationId?: string): void {
    const key = this.generationKey(streamId, generationId);
    if (this.leaseTimers.has(key)) {
      return;
    }
    const timer = setInterval(() => {
      const state = this.getGeneration(streamId, generationId);
      const holdsLease = (state?.count ?? 0) > 0;
      const observes = (state?.globalDepartureCallbacks.length ?? 0) > 0;
      if (!holdsLease && !observes) {
        this.clearLeaseTimer(key);
        return;
      }
      if (holdsLease) {
        this.touchLease(streamId, generationId);
      }
      if (observes) {
        this.runDepartureCheck(streamId, generationId);
      }
    }, this.leaseSweepMs);
    timer.unref?.();
    this.leaseTimers.set(key, timer);
  }

  private clearLeaseTimer(key: string): void {
    const timer = this.leaseTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.leaseTimers.delete(key);
    }
  }

  /** The verified check. Used by the sweep tick and by an incoming hint alike. */
  private runDepartureCheck(streamId: string, generationId?: string): void {
    const key = this.generationKey(streamId, generationId);
    if (!this.getGeneration(streamId, generationId)?.globalDepartureCallbacks.length) {
      return;
    }
    if (this.departureChecks.has(key)) {
      // A check is already in flight; the sweep re-checks within one period anyway.
      return;
    }
    this.departureChecks.add(key);
    this.runLeaseScript(RedisEventTransport.CHECK_DEPARTURE_SCRIPT, streamId, generationId, [
      String(this.leaseTtlMs),
    ])
      .then(([seen, remaining, epoch]) => {
        this.evaluateDeparture(streamId, generationId, seen === 1, remaining, epoch);
      })
      .catch((err) => {
        // Fail closed: a save needs a verified zero. The next sweep tries again.
        logger.error(`[RedisEventTransport] Subscriber departure check failed:`, err);
        this.enterLeaseGrace();
      })
      .finally(() => {
        this.departureChecks.delete(key);
      });
  }

  /**
   * Decide synchronously, with no await between test and claim, so two overlapping checks that
   * both read zero cannot both fire. Fires once per epoch; a revived membership bumps the epoch
   * and re-arms it.
   */
  private evaluateDeparture(
    streamId: string,
    generationId: string | undefined,
    seen: boolean,
    remaining: number,
    epoch: number,
  ): void {
    if (!seen || remaining > 0) {
      return;
    }
    const key = this.generationKey(streamId, generationId);
    if (epoch <= (this.departureFiredEpoch.get(key) ?? 0)) {
      return;
    }
    if (Date.now() < this.leaseGraceUntil) {
      // Recovering from a Redis gap: live replicas have not had a chance to heartbeat yet.
      return;
    }
    this.departureFiredEpoch.set(key, epoch);
    const state = this.getGeneration(streamId, generationId);
    for (const callback of state?.globalDepartureCallbacks ?? []) {
      try {
        callback();
      } catch (err) {
        logger.error(`[RedisEventTransport] Error in globalDeparture callback:`, err);
      }
    }
  }

  private publishDepartureCheck(streamId: string, generationId?: string): void {
    const message: PubSubMessage = { type: EventTypes.DEPARTURE_CHECK, generationId };
    this.publisher.publish(CHANNELS.events(streamId), JSON.stringify(message)).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to publish departure check:`, err);
    });
  }
  // End [knauf]

  /** Reset subscriber reorder buffer state to initial values */
  private resetReorderBuffer(streamId: string, generationId?: string): void {
    const state = this.getGeneration(streamId, generationId);
    if (state) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      state.reorderBuffer.nextSeq = 0;
      state.reorderBuffer.pending.clear();
    }
  }

  /**
   * Advance subscriber reorder buffer to the authoritative Redis sequence counter (cross-replica safe).
   *
   * @param earlyReplayCount - Number of events replayed from earlyEventBuffer (same-replica).
   *   Pending entries with seq < earlyReplayCount are duplicates and are pruned; entries at or
   *   above are live chunks from ongoing generation that arrived during the async GET window.
   *   Using the replay count (not the Redis counter) as the prune cutoff is critical: INCR can
   *   advance the counter past a live chunk's seq during the GET window, so currentSeq is not
   *   a safe proxy for "already delivered via earlyEventBuffer."
   *   When 0/undefined (cross-replica), all pending entries are treated as live and preserved.
   */
  // [knauf] Sync only the generation that owns this subscriber and Redis counter.
  async syncReorderBuffer(
    streamId: string,
    earlyReplayCount = 0,
    generationId?: string,
  ): Promise<void> {
    const key = KEYS.sequence(streamId, generationId);
    const rawStr = await this.publisher.get(key);
    const parsed = rawStr != null ? parseInt(rawStr, 10) : 0;
    const currentSeq = Number.isNaN(parsed) ? 0 : parsed;
    const state = this.getGeneration(streamId, generationId);
    if (state) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      // Prune true duplicates: entries with seq < earlyReplayCount were already delivered
      // via earlyEventBuffer. Entries at or above are live (possibly from ongoing generation).
      if (earlyReplayCount > 0) {
        for (const seq of state.reorderBuffer.pending.keys()) {
          if (seq < earlyReplayCount) {
            state.reorderBuffer.pending.delete(seq);
          }
        }
      }
      // Set nextSeq from remaining state. Never regress — handleOrderedChunk may have
      // already advanced it during the async GET window.
      if (state.reorderBuffer.pending.size === 0) {
        // Same-replica: INCR precedes PUBLISH, so currentSeq may reflect allocated-but-
        // not-yet-delivered events. Cap at earlyReplayCount to avoid skipping in-flight chunks.
        // Cross-replica (earlyReplayCount=0): trust the Redis counter.
        const ceiling = earlyReplayCount > 0 ? earlyReplayCount : currentSeq;
        state.reorderBuffer.nextSeq = Math.max(state.reorderBuffer.nextSeq, ceiling);
      } else {
        let minPending = Infinity;
        for (const seq of state.reorderBuffer.pending.keys()) {
          if (seq < minPending) {
            minPending = seq;
          }
        }
        state.reorderBuffer.nextSeq = Math.max(
          state.reorderBuffer.nextSeq,
          Math.min(currentSeq, minPending),
        );
        this.flushPendingMessages(streamId, state);
      }
      // Re-arm flush timeout if gaps remain after sync — without this,
      // buffered messages could sit indefinitely if no new messages arrive.
      if (state.reorderBuffer.pending.size > 0) {
        this.scheduleFlushTimeout(streamId, state);
      }
    }
  }
  // End [knauf]

  /**
   * Handle incoming pub/sub message with reordering support for Redis Cluster
   */
  private handleMessage(channel: string, message: string): void {
    if (channel === CHANNELS.keepalive) {
      return;
    }
    const match = channel.match(/^stream:\{([^}]+)\}:events$/);
    if (!match) {
      return;
    }
    const streamId = match[1];

    try {
      const parsed = JSON.parse(message) as PubSubMessage;

      // [knauf] Route shared-channel messages only to their owning generation.
      let streamState = this.getGeneration(streamId, parsed.generationId);
      if (!streamState && parsed.type === EventTypes.ABORT && parsed.generationId == null) {
        /** A rolling old pod cannot include the new generation field. If there is
         * exactly one generation abort listener, it is the only safe target. */
        const abortTargets = [...(this.streamGenerations.get(streamId) ?? [])]
          .map((key) => this.generations.get(key))
          .filter((state): state is StreamSubscribers => !!state?.abortCallbacks.length);
        if (abortTargets.length === 1) {
          streamState = abortTargets[0];
        }
      }
      if (!streamState) {
        return;
      }

      // Abort-only listeners must not accumulate another pod's stream ordering state.
      // DEPARTURE_CHECK is addressed precisely at an observer with no local handlers.
      if (
        streamState.handlers.size === 0 &&
        parsed.type !== EventTypes.ABORT &&
        parsed.type !== EventTypes.DEPARTURE_CHECK
      ) {
        if (parsed.type === EventTypes.DONE || parsed.type === EventTypes.ERROR) {
          this.cleanup(streamId, streamState.generationId);
        }
        return;
      }
      // End [knauf]

      if (parsed.type === EventTypes.CHUNK && parsed.seq != null) {
        this.handleOrderedChunk(streamId, streamState, parsed);
      } else if (
        (parsed.type === EventTypes.DONE || parsed.type === EventTypes.ERROR) &&
        parsed.seq != null
      ) {
        this.handleTerminalEvent(streamId, streamState, parsed);
      } else {
        this.deliverMessage(streamState, parsed);
      }
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to parse message:`, err);
    }
  }

  /**
   * Handle terminal events (done/error) with sequence-based ordering.
   * Buffers the terminal event and delivers after all preceding chunks arrive.
   */
  private handleTerminalEvent(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (seq < buffer.nextSeq) {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate terminal event for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
      return;
    }

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;
      this.flushPendingMessages(streamId, streamState);
    } else {
      buffer.pending.set(seq, message);
      this.scheduleFlushTimeout(streamId, streamState);
    }
  }

  /**
   * Handle chunk messages with sequence-based reordering.
   * Buffers out-of-order messages and delivers them in sequence.
   */
  private handleOrderedChunk(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;

      this.flushPendingMessages(streamId, streamState);
    } else if (seq > buffer.nextSeq) {
      buffer.pending.set(seq, message);

      if (buffer.pending.size >= MAX_BUFFER_SIZE) {
        logger.warn(`[RedisEventTransport] Buffer overflow for stream ${streamId}, force-flushing`);
        this.forceFlushBuffer(streamId, streamState);
      } else {
        this.scheduleFlushTimeout(streamId, streamState);
      }
    } else {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate/old message for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
    }
  }

  /** Deliver consecutive pending messages */
  private flushPendingMessages(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    while (buffer.pending.has(buffer.nextSeq)) {
      const message = buffer.pending.get(buffer.nextSeq)!;
      buffer.pending.delete(buffer.nextSeq);
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;
    }

    if (buffer.pending.size === 0 && buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
  }

  /** Force-flush all pending messages in order (used on timeout or overflow) */
  private forceFlushBuffer(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }

    if (buffer.pending.size === 0) {
      return;
    }

    const sortedSeqs = [...buffer.pending.keys()].sort((a, b) => a - b);
    const skipped = sortedSeqs[0] - buffer.nextSeq;

    if (skipped > 0) {
      logger.warn(
        `[RedisEventTransport] Stream ${streamId}: skipping ${skipped} missing messages (seq ${buffer.nextSeq}-${sortedSeqs[0] - 1})`,
      );
    }

    for (const seq of sortedSeqs) {
      const message = buffer.pending.get(seq)!;
      buffer.pending.delete(seq);
      this.deliverMessage(streamState, message);
    }

    buffer.nextSeq = sortedSeqs[sortedSeqs.length - 1] + 1;
  }

  /** Schedule a timeout to force-flush if gaps aren't filled */
  private scheduleFlushTimeout(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      return;
    }

    buffer.flushTimeout = setTimeout(() => {
      buffer.flushTimeout = null;
      if (buffer.pending.size > 0) {
        logger.warn(
          `[RedisEventTransport] Stream ${streamId}: timeout waiting for seq ${buffer.nextSeq}, force-flushing ${buffer.pending.size} messages`,
        );
        this.forceFlushBuffer(streamId, streamState);
      }
    }, REORDER_TIMEOUT_MS);
  }

  /** Deliver a message to all handlers */
  private deliverMessage(streamState: StreamSubscribers, message: PubSubMessage): void {
    for (const [, handlers] of streamState.handlers) {
      switch (message.type) {
        case EventTypes.CHUNK:
          handlers.onChunk(message.data);
          break;
        case EventTypes.DONE:
          handlers.onDone?.(message.data);
          break;
        case EventTypes.ERROR:
          handlers.onError?.(message.error ?? 'Unknown error');
          break;
        case EventTypes.ABORT:
          break;
        // [knauf]
        case EventTypes.DEPARTURE_CHECK:
          break;
        // End [knauf]
      }
    }

    if (message.type === EventTypes.ABORT) {
      for (const callback of streamState.abortCallbacks) {
        try {
          callback();
        } catch (err) {
          logger.error(`[RedisEventTransport] Error in abort callback:`, err);
        }
      }
    }

    // [knauf] A departure hint is a prompt to verify, never a command to fire.
    if (message.type === EventTypes.DEPARTURE_CHECK) {
      this.runDepartureCheck(streamState.streamId, streamState.generationId);
    }
    // End [knauf]

    // [knauf] A persisted final can recreate state on reconnect; terminal listeners cannot.
    if (message.type === EventTypes.DONE || message.type === EventTypes.ERROR) {
      this.cleanup(streamState.streamId, streamState.generationId);
    }
    // End [knauf]
  }

  /**
   * Subscribe to events for a stream.
   *
   * On first subscriber for a stream, subscribes to the Redis channel.
   * Returns unsubscribe function that cleans up when last subscriber leaves.
   */
  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    },
    generationId?: string,
  ): { unsubscribe: () => void; ready?: Promise<void> } {
    const subscriberId = `sub_${++this.subscriberIdCounter}`;

    // [knauf] Attach this SSE handler to its immutable generation on the shared channel.
    const streamState = this.getOrCreateGeneration(streamId, generationId);
    // Internal listeners (for example cross-replica abort) can leave ordering
    // state behind with no real SSE subscribers. A new subscriber is a fresh
    // attachment and must not inherit that prior generation's expected seq.
    if (streamState.count === 0) {
      this.resetReorderBuffer(streamId, generationId);
      // This replica now holds a viewer for the generation: take its lease and keep it alive.
      this.touchLease(streamId, generationId);
      this.ensureLeaseTimer(streamId, generationId);
    }
    streamState.count++;
    streamState.handlers.set(subscriberId, handlers);
    const readyPromise = this.ensureChannelSubscription(streamId);
    // End [knauf]

    return {
      ready: readyPromise,
      unsubscribe: () => {
        const state = this.getGeneration(streamId, generationId);
        if (!state || !state.handlers.delete(subscriberId)) {
          return;
        }

        state.count--;

        // [knauf] Reset and notify only this generation; retain the channel for any peer generation.
        if (state.count === 0) {
          /**
           * Preserve callbacks for reconnect, but drop ordering state from the
           * previous attachment. Reconnects always call syncReorderBuffer(), so
           * keeping nextSeq here only risks poisoning a later generation when
           * the shared Redis sequence key has already been reset elsewhere.
           */
          this.resetReorderBuffer(streamId, generationId);

          // Local signal, synchronous, identical to the in-memory transport: this replica has no
          // viewer left. Drives reconnect bookkeeping and must not wait on Redis.
          for (const callback of state.allSubscribersLeftCallbacks) {
            try {
              callback();
            } catch (err) {
              logger.error(`[RedisEventTransport] Error in allSubscribersLeft callback:`, err);
            }
          }

          // Global signal, asynchronous: release this replica's lease and hint the observer.
          this.leaveLease(streamId, generationId, true);

          this.unsubscribeChannelIfUnused(streamId);
          /**
           *  Preserve stream state (callbacks, abort handlers) for reconnection.
           *  Previously this deleted the entire state, which lost the
           *  allSubscribersLeftCallbacks and abortCallbacks registered by
           *  GenerationJobManager.createJob(). On the next subscribe() call,
           *  fresh state was created without those callbacks, causing
           *  hasSubscriber to never reset and syncReorderBuffer to be skipped.
           *  State is fully cleaned up by cleanup() when the job completes.
           */
        }
        // End [knauf]
      },
    };
  }

  /**
   * Publish a chunk event to all subscribers across all instances.
   * Includes sequence number for ordered delivery in Redis Cluster mode.
   *
   * Performance: each emit requires two sequential Redis round-trips (INCR + PUBLISH).
   * This is the unavoidable cost of cross-replica sequence coordination.
   */
  // [knauf] Publish every ordered event with its generation token and isolated counter.
  async emitChunk(streamId: string, event: unknown, generationId?: string): Promise<void> {
    try {
      const channel = CHANNELS.events(streamId);
      const seq = await this.getNextSequence(streamId, generationId);
      const message: PubSubMessage = {
        type: EventTypes.CHUNK,
        generationId,
        seq,
        data: event,
      };
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish chunk:`, err);
    }
  }

  /**
   * Publish a done event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitDone(streamId: string, event: unknown, generationId?: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const seq = await this.getNextSequence(streamId, generationId);
    const message: PubSubMessage = { type: EventTypes.DONE, generationId, seq, data: event };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish done:`, err);
      throw err;
    }
  }

  /**
   * Publish an error event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitError(streamId: string, error: string, generationId?: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const seq = await this.getNextSequence(streamId, generationId);
    const message: PubSubMessage = { type: EventTypes.ERROR, generationId, seq, error };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish error:`, err);
      throw err;
    }
  }
  // End [knauf]

  /**
   * Get subscriber count for a stream (local instance only).
   *
   * Note: In a multi-instance setup, this only returns local subscriber count.
   * For global count, would need to track in Redis (e.g., with a counter key).
   */
  // [knauf] Subscriber and callback queries are fenced to one generation.
  getSubscriberCount(streamId: string, generationId?: string): number {
    return this.getGeneration(streamId, generationId)?.count ?? 0;
  }

  /**
   * Check if this is the first subscriber (local instance only).
   */
  isFirstSubscriber(streamId: string, generationId?: string): boolean {
    return this.getSubscriberCount(streamId, generationId) === 1;
  }

  /**
   * Register callback for when all subscribers leave.
   */
  onAllSubscribersLeft(streamId: string, callback: () => void, generationId?: string): void {
    this.getOrCreateGeneration(streamId, generationId).allSubscribersLeftCallbacks.push(callback);
  }

  /**
   * Register for the moment NO replica has a viewer left, verified against Redis. The generating
   * replica registers here and thereby becomes the observer: it listens for re-check hints and
   * sweeps for lapsed leases even if it never serves a viewer itself.
   */
  onGlobalDeparture(streamId: string, callback: () => void, generationId?: string): void {
    this.getOrCreateGeneration(streamId, generationId).globalDepartureCallbacks.push(callback);
    this.ensureChannelSubscription(streamId);
    this.ensureLeaseTimer(streamId, generationId);
  }
  // End [knauf]

  /**
   * Publish an abort signal to all replicas.
   * This enables cross-replica abort: when a user aborts on Replica B,
   * the generating Replica A receives the signal and stops.
   */
  // [knauf] Abort only the generation named on the shared Redis channel.
  async emitAbort(streamId: string, generationId?: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const message: PubSubMessage = { type: EventTypes.ABORT, generationId };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish abort:`, err);
      throw err;
    }
  }

  /**
   * Register callback for abort signals from any replica.
   * Called when abort is triggered on any replica (including this one).
   *
   * @param streamId - The stream identifier
   * @param callback - Called when abort signal is received
   */
  onAbort(streamId: string, callback: () => void, generationId?: string): void {
    this.getOrCreateGeneration(streamId, generationId).abortCallbacks.push(callback);
    this.ensureChannelSubscription(streamId);
  }

  // End [knauf]

  /**
   * Get all tracked stream IDs (for orphan cleanup)
   */
  getTrackedStreamIds(): string[] {
    return Array.from(this.streamGenerations.keys());
  }

  // [knauf] Expose exact owners so manager cleanup cannot target a replacement turn.
  getTrackedGenerations(): GenerationRef[] {
    return Array.from(this.generations.values(), ({ streamId, generationId }) => ({
      streamId,
      generationId,
    }));
  }
  // End [knauf]

  /**
   * Cleanup resources for a specific stream.
   */
  // [knauf] Cleanup one generation only; sequence keys expire instead of racing a newer turn.
  cleanup(streamId: string, generationId?: string): void {
    // Release only THIS replica's lease. Deleting the whole set would evict members other
    // replicas still hold live and manufacture a spurious "everyone left" for the observer.
    const key = this.generationKey(streamId, generationId);
    this.clearLeaseTimer(key);
    this.departureFiredEpoch.delete(key);
    const state = this.getGeneration(streamId, generationId);
    if ((state?.count ?? 0) > 0) {
      this.leaveLease(streamId, generationId, false);
    }

    if (state) {
      state.handlers.clear();
      state.allSubscribersLeftCallbacks = [];
      state.globalDepartureCallbacks = [];
      state.abortCallbacks = [];
    }

    this.resetReorderBuffer(streamId, generationId);
    this.deleteGeneration(streamId, generationId);
    this.unsubscribeChannelIfUnused(streamId);
  }
  // End [knauf]

  /**
   * Destroy all resources.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.subscriber.unsubscribe(CHANNELS.keepalive).catch(() => {});

    // Clear all flush timeouts and buffered messages.
    // Sequence keys are NOT deleted here — they are shared across replicas and
    // generation-scoped counters expire via their 24h safety-net TTL.
    for (const [, state] of this.generations) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      state.reorderBuffer.pending.clear();
    }

    for (const channel of this.channelSubscriptions.keys()) {
      this.subscriber.unsubscribe(channel).catch(() => {});
    }

    // [knauf] A stopping replica must not keep heartbeating leases it can no longer honour, and
    // should let go of them so the observer sees the departure now rather than at the TTL.
    for (const timer of this.leaseTimers.values()) {
      clearInterval(timer);
    }
    this.leaseTimers.clear();
    for (const state of this.generations.values()) {
      if (state.count > 0) {
        this.leaveLease(state.streamId, state.generationId, true);
      }
    }
    this.departureChecks.clear();
    this.departureFiredEpoch.clear();
    // End [knauf]

    this.channelSubscriptions.clear();
    this.generations.clear();
    this.streamGenerations.clear();

    try {
      this.subscriber.disconnect();
    } catch {
      /* ignore */
    }

    logger.info('[RedisEventTransport] Destroyed');
  }
}

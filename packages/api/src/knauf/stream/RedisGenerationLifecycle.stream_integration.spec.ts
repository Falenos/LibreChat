import { logger } from '@librechat/data-schemas';
import type { Redis as RedisClient } from 'ioredis';
import type { ServerSentEvent } from '~/types';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { GENERATION_CONFLICT_CODE } from '~/stream/interfaces/IJobStore';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';
import { createStreamServices } from '~/stream/createStreamServices';

logger.silent = true;

const describeRedis = process.env.USE_REDIS === 'true' ? describe : describe.skip;

describeRedis('Redis generation lifecycle', () => {
  let redis: RedisClient;

  beforeAll(async () => {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
  });

  afterAll(() => {
    redis.disconnect();
  });

  function createManager(): GenerationJobManagerClass {
    const manager = new GenerationJobManagerClass();
    manager.configure(createStreamServices({ useRedis: true, redisClient: redis }));
    return manager;
  }

  /**
   * A replica with its own Redis connections, so a test can sever them to model a pod that dies
   * without any goodbye, and with lease timings short enough to watch a lease actually expire
   * inside the 15s test budget. createManager() shares one client and can model neither.
   */
  function createReplica(lease: { leaseTtlMs: number; leaseSweepMs: number }) {
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    const transport = new RedisEventTransport(pub, sub, lease);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new RedisJobStore(pub),
      eventTransport: transport,
      isRedis: true,
    });
    const stop = async () => {
      await manager.destroy();
      pub.disconnect();
      sub.disconnect();
    };
    return { manager, transport, pub, sub, stop };
  }

  it('delivers the next generation while the previous SSE is still detaching', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-overlap-${Date.now()}`;
    const oldEvents: ServerSentEvent[] = [];
    const nextEvents: ServerSentEvent[] = [];
    const nextDone: ServerSentEvent[] = [];

    await publisher.createJob(streamId, 'user-1', streamId);
    const oldSubscription = await subscriber.subscribe(
      streamId,
      (event) => oldEvents.push(event),
      () => undefined,
    );

    await publisher.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { text: 'old answer' },
    });
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent);
    await publisher.completeJob(streamId);

    await publisher.createJob(streamId, 'user-1', streamId);
    const nextSubscription = await subscriber.subscribe(
      streamId,
      (event) => nextEvents.push(event),
      (event) => nextDone.push(event),
    );
    oldSubscription?.unsubscribe();

    const startedAt = performance.now();
    await publisher.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { text: 'new answer' },
    });
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(oldEvents).toHaveLength(1);
    expect(nextEvents).toEqual([{ event: 'on_message_delta', data: { text: 'new answer' } }]);
    expect(nextDone).toHaveLength(1);
    expect(performance.now() - startedAt).toBeLessThan(400);

    nextSubscription?.unsubscribe();
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('allows only one replica to claim a running conversation', async () => {
    const firstReplica = createManager();
    const secondReplica = createManager();
    const streamId = `knauf-generation-claim-${Date.now()}`;

    const results = await Promise.allSettled([
      firstReplica.createJob(streamId, 'user-1', streamId),
      secondReplica.createJob(streamId, 'user-1', streamId),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.status === 'rejected' ? rejection.reason.code : undefined).toBe(
      GENERATION_CONFLICT_CODE,
    );

    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status === 'fulfilled') {
      await firstReplica.completeJob(streamId, undefined, winner.value.generationId);
      await secondReplica.completeJob(streamId, undefined, winner.value.generationId);
    }
    await firstReplica.destroy();
    await secondReplica.destroy();
  });

  it('cannot let a delayed old lookup replace a newer local runtime', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-runtime-race-${Date.now()}`;
    const oldJob = await publisher.createJob(streamId, 'user-1', streamId);
    const subscriberStore = subscriber.getJobStore();
    const getJob = subscriberStore.getJob.bind(subscriberStore);
    let releaseSnapshot!: () => void;
    let snapshotCaptured!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      snapshotCaptured = resolve;
    });
    let holdOldSnapshot = true;
    subscriberStore.getJob = async (id) => {
      const snapshot = await getJob(id);
      if (holdOldSnapshot) {
        holdOldSnapshot = false;
        snapshotCaptured();
        await snapshotGate;
      }
      return snapshot;
    };

    const staleSubscription = subscriber.subscribe(streamId, () => undefined);
    await captured;
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent, oldJob.generationId);
    const nextJob = await publisher.createJob(streamId, 'user-1', streamId);

    const chunks: ServerSentEvent[] = [];
    const freshSubscription = await subscriber.subscribe(streamId, (event) => chunks.push(event));
    releaseSnapshot();

    expect(await staleSubscription).toBeNull();
    await publisher.emitChunk(
      streamId,
      { event: 'on_message_delta', data: { text: 'new runtime survived' } },
      nextJob.generationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chunks).toEqual([{ event: 'on_message_delta', data: { text: 'new runtime survived' } }]);

    subscriberStore.getJob = getJob;
    freshSubscription?.unsubscribe();
    await publisher.completeJob(streamId, undefined, nextJob.generationId);
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('retries resume when the generation changes during its snapshot', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-resume-race-${Date.now()}`;
    const oldJob = await publisher.createJob(streamId, 'user-1', streamId);
    await publisher.updateMetadata(streamId, { sender: 'old generation' }, oldJob.generationId);

    const subscriberStore = subscriber.getJobStore();
    const getJob = subscriberStore.getJob.bind(subscriberStore);
    let releaseSnapshot!: () => void;
    let snapshotCaptured!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      snapshotCaptured = resolve;
    });
    let reads = 0;
    subscriberStore.getJob = async (id) => {
      const snapshot = await getJob(id);
      reads++;
      if (reads === 2) {
        snapshotCaptured();
        await snapshotGate;
      }
      return snapshot;
    };

    const resume = subscriber.subscribeWithResume(streamId, () => undefined);
    await captured;
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent, oldJob.generationId);
    const nextJob = await publisher.createJob(streamId, 'user-1', streamId);
    await publisher.updateMetadata(streamId, { sender: 'new generation' }, nextJob.generationId);
    releaseSnapshot();

    const result = await resume;
    expect(result.generationId).toBe(nextJob.generationId);
    expect(result.resumeState?.sender).toBe('new generation');

    subscriberStore.getJob = getJob;
    result.subscription?.unsubscribe();
    await publisher.completeJob(streamId, undefined, nextJob.generationId);
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('recovers a terminal event completed before the Redis subscription is ready', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-terminal-gap-${Date.now()}`;
    const job = await publisher.createJob(streamId, 'user-1', streamId);
    const finalEvent = {
      final: true,
      responseMessage: { text: 'answer survived reconnect' },
    } as ServerSentEvent;

    const subscriberStore = subscriber.getJobStore();
    const getJob = subscriberStore.getJob.bind(subscriberStore);
    let releaseLookup!: () => void;
    let lookupCaptured!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      lookupCaptured = resolve;
    });
    let reads = 0;
    subscriberStore.getJob = async (id) => {
      const snapshot = await getJob(id);
      reads++;
      if (reads === 2) {
        lookupCaptured();
        await lookupGate;
      }
      return snapshot;
    };

    const done: ServerSentEvent[] = [];
    const subscriptionPromise = subscriber.subscribe(
      streamId,
      () => undefined,
      (event) => done.push(event),
    );
    await captured;
    await publisher.emitDone(streamId, finalEvent, job.generationId);
    await publisher.completeJob(streamId, undefined, job.generationId);
    releaseLookup();

    const subscription = await subscriptionPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toEqual([finalEvent]);

    subscriberStore.getJob = getJob;
    subscription?.unsubscribe();
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('cancels a subscription whose owner changes during runtime lookup', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-subscribe-owner-${Date.now()}`;
    const oldJob = await publisher.createJob(streamId, 'user-1', streamId);

    const subscriberStore = subscriber.getJobStore();
    const getJob = subscriberStore.getJob.bind(subscriberStore);
    let releaseLookup!: () => void;
    let lookupCaptured!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      lookupCaptured = resolve;
    });
    let reads = 0;
    subscriberStore.getJob = async (id) => {
      const snapshot = await getJob(id);
      reads++;
      if (reads === 2) {
        lookupCaptured();
        await lookupGate;
      }
      return snapshot;
    };

    const staleDone: ServerSentEvent[] = [];
    const staleSubscription = subscriber.subscribe(
      streamId,
      () => undefined,
      (event) => staleDone.push(event),
    );
    await captured;
    await publisher.emitDone(streamId, { final: 'old' } as ServerSentEvent, oldJob.generationId);
    const nextJob = await publisher.createJob(streamId, 'user-1', streamId);
    releaseLookup();

    expect(await staleSubscription).toBeNull();
    expect(staleDone).toEqual([]);

    subscriberStore.getJob = getJob;
    const nextDone: ServerSentEvent[] = [];
    const nextSubscription = await subscriber.subscribe(
      streamId,
      () => undefined,
      (event) => nextDone.push(event),
    );
    await publisher.emitDone(streamId, { final: 'new' } as ServerSentEvent, nextJob.generationId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(nextDone).toEqual([{ final: 'new' }]);

    nextSubscription?.unsubscribe();
    await publisher.completeJob(streamId, undefined, nextJob.generationId);
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('keeps an existing subscriber when a late subscriber replays a persisted terminal', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-terminal-replay-${Date.now()}`;
    const job = await publisher.createJob(streamId, 'user-1', streamId);
    const existingErrors: string[] = [];
    const replayedErrors: string[] = [];
    const existingSubscription = await subscriber.subscribe(
      streamId,
      () => undefined,
      undefined,
      (error) => existingErrors.push(error),
    );

    await publisher.completeJob(streamId, 'persisted terminal', job.generationId);
    const lateSubscription = await subscriber.subscribe(
      streamId,
      () => undefined,
      undefined,
      (error) => replayedErrors.push(error),
    );
    await publisher.emitError(streamId, 'persisted terminal', job.generationId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(replayedErrors).toEqual(['persisted terminal']);
    expect(existingErrors).toEqual(['persisted terminal']);

    lateSubscription?.unsubscribe();
    existingSubscription?.unsubscribe();
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('keeps the old subscriber when a late subscription observes a replacement owner', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-replacement-subscriber-${Date.now()}`;
    const oldJob = await publisher.createJob(streamId, 'user-1', streamId);
    const existingErrors: string[] = [];
    const existingSubscription = await subscriber.subscribe(
      streamId,
      () => undefined,
      undefined,
      (error) => existingErrors.push(error),
    );

    const subscriberStore = subscriber.getJobStore();
    const getJob = subscriberStore.getJob.bind(subscriberStore);
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let reads = 0;
    subscriberStore.getJob = async (id) => {
      reads++;
      if (reads === 2) {
        lookupStarted();
        await lookupGate;
      }
      return getJob(id);
    };

    const lateSubscription = subscriber.subscribe(streamId, () => undefined);
    await started;
    await publisher.completeJob(streamId, 'old terminal', oldJob.generationId);
    const nextJob = await publisher.createJob(streamId, 'user-1', streamId);
    releaseLookup();

    expect(await lateSubscription).toBeNull();
    await publisher.emitError(streamId, 'old terminal', oldJob.generationId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existingErrors).toEqual(['old terminal']);

    subscriberStore.getJob = getJob;
    existingSubscription?.unsubscribe();
    await publisher.completeJob(streamId, undefined, nextJob.generationId);
    await publisher.destroy();
    await subscriber.destroy();
  });

  it('ignores stale completion after a newer generation claims the conversation', async () => {
    const publisher = createManager();
    const subscriber = createManager();
    const streamId = `knauf-generation-fence-${Date.now()}`;

    const oldJob = await publisher.createJob(streamId, 'user-1', streamId);
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent, oldJob.generationId);

    const nextJob = await publisher.createJob(streamId, 'user-1', streamId);
    await publisher.completeJob(streamId, undefined, oldJob.generationId);

    expect((await publisher.getJob(streamId))?.generationId).toBe(nextJob.generationId);

    const chunks: ServerSentEvent[] = [];
    const done: ServerSentEvent[] = [];
    const subscription = await subscriber.subscribe(
      streamId,
      (event) => chunks.push(event),
      (event) => done.push(event),
    );
    await publisher.emitChunk(
      streamId,
      { event: 'on_message_delta', data: { text: 'still active' } },
      nextJob.generationId,
    );
    await publisher.emitDone(streamId, { final: true } as ServerSentEvent, nextJob.generationId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(chunks).toEqual([{ event: 'on_message_delta', data: { text: 'still active' } }]);
    expect(done).toHaveLength(1);

    subscription?.unsubscribe();
    await publisher.completeJob(streamId, undefined, nextJob.generationId);
    await publisher.destroy();
    await subscriber.destroy();
  });
  /**
   * The disconnect safety net that persists a partial response is registered as
   * `job.emitter.on('allSubscribersLeft', ...)` in api/server/controllers/agents/request.js:415.
   *
   * `GenerationJobManager` stores those handlers on process-local runtime state, but the
   * cross-replica runtime built by `getOrCreateRuntimeState` omits `allSubscribersLeftHandlers`
   * entirely — and then guards the invocation on that always-undefined field. With Redis the job
   * is shared, so `GET /agents/chat/stream/:streamId` can land on a replica that did not start the
   * generation. When it does, neither replica fires the handler and the partial response is never
   * written to Mongo.
   *
   * See knauf/docs/operations/chat-history-disappearing-investigation.md.
   */
  describe('allSubscribersLeft handlers across replicas', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    it('runs the disconnect handler when the SSE lands on the generating replica', async () => {
      const replicaA = createManager();
      const streamId = `knauf-subscribers-left-same-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await replicaA.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      // The content aggregator needs the run step before the deltas that reference it.
      await replicaA.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', runId: 'run-1', index: 0, stepDetails: { type: 'message_creation' } },
      } as unknown as ServerSentEvent);
      await replicaA.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'partial answer' } } },
      } as unknown as ServerSentEvent);
      // `emitChunk` persists chunks fire-and-forget, so let the XADDs land before reading them back.
      await settle();

      const subscription = await replicaA.subscribe(
        streamId,
        () => undefined,
        () => undefined,
      );
      subscription?.unsubscribe();
      await settle();

      expect(handlerCalls).toHaveLength(1);

      await replicaA.destroy();
    });

    it('does not fire while another replica still has a subscriber, then fires exactly once', async () => {
      const replicaA = createManager();
      const replicaB = createManager();
      const replicaC = createManager();
      const streamId = `knauf-subscribers-left-two-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await replicaA.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await replicaA.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', runId: 'run-1', index: 0, stepDetails: { type: 'message_creation' } },
      } as unknown as ServerSentEvent);
      await replicaA.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'partial answer' } } },
      } as unknown as ServerSentEvent);
      await settle();

      // Two viewers of the same generation, each served by a different replica.
      const subB = await replicaB.subscribe(
        streamId,
        () => undefined,
        () => undefined,
      );
      const subC = await replicaC.subscribe(
        streamId,
        () => undefined,
        () => undefined,
      );

      // One tab closes. The other is still streaming, so nothing may be persisted yet.
      subB?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(0);

      // The last viewer leaves: exactly one notification, not one per replica.
      subC?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(1);

      await replicaA.destroy();
      await replicaB.destroy();
      await replicaC.destroy();
    });

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const noop = () => undefined;
    const seedContent = async (owner: GenerationJobManagerClass, streamId: string) => {
      await owner.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', runId: 'run-1', index: 0, stepDetails: { type: 'message_creation' } },
      } as unknown as ServerSentEvent);
      await owner.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'partial answer' } } },
      } as unknown as ServerSentEvent);
    };

    it('detects the sole remote subscriber whose replica stops without unsubscribing', async () => {
      const lease = { leaseTtlMs: 600, leaseSweepMs: 150 };
      const owner = createReplica(lease);
      const viewer = createReplica(lease);
      const streamId = `knauf-sole-remote-crash-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await owner.manager.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await seedContent(owner.manager, streamId);
      await settle();

      // The ONLY viewer anywhere is on a replica that is not the owner.
      await viewer.manager.subscribe(streamId, noop, noop);
      await settle();
      expect(handlerCalls).toHaveLength(0);

      /**
       * The viewer's pod dies: its Redis connections are severed with no unsubscribe, no destroy,
       * no goodbye of any kind. Its lease simply stops being refreshed. Nothing else in this test
       * touches the stream again — no second subscriber, no later unsubscribe to do the pruning.
       */
      viewer.pub.disconnect();
      viewer.sub.disconnect();

      // The owner never had a local viewer. It must notice the lapse on its own sweep.
      await wait(lease.leaseTtlMs + 4 * lease.leaseSweepMs);
      expect(handlerCalls).toHaveLength(1);

      // Exactly once: keep watching across several more sweeps.
      await wait(4 * lease.leaseSweepMs);
      expect(handlerCalls).toHaveLength(1);

      await owner.stop();
      await viewer.stop();
    });

    it('does not fire before any subscriber has ever attached', async () => {
      const lease = { leaseTtlMs: 300, leaseSweepMs: 60 };
      const owner = createReplica(lease);
      const viewer = createReplica(lease);
      const streamId = `knauf-no-premature-fire-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await owner.manager.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await seedContent(owner.manager, streamId);

      // The observer is armed and sweeping, but an empty world is not a departure.
      await wait(6 * lease.leaseSweepMs);
      expect(handlerCalls).toHaveLength(0);

      // Prove it was armed all along: the first real departure is announced.
      const sub = await viewer.manager.subscribe(streamId, noop, noop);
      await settle();
      sub?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(1);

      await owner.stop();
      await viewer.stop();
    });

    it('announces a second departure after a reconnect', async () => {
      const replicaA = createManager();
      const replicaB = createManager();
      const streamId = `knauf-departure-reconnect-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await replicaA.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await seedContent(replicaA, streamId);
      await settle();

      const first = await replicaB.subscribe(streamId, noop, noop);
      await settle();
      first?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(1);

      // A reconnect revives membership and starts a new epoch, so leaving again is a new departure.
      const second = await replicaB.subscribe(streamId, noop, noop);
      await settle();
      second?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(2);

      await replicaA.destroy();
      await replicaB.destroy();
    });

    it('an owner that also serves a viewer waits for the remote viewer too', async () => {
      const replicaA = createManager();
      const replicaB = createManager();
      const streamId = `knauf-owner-dual-role-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await replicaA.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await seedContent(replicaA, streamId);
      await settle();

      const local = await replicaA.subscribe(streamId, noop, noop);
      const remote = await replicaB.subscribe(streamId, noop, noop);
      await settle();

      // The owner's own viewer leaves. Its local reset fires, but a remote viewer remains.
      local?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(0);

      remote?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(1);

      await replicaA.destroy();
      await replicaB.destroy();
    });

    it("cleanup on one replica leaves other replicas' leases intact", async () => {
      const lease = { leaseTtlMs: 600, leaseSweepMs: 150 };
      const owner = createReplica(lease);
      const viewerB = createReplica(lease);
      const viewerC = createReplica(lease);
      const streamId = `knauf-cleanup-peers-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await owner.manager.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      await seedContent(owner.manager, streamId);
      await settle();

      const subB = await viewerB.manager.subscribe(streamId, noop, noop);
      await viewerC.manager.subscribe(streamId, noop, noop);
      await settle();

      const leasesKey = `stream:{${streamId}}:generation:${job.generationId}:leases`;
      expect(await redis.zcard(leasesKey)).toBe(2);

      // C tears down its own state. It must release only its own lease, never B's.
      viewerC.transport.cleanup(streamId, job.generationId);
      await wait(2 * lease.leaseSweepMs);
      expect(await redis.zcard(leasesKey)).toBe(1);
      expect(handlerCalls).toHaveLength(0);

      subB?.unsubscribe();
      await settle();
      expect(handlerCalls).toHaveLength(1);

      await owner.stop();
      await viewerB.stop();
      await viewerC.stop();
    });

    it('runs the disconnect handler when the SSE lands on another replica', async () => {
      const replicaA = createManager();
      const replicaB = createManager();
      const streamId = `knauf-subscribers-left-cross-${Date.now()}`;
      const handlerCalls: unknown[][] = [];

      const job = await replicaA.createJob(streamId, 'user-1', streamId);
      job.emitter.on('allSubscribersLeft', (parts: unknown[]) => {
        handlerCalls.push(parts);
      });
      // The content aggregator needs the run step before the deltas that reference it.
      await replicaA.emitChunk(streamId, {
        event: 'on_run_step',
        data: { id: 'step-1', runId: 'run-1', index: 0, stepDetails: { type: 'message_creation' } },
      } as unknown as ServerSentEvent);
      await replicaA.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'partial answer' } } },
      } as unknown as ServerSentEvent);
      // `emitChunk` persists chunks fire-and-forget, so let the XADDs land before reading them back.
      await settle();

      // The job is visible cross-replica, so the gap is handler propagation, not job lookup.
      await expect(replicaB.getJob(streamId)).resolves.toBeTruthy();

      // What api/server/routes/agents/index.js:74 does, then what req.on('close') does.
      const subscription = await replicaB.subscribe(
        streamId,
        () => undefined,
        () => undefined,
      );
      subscription?.unsubscribe();
      await settle();

      // The content was recoverable from the Redis chunk stream the whole time — replica B could
      // have saved it. Nothing asked it to.
      const parts = await replicaB.getJobStore().getContentParts(streamId, job.generationId);
      expect(parts?.content?.length ?? 0).toBeGreaterThan(0);

      expect(handlerCalls).toHaveLength(1);

      await replicaA.destroy();
      await replicaB.destroy();
    });
  });
});

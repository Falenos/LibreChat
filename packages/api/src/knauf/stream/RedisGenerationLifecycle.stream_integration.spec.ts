import { logger } from '@librechat/data-schemas';
import type { Redis as RedisClient } from 'ioredis';
import type { ServerSentEvent } from '~/types';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createStreamServices } from '~/stream/createStreamServices';
import { GENERATION_CONFLICT_CODE } from '~/stream/interfaces/IJobStore';

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
});

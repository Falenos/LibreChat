import { logger } from '@librechat/data-schemas';
import type { Redis } from 'ioredis';
import { RedisEventTransport } from '~/stream/implementations/RedisEventTransport';
import { createMockPublisher } from './helpers/publisher';

logger.silent = true;

function createMockSubscriber() {
  return {
    on: jest.fn(),
    subscribe: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
  };
}

function getMessageHandler(mockSubscriber: ReturnType<typeof createMockSubscriber>) {
  return mockSubscriber.on.mock.calls.find((call) => call[0] === 'message')?.[1] as (
    channel: string,
    message: string,
  ) => void;
}

describe('RedisEventTransport', () => {
  it('resets stale abort-listener reorder state before the next real subscriber', async () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );

    const streamId = 'reorder-abort-listener-reuse-test';
    transport.onAbort(streamId, () => {});

    const messageHandler = getMessageHandler(mockSubscriber);
    const channel = `stream:{${streamId}}:events`;

    for (let i = 0; i < 5; i++) {
      await transport.emitChunk(streamId, { index: i });
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq: i, data: { index: i } }));
    }

    await mockPublisher.del(`stream:{${streamId}}:seq`);

    const secondRunChunks: unknown[] = [];
    transport.subscribe(streamId, {
      onChunk: (event) => secondRunChunks.push(event),
    });

    messageHandler(channel, JSON.stringify({ type: 'chunk', seq: 0, data: { index: 0 } }));

    expect(secondRunChunks.map((chunk) => (chunk as { index: number }).index)).toEqual([0]);

    transport.destroy();
  });

  // [knauf] Abort-only replicas ignore data events but still receive cross-replica aborts.
  it('keeps abort delivery active after the last data listener disconnects', () => {
    const mockPublisher = createMockPublisher();
    const mockSubscriber = createMockSubscriber();
    const transport = new RedisEventTransport(
      mockPublisher as unknown as Redis,
      mockSubscriber as unknown as Redis,
    );
    const abortCallback = jest.fn();
    const warnSpy = jest.spyOn(logger, 'warn');
    const streamId = 'abort-only-listener-test';
    const channel = `stream:{${streamId}}:events`;

    transport.onAbort(streamId, abortCallback);
    const dataSubscription = transport.subscribe(streamId, { onChunk: () => {} });
    dataSubscription.unsubscribe();
    expect(mockSubscriber.unsubscribe).not.toHaveBeenCalled();

    const messageHandler = getMessageHandler(mockSubscriber);
    for (let seq = 1; seq <= 100; seq++) {
      messageHandler(channel, JSON.stringify({ type: 'chunk', seq, data: { seq } }));
    }

    expect(warnSpy).not.toHaveBeenCalled();
    messageHandler(channel, JSON.stringify({ type: 'abort' }));
    expect(abortCallback).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    transport.destroy();
  });
  // End [knauf]
});

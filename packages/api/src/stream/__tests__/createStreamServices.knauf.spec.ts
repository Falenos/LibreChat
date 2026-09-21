// [knauf] Ensure Redis stream subscribers receive opt-in Pub/Sub heartbeats.
const mockRedisEventTransport = jest.fn();

jest.mock('~/cache/redisClients', () => ({
  ioredisClient: null,
}));

jest.mock('../implementations/RedisEventTransport', () => ({
  RedisEventTransport: mockRedisEventTransport,
}));

describe('[knauf] createStreamServices Redis subscriber keepalive', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockRedisEventTransport.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeRedisClient(overrides: Record<string, unknown> = {}) {
    return {
      duplicate: jest.fn(),
      on: jest.fn(),
      ...overrides,
    };
  }

  it('passes a duplicated subscriber to the event transport', async () => {
    const { createStreamServices } = await import('../createStreamServices');
    const subscriber = makeRedisClient();
    const redisClient = makeRedisClient({ duplicate: jest.fn(() => subscriber) });

    const services = createStreamServices({ useRedis: true, redisClient: redisClient as never });

    expect(services.isRedis).toBe(true);
    expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
    expect(mockRedisEventTransport).toHaveBeenCalledWith(
      redisClient,
      subscriber,
      expect.objectContaining({ keepaliveIntervalSeconds: expect.any(Number) }),
    );
  });

  it('passes an explicitly supplied subscriber to the event transport', async () => {
    const { createStreamServices } = await import('../createStreamServices');
    const redisClient = makeRedisClient();
    const redisSubscriber = makeRedisClient();

    const services = createStreamServices({
      useRedis: true,
      redisClient: redisClient as never,
      redisSubscriber: redisSubscriber as never,
    });

    expect(services.isRedis).toBe(true);
    expect(redisClient.duplicate).not.toHaveBeenCalled();
    expect(mockRedisEventTransport).toHaveBeenCalledWith(
      redisClient,
      redisSubscriber,
      expect.objectContaining({ keepaliveIntervalSeconds: expect.any(Number) }),
    );
  });

  // [knauf] KK20-338 — this mitigation stays opt-in.
  it('stays disabled when both ping intervals are unset', async () => {
    delete process.env.REDIS_PING_INTERVAL;
    delete process.env.REDIS_STREAM_PING_INTERVAL;
    jest.resetModules();
    const { createStreamServices } = await import('../createStreamServices');
    const redisSubscriber = makeRedisClient();
    const redisClient = makeRedisClient();

    createStreamServices({
      useRedis: true,
      redisClient: redisClient as never,
      redisSubscriber: redisSubscriber as never,
    });

    expect(mockRedisEventTransport).toHaveBeenCalledWith(redisClient, redisSubscriber, {
      keepaliveIntervalSeconds: 0,
      leaseTtlMs: 30000,
    });
  });

  it('uses REDIS_STREAM_PING_INTERVAL when the general interval is disabled', async () => {
    delete process.env.REDIS_PING_INTERVAL;
    process.env.REDIS_STREAM_PING_INTERVAL = '30';
    jest.resetModules();
    const { createStreamServices } = await import('../createStreamServices');
    const redisSubscriber = makeRedisClient();
    const redisClient = makeRedisClient();

    createStreamServices({
      useRedis: true,
      redisClient: redisClient as never,
      redisSubscriber: redisSubscriber as never,
    });

    expect(mockRedisEventTransport).toHaveBeenCalledWith(redisClient, redisSubscriber, {
      keepaliveIntervalSeconds: 30,
      leaseTtlMs: 30000,
    });
  });

  it('prefers REDIS_PING_INTERVAL over the stream-specific fallback', async () => {
    process.env.REDIS_PING_INTERVAL = '120';
    process.env.REDIS_STREAM_PING_INTERVAL = '30';
    jest.resetModules();
    const { createStreamServices } = await import('../createStreamServices');
    const redisSubscriber = makeRedisClient();
    const redisClient = makeRedisClient();

    createStreamServices({
      useRedis: true,
      redisClient: redisClient as never,
      redisSubscriber: redisSubscriber as never,
    });

    expect(mockRedisEventTransport).toHaveBeenCalledWith(redisClient, redisSubscriber, {
      keepaliveIntervalSeconds: 120,
      leaseTtlMs: 30000,
    });
  });
  // End [knauf]
});
// End [knauf]

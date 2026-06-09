// [knauf] Ensure Redis stream subscribers receive Azure idle-timeout keepalives.
const mockAttachIoredisPingInterval = jest.fn();

jest.mock('~/cache/redisClients', () => ({
  attachIoredisPingInterval: mockAttachIoredisPingInterval,
  ioredisClient: null,
}));

describe('[knauf] createStreamServices Redis subscriber keepalive', () => {
  beforeEach(() => {
    mockAttachIoredisPingInterval.mockClear();
  });

  function makeRedisClient(overrides: Record<string, unknown> = {}) {
    const client = {
      duplicate: jest.fn(),
      on: jest.fn(),
      ...overrides,
    };

    return client as never;
  }

  it('attaches keepalive to a duplicated subscriber client', async () => {
    const { createStreamServices } = await import('../createStreamServices');
    const subscriber = makeRedisClient();
    const redisClient = makeRedisClient({
      duplicate: jest.fn(() => subscriber),
    });

    const services = createStreamServices({ useRedis: true, redisClient });

    expect(services.isRedis).toBe(true);
    expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
    expect(mockAttachIoredisPingInterval).toHaveBeenCalledWith(subscriber, 'ioredis subscriber');
  });

  it('attaches keepalive to an explicitly supplied subscriber client', async () => {
    const { createStreamServices } = await import('../createStreamServices');
    const redisClient = makeRedisClient();
    const redisSubscriber = makeRedisClient();

    const services = createStreamServices({
      useRedis: true,
      redisClient,
      redisSubscriber,
    });

    expect(services.isRedis).toBe(true);
    expect(redisClient.duplicate).not.toHaveBeenCalled();
    expect(mockAttachIoredisPingInterval).toHaveBeenCalledWith(
      redisSubscriber,
      'ioredis subscriber',
    );
  });
});
// End [knauf]

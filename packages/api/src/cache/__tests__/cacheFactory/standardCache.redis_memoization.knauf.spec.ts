// [knauf] pin Redis-backed standardCache memoization to avoid duplicate client listeners.
jest.mock('@keyv/redis', () => ({
  default: jest.fn(),
}));

jest.mock('../../redisClients', () => ({
  keyvRedisClient: {
    scanIterator: jest.fn(),
  },
  ioredisClient: null,
}));

jest.mock('../../redisUtils', () => ({
  batchDeleteKeys: jest.fn(),
  scanKeys: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('standardCache - Redis memoization', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadFactory() {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
        REDIS_KEY_PREFIX: 'test-prefix',
        GLOBAL_PREFIX_SEPARATOR: '::',
      },
    }));
    return import('../../cacheFactory');
  }

  it('returns the same Redis-backed instance for repeated calls with the same namespace', async () => {
    const KeyvRedis = jest.requireMock('@keyv/redis').default as jest.Mock;
    const { standardCache } = await loadFactory();

    const first = standardCache('test-ns', 500);
    const second = standardCache('test-ns', 99999);

    expect(first).toBe(second);
    expect(KeyvRedis).toHaveBeenCalledTimes(1);
    type KeyvWithOpts = typeof first & { opts: { ttl?: number } };
    expect((first as KeyvWithOpts).opts.ttl).toBe(500);
  });

  it('keeps Redis-backed instances isolated by namespace', async () => {
    const KeyvRedis = jest.requireMock('@keyv/redis').default as jest.Mock;
    const { standardCache } = await loadFactory();

    const first = standardCache('ns-one');
    const second = standardCache('ns-two');

    expect(first).not.toBe(second);
    expect(KeyvRedis).toHaveBeenCalledTimes(2);
  });
});
// End [knauf]

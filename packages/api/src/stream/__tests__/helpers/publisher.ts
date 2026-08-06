export interface MockPublisher {
  publish: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  // [knauf] RedisEventTransport allocates sequence numbers through one Lua command.
  eval: jest.Mock;
  // End [knauf]
  get: jest.Mock;
  del: jest.Mock;
}

/** Mock publisher with Redis command simulation for atomic sequence counters */
export function createMockPublisher(): MockPublisher {
  const counters = new Map<string, number>();
  const publisher: MockPublisher = {
    publish: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockImplementation((key: string) => {
      const current = (counters.get(key) ?? 0) + 1;
      counters.set(key, current);
      return Promise.resolve(current);
    }),
    expire: jest.fn().mockResolvedValue(1),
    // [knauf] Model only the INCR/EXPIRE script used by RedisEventTransport.
    eval: jest.fn(),
    // End [knauf]
    get: jest.fn().mockImplementation((key: string) => {
      const val = counters.get(key);
      return Promise.resolve(val != null ? String(val) : null);
    }),
    del: jest.fn().mockImplementation((...keys: string[]) => {
      for (const key of keys) {
        counters.delete(key);
      }
      return Promise.resolve(keys.length);
    }),
  };
  // [knauf] Delegate through the command mocks so existing failure-propagation tests still
  // control the same Redis boundary after the production implementation moved to EVAL.
  publisher.eval.mockImplementation(async (_script, _keys, key: string, ttl: string) => {
    const value = await publisher.incr(key);
    if (value === 1) {
      await publisher.expire(key, Number(ttl));
    }
    return value;
  });
  // End [knauf]
  return publisher;
}

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
  // [knauf] Viewer-lease scripts need real semantics; sequence allocation stays on the command mocks.
  /**
   * Two script families run through EVAL. Sequence allocation still delegates to the
   * command mocks so existing failure-propagation tests keep controlling the same boundary.
   * Viewer leases need real semantics, because the whole point of the lease design is that
   * membership survives a replica that never says goodbye: one ZSET member per replica scored
   * by "now", an epoch counter bumped whenever membership revives from zero, and pruning by
   * score on check. Scores use Date.now() where Redis would use TIME, which also makes this the
   * one lease surface that works under fake timers.
   */
  const leases = new Map<string, Map<string, number>>();
  const epochs = new Map<string, number>();
  const leaseSet = (key: string) => {
    let set = leases.get(key);
    if (!set) {
      set = new Map<string, number>();
      leases.set(key, set);
    }
    return set;
  };
  publisher.eval.mockImplementation(async (script: string, numKeys: number, ...rest: string[]) => {
    const keys = rest.slice(0, numKeys);
    const argv = rest.slice(numKeys);
    if (script.includes('ZREMRANGEBYSCORE')) {
      // Check: {seen, remaining, epoch}. Not seen until a viewer ever attached.
      const [leaseKey, epochKey] = keys;
      const epoch = epochs.get(epochKey) ?? 0;
      if (epoch === 0) {
        return [0, 0, 0];
      }
      const set = leaseSet(leaseKey);
      const cutoff = Date.now() - Number(argv[0]);
      for (const [member, score] of [...set]) {
        if (score <= cutoff) {
          set.delete(member);
        }
      }
      return [1, set.size, epoch];
    }
    if (script.includes('ZADD')) {
      // Touch: join or heartbeat; bump the epoch when reviving from zero.
      const [leaseKey, epochKey] = keys;
      const set = leaseSet(leaseKey);
      const before = set.size;
      set.set(argv[0], Date.now());
      if (before === 0) {
        epochs.set(epochKey, (epochs.get(epochKey) ?? 0) + 1);
      }
      return [set.size, epochs.get(epochKey) ?? 0];
    }
    if (script.includes('ZREM')) {
      // Leave: drop this replica only; peers and the epoch evidence stay.
      const [leaseKey] = keys;
      const set = leaseSet(leaseKey);
      set.delete(argv[0]);
      return [set.size];
    }
    // Sequence allocation.
    const [key] = keys;
    const value = await publisher.incr(key);
    if (value === 1) {
      await publisher.expire(key, Number(argv[0]));
    }
    return value;
  });
  // End [knauf]
  return publisher;
}

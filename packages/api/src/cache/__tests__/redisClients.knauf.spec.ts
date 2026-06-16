// [knauf] Redis keepalive tests for Azure idle-timeout protection.
import type { Redis } from 'ioredis';

describe('[knauf] attachIoredisPingInterval', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = 'false';
    process.env.REDIS_PING_INTERVAL = '300';
    jest.useFakeTimers();
    jest.resetModules();
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
    jest.resetModules();
  });

  function makeClient(status = 'ready') {
    const handlers = new Map<string, () => void>();
    const client = {
      status,
      ping: jest.fn().mockResolvedValue('PONG'),
      once: jest.fn((event: string, handler: () => void) => {
        handlers.set(event, handler);
        return client;
      }),
    };

    return {
      client: client as unknown as Redis,
      raw: client,
      emit: (event: string) => handlers.get(event)?.(),
    };
  }

  it('pings ready clients on the configured interval and clears on terminal end', async () => {
    const { attachIoredisPingInterval } = await import('../redisClients');
    const { client, raw, emit } = makeClient();

    attachIoredisPingInterval(client, 'test redis');

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(raw.ping).toHaveBeenCalledTimes(1);

    raw.status = 'connecting';
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(raw.ping).toHaveBeenCalledTimes(1);

    emit('end');
    raw.status = 'ready';
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(raw.ping).toHaveBeenCalledTimes(1);
  });

  it('does not attach duplicate ping loops to the same client', async () => {
    const { attachIoredisPingInterval } = await import('../redisClients');
    const { client, raw } = makeClient();

    attachIoredisPingInterval(client);
    attachIoredisPingInterval(client);

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();

    expect(raw.ping).toHaveBeenCalledTimes(1);
    expect(raw.once).toHaveBeenCalledTimes(1);
  });
});
// End [knauf]

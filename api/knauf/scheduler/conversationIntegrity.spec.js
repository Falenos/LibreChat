'use strict';

const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_TIME_MS,
  createConversationIntegritySampler,
} = require('./conversationIntegrity');

describe('conversation integrity sampler', () => {
  const createDeps = (countDocuments = jest.fn().mockResolvedValue(0)) => ({
    conversations: { countDocuments },
    metrics: {
      setConversationIntegrity: jest.fn(),
      setConversationIntegrityScanHealthy: jest.fn(),
    },
    logger: { error: jest.fn() },
  });

  test('publishes the bounded missing-field count and healthy scan state', async () => {
    const deps = createDeps(jest.fn().mockResolvedValue(7));
    const sampler = createConversationIntegritySampler(deps);

    await expect(sampler.sample()).resolves.toEqual({
      healthy: true,
      missingChatProjectId: 7,
    });
    expect(deps.conversations.countDocuments).toHaveBeenCalledWith(
      { chatProjectId: { $exists: false } },
      { maxTimeMS: DEFAULT_MAX_TIME_MS },
    );
    expect(deps.metrics.setConversationIntegrity).toHaveBeenCalledWith({
      missingChatProjectId: 7,
      scanHealthy: true,
    });
    expect(deps.metrics.setConversationIntegrityScanHealthy).not.toHaveBeenCalled();
  });

  test('marks the scan unhealthy and does not expose database error details', async () => {
    const error = new Error('mongodb://user:password@private-host');
    error.name = 'MongoServerError';
    const deps = createDeps(jest.fn().mockRejectedValue(error));
    const sampler = createConversationIntegritySampler(deps);

    await expect(sampler.sample()).resolves.toEqual({ healthy: false });
    expect(deps.metrics.setConversationIntegrity).not.toHaveBeenCalled();
    expect(deps.metrics.setConversationIntegrityScanHealthy).toHaveBeenCalledWith(false);
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[scheduler] conversation integrity scan failed (MongoServerError)',
    );
    expect(deps.logger.error.mock.calls[0][0]).not.toContain('password');
  });

  test('runs immediately, uses the fixed cadence, and drains an in-flight scan on stop', async () => {
    let resolveCount;
    const countDocuments = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveCount = resolve;
        }),
    );
    const deps = createDeps(countDocuments);
    const timer = { unref: jest.fn() };
    let intervalCallback;
    const setIntervalFn = jest.fn((callback) => {
      intervalCallback = callback;
      return timer;
    });
    const clearIntervalFn = jest.fn();
    const sampler = createConversationIntegritySampler({
      ...deps,
      setIntervalFn,
      clearIntervalFn,
    });

    const started = sampler.start();
    const duplicate = sampler.sample();
    expect(countDocuments).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), DEFAULT_INTERVAL_MS);
    expect(timer.unref).toHaveBeenCalled();

    const stopped = sampler.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    resolveCount(0);
    await expect(Promise.all([started, duplicate, stopped])).resolves.toEqual([
      { healthy: true, missingChatProjectId: 0 },
      { healthy: true, missingChatProjectId: 0 },
      undefined,
    ]);
    intervalCallback();
    expect(countDocuments).toHaveBeenCalledTimes(1);
  });
});

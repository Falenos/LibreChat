const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

const claimResult = (_filter, update) => ({
  owner: update.$set.owner,
  expiresAt: update.$set.expiresAt,
});

describe('withMeiliSyncLock', () => {
  let collection;
  let mongoose;

  beforeEach(() => {
    jest.clearAllMocks();
    collection = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    mongoose = {
      connection: {
        collection: jest.fn().mockReturnValue(collection),
      },
    };
  });

  test('holds and releases the operation lease around the handler', async () => {
    collection.findOneAndUpdate.mockImplementation(claimResult);
    const handler = jest.fn().mockResolvedValue('done');
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    await expect(withMeiliSyncLock(mongoose, handler)).resolves.toBe('done');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(collection.deleteOne).toHaveBeenCalledWith({
      _id: 'meili-index-sync',
      owner: expect.any(String),
      expiresAt: { $gt: expect.any(Date) },
    });
  });

  test('does not run the handler when another replica owns the lease', async () => {
    collection.findOneAndUpdate.mockRejectedValue({ code: 11000 });
    const handler = jest.fn();
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    await expect(withMeiliSyncLock(mongoose, handler)).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(collection.deleteOne).not.toHaveBeenCalled();
  });

  test('startup callers wait and retry after another replica releases the lease', async () => {
    jest.useFakeTimers();
    collection.findOneAndUpdate
      .mockRejectedValueOnce({ code: 11000 })
      .mockImplementationOnce(claimResult);
    const handler = jest.fn().mockResolvedValue('done');
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    const running = withMeiliSyncLock(mongoose, handler, { waitForLease: true });
    await jest.advanceTimersByTimeAsync(2000);

    await expect(running).resolves.toBe('done');
    expect(handler).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('refreshes the lease while reconciliation is running', async () => {
    jest.useFakeTimers();
    collection.findOneAndUpdate.mockImplementation(claimResult);
    let finish;
    const handler = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    const running = withMeiliSyncLock(mongoose, handler);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(collection.updateOne).toHaveBeenCalledTimes(1);
    finish('done');
    await expect(running).resolves.toBe('done');
    jest.useRealTimers();
  });

  test('fail-stops the replica when it loses the operation lease', async () => {
    jest.useFakeTimers();
    collection.findOneAndUpdate.mockImplementation(claimResult);
    collection.updateOne.mockResolvedValue({ matchedCount: 0 });
    const onLeaseLost = jest.fn();
    let finish;
    const handler = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    const running = withMeiliSyncLock(mongoose, handler, { onLeaseLost });
    await jest.advanceTimersByTimeAsync(60 * 1000);

    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    finish('done');
    await expect(running).rejects.toThrow('Lost the Meilisearch synchronization lease');
    jest.useRealTimers();
  });

  test('waits for an in-flight renewal before releasing the lease', async () => {
    jest.useFakeTimers();
    collection.findOneAndUpdate.mockImplementation(claimResult);
    let finishRenewal;
    collection.updateOne.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRenewal = resolve;
        }),
    );
    let finishHandler;
    const handler = jest.fn(
      () =>
        new Promise((resolve) => {
          finishHandler = resolve;
        }),
    );
    const onLeaseLost = jest.fn();
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    const running = withMeiliSyncLock(mongoose, handler, { onLeaseLost });
    await jest.advanceTimersByTimeAsync(60 * 1000);
    finishHandler('done');
    await Promise.resolve();

    expect(collection.deleteOne).not.toHaveBeenCalled();
    finishRenewal({ matchedCount: 1 });
    await expect(running).resolves.toBe('done');
    expect(collection.deleteOne).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('uses the acquired Mongo expiry for the initial watchdog', async () => {
    jest.useFakeTimers();
    collection.findOneAndUpdate.mockImplementation(async (_filter, update) => ({
      owner: update.$set.owner,
      expiresAt: new Date(Date.now() + 6000),
    }));
    const onLeaseLost = jest.fn();
    let finishHandler;
    const handler = jest.fn(
      () =>
        new Promise((resolve) => {
          finishHandler = resolve;
        }),
    );
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    const running = withMeiliSyncLock(mongoose, handler, { onLeaseLost });
    while (handler.mock.calls.length === 0) {
      await Promise.resolve();
    }
    await jest.advanceTimersByTimeAsync(1001);

    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    finishHandler('done');
    await expect(running).rejects.toThrow('Lost the Meilisearch synchronization lease');
    jest.useRealTimers();
  });

  test('retries and propagates an uncertain lease release', async () => {
    collection.findOneAndUpdate.mockImplementation(claimResult);
    collection.deleteOne.mockRejectedValue(new Error('release failed'));
    const handler = jest.fn().mockResolvedValue('done');
    const { withMeiliSyncLock } = require('./meiliSyncLock');

    await expect(withMeiliSyncLock(mongoose, handler)).rejects.toThrow('release failed');

    expect(collection.deleteOne).toHaveBeenCalledTimes(3);
    expect(mockLogger.error).toHaveBeenCalledWith(
      '[indexSync] Failed to release the Meilisearch synchronization lease',
      expect.any(Error),
    );
  });
});

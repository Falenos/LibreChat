const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');

const LOCK_ID = 'meili-index-sync';
const LEASE_MS = 30 * 60 * 1000;
const REFRESH_MS = 60 * 1000;
const LEASE_SAFETY_MS = 5000;
const POLL_MS = 2000;

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

async function acquireLock(collection, owner) {
  const now = new Date();

  try {
    const result = await collection.findOneAndUpdate(
      {
        _id: LOCK_ID,
        $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
      },
      {
        $set: {
          owner,
          expiresAt: new Date(now.getTime() + LEASE_MS),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const lock = result?.value ?? result;
    return lock?.owner === owner ? lock.expiresAt : undefined;
  } catch (error) {
    if (error?.code === 11000) {
      return;
    }
    throw error;
  }
}

async function withMeiliSyncLock(mongoose, handler, options = {}) {
  const collection = mongoose.connection.collection('knaufDistributedLocks');
  const owner = crypto.randomUUID();
  const waitForLease = options.waitForLease ?? false;
  const onLeaseLost =
    options.onLeaseLost ??
    (() => {
      // Fail-stop prevents stale indexing work from overlapping a replacement lease holder.
      process.exit(1);
    });

  let acquiredExpiry;
  while ((acquiredExpiry = await acquireLock(collection, owner)) == null) {
    if (waitForLease) {
      await sleep(POLL_MS);
      continue;
    }
    logger.debug('[indexSync] Another replica holds the Meilisearch synchronization lease');
    return;
  }

  let leaseExpiresAt = acquiredExpiry.getTime();
  let leaseLost = false;
  let finalizing = false;
  let refreshing = false;
  let watchdogTimer;
  let refreshInFlight = Promise.resolve();

  const loseLease = (message, error) => {
    if (leaseLost) {
      return;
    }
    leaseLost = true;
    clearInterval(refreshTimer);
    clearTimeout(watchdogTimer);
    logger.error(message, error);
    onLeaseLost();
  };

  const scheduleWatchdog = () => {
    clearTimeout(watchdogTimer);
    const delay = Math.max(0, leaseExpiresAt - Date.now() - LEASE_SAFETY_MS);
    watchdogTimer = setTimeout(() => {
      loseLease('[indexSync] Meilisearch synchronization lease could not be renewed safely');
    }, delay);
    watchdogTimer.unref();
  };

  const refreshLease = async () => {
    try {
      const now = new Date();
      const result = await collection.updateOne(
        { _id: LOCK_ID, owner, expiresAt: { $gt: now } },
        {
          $set: {
            expiresAt: new Date(now.getTime() + LEASE_MS),
            updatedAt: now,
          },
        },
      );
      if (result.matchedCount !== 1) {
        if (!finalizing) {
          loseLease('[indexSync] Lost the Meilisearch synchronization lease');
        }
        return;
      }
      leaseExpiresAt = now.getTime() + LEASE_MS;
      scheduleWatchdog();
    } catch (error) {
      logger.error('[indexSync] Failed to refresh the Meilisearch synchronization lease', error);
    }
  };

  const refreshTimer = setInterval(() => {
    if (finalizing || refreshing) {
      return;
    }
    refreshing = true;
    refreshInFlight = refreshLease().finally(() => {
      refreshing = false;
    });
  }, REFRESH_MS);
  refreshTimer.unref();
  scheduleWatchdog();

  const stopRenewal = async () => {
    finalizing = true;
    clearInterval(refreshTimer);
    await refreshInFlight;
    if (leaseLost) {
      throw new Error('Lost the Meilisearch synchronization lease');
    }
  };

  let handlerResult;
  let handlerError;
  try {
    handlerResult = await handler();
  } catch (error) {
    handlerError = error;
  }

  let finalizationError;
  try {
    await stopRenewal();
    let releaseError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const now = new Date();
        const result = await collection.deleteOne({
          _id: LOCK_ID,
          owner,
          expiresAt: { $gt: now },
        });
        if (result.deletedCount !== 1) {
          loseLease('[indexSync] Lost the Meilisearch synchronization lease while releasing it');
          releaseError = new Error('Lost the Meilisearch synchronization lease while releasing it');
          break;
        }
        releaseError = undefined;
        break;
      } catch (error) {
        releaseError = error;
        if (attempt < 2) {
          await sleep(100);
        }
      }
    }
    if (releaseError) {
      logger.error(
        '[indexSync] Failed to release the Meilisearch synchronization lease',
        releaseError,
      );
      throw releaseError;
    }
  } catch (error) {
    finalizationError = error;
  } finally {
    clearTimeout(watchdogTimer);
  }

  if (finalizationError) {
    throw finalizationError;
  }
  if (handlerError) {
    throw handlerError;
  }
  return handlerResult;
}

module.exports = { withMeiliSyncLock };

'use strict';

const mongoose = require('mongoose');
const { GenerationJobManager } = require('@librechat/api');

const USER_STATE_COLLECTION = 'knauf_scheduler_user_states';
const SCHEDULE_COLLECTION = 'knauf_agent_schedules';
const RUN_COLLECTION = 'knauf_scheduled_agent_runs';
const DELETION_BARRIER_TTL_MS = 60 * 60_000;
const ADMISSION_DRAIN_TIMEOUT_MS = 10_000;
const ADMISSION_DRAIN_POLL_MS = 25;

const normalizeOwnerIds = (userId) => {
  const ids = [String(userId)];
  if (mongoose.isValidObjectId(userId)) {
    ids.push(new mongoose.Types.ObjectId(userId));
  }
  return ids;
};

const getDatabase = (database) => database ?? mongoose.connection.db;

async function ensureSchedulerUserStateIndexes(database) {
  const collection = getDatabase(database).collection(USER_STATE_COLLECTION);
  await Promise.all([
    collection.createIndex({ userId: 1 }, { unique: true }),
    collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

async function isSchedulerUserDeleting(userId, { database, now = () => new Date() } = {}) {
  const state = await getDatabase(database)
    .collection(USER_STATE_COLLECTION)
    .findOne({
      userId: String(userId),
      expiresAt: { $gt: now() },
    });
  return state != null;
}

async function markSchedulerUserDeleting(
  userId,
  { database, now = () => new Date(), ttlMs = DELETION_BARRIER_TTL_MS } = {},
) {
  const db = getDatabase(database);
  await ensureSchedulerUserStateIndexes(db);
  const markedAt = now();
  const update = {
    $set: {
      userId: String(userId),
      deletingAt: markedAt,
      expiresAt: new Date(markedAt.getTime() + ttlMs),
    },
    $setOnInsert: { pendingAdmissions: 0 },
  };
  try {
    await db
      .collection(USER_STATE_COLLECTION)
      .updateOne({ userId: String(userId) }, update, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }
    await db.collection(USER_STATE_COLLECTION).updateOne({ userId: String(userId) }, update);
  }
}

async function admitSchedulerUserRequest(userId, { database, now = () => new Date() } = {}) {
  const db = getDatabase(database);
  await ensureSchedulerUserStateIndexes(db);
  const collection = db.collection(USER_STATE_COLLECTION);
  const normalizedUserId = String(userId);
  const admittedAt = now();
  const filter = {
    userId: normalizedUserId,
    $or: [{ deletingAt: { $exists: false } }, { expiresAt: { $lte: admittedAt } }],
  };
  const update = {
    $inc: { pendingAdmissions: 1 },
    $unset: { deletingAt: '', expiresAt: '' },
  };

  let admitted = await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
  if (admitted == null) {
    try {
      await collection.insertOne({
        userId: normalizedUserId,
        pendingAdmissions: 1,
      });
      admitted = { userId: normalizedUserId, pendingAdmissions: 1 };
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
      admitted = await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    }
  }
  if (admitted == null) {
    return null;
  }

  let releasePromise;
  return async () => {
    releasePromise ??= (async () => {
      const state = await collection.findOneAndUpdate(
        { userId: normalizedUserId, pendingAdmissions: { $gt: 0 } },
        { $inc: { pendingAdmissions: -1 } },
        { returnDocument: 'after' },
      );
      if (state?.pendingAdmissions === 0 && state.deletingAt == null) {
        await collection.deleteOne({
          userId: normalizedUserId,
          pendingAdmissions: 0,
          deletingAt: { $exists: false },
        });
      }
    })();
    return releasePromise;
  };
}

async function waitForSchedulerAdmissionsToDrain(
  userId,
  {
    database,
    now = () => new Date(),
    timeoutMs = ADMISSION_DRAIN_TIMEOUT_MS,
    pollMs = ADMISSION_DRAIN_POLL_MS,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  const collection = getDatabase(database).collection(USER_STATE_COLLECTION);
  const startedAt = now().getTime();
  while (true) {
    const state = await collection.findOne({ userId: String(userId) });
    if ((state?.pendingAdmissions ?? 0) === 0) {
      return;
    }
    if (now().getTime() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for admitted scheduler requests to register');
    }
    await sleep(pollMs);
  }
}

async function purgeSchedulerDataForUser(userId, { database } = {}) {
  const db = getDatabase(database);
  const ownerIds = normalizeOwnerIds(userId);
  await Promise.all([
    db.collection(SCHEDULE_COLLECTION).deleteMany({ user: { $in: ownerIds } }),
    db.collection(RUN_COLLECTION).deleteMany({ ownerId: { $in: ownerIds } }),
  ]);
}

async function prepareSchedulerUserDeletion(
  user,
  { database, generationJobManager = GenerationJobManager } = {},
) {
  const userId = user.id ?? user._id;
  await markSchedulerUserDeleting(userId, { database });
  await waitForSchedulerAdmissionsToDrain(userId, { database });
  const activeJobIds = await generationJobManager.getActiveJobIdsForUser(
    String(userId),
    user.tenantId,
  );
  await Promise.all(activeJobIds.map((streamId) => generationJobManager.abortJob(streamId)));
  await purgeSchedulerDataForUser(userId, { database });
}

module.exports = {
  ensureSchedulerUserStateIndexes,
  admitSchedulerUserRequest,
  isSchedulerUserDeleting,
  markSchedulerUserDeleting,
  prepareSchedulerUserDeletion,
  purgeSchedulerDataForUser,
  waitForSchedulerAdmissionsToDrain,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  DEFAULTS,
  BackfillError,
  parseArgs,
  runBackfill,
  main,
} = require('./backfill-chat-project-id');

const clone = (value) => structuredClone(value);

function matches(document, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === 'chatProjectId' && condition?.$exists === false) {
      return !Object.prototype.hasOwnProperty.call(document, field);
    }
    if (field === '_id' && condition?.$gt != null) {
      return document._id > condition.$gt;
    }
    if (field === '_id' && Array.isArray(condition?.$in)) {
      return condition.$in.includes(document._id);
    }
    return document[field] === condition;
  });
}

class FakeCursor {
  constructor(documents) {
    this.documents = documents;
    this.maximum = Infinity;
  }

  sort() {
    this.documents.sort((left, right) => left._id - right._id);
    return this;
  }

  limit(maximum) {
    this.maximum = maximum;
    return this;
  }

  async toArray() {
    return clone(this.documents.slice(0, this.maximum));
  }
}

class FakeCollection {
  constructor(documents, { beforeUpdate, failUpdate } = {}) {
    this.documents = documents;
    this.beforeUpdate = beforeUpdate;
    this.failUpdate = failUpdate;
    this.updateCalls = 0;
  }

  async countDocuments(filter) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  find(filter) {
    return new FakeCursor(this.documents.filter((document) => matches(document, filter)));
  }

  async updateMany(filter, update) {
    this.updateCalls += 1;
    this.beforeUpdate?.(this.documents, this.updateCalls);
    if (this.failUpdate?.(this.updateCalls)) {
      throw new Error('simulated update failure');
    }
    let modifiedCount = 0;
    for (const document of this.documents) {
      if (matches(document, filter)) {
        Object.assign(document, update.$set);
        modifiedCount += 1;
      }
    }
    return { modifiedCount };
  }
}

const options = (overrides = {}) => ({
  ...DEFAULTS,
  apply: false,
  ...overrides,
});

const noSleep = async () => {};

test('dry-run reports aggregate counts and performs no writes', async () => {
  const documents = [{ _id: 1 }, { _id: 2, chatProjectId: null }, { _id: 3 }];
  const collection = new FakeCollection(documents);

  const summary = await runBackfill({
    conversationCollection: collection,
    projectCollection: {},
    options: options(),
    countOrphans: async () => 2,
  });

  assert.deepEqual(summary, {
    mode: 'dry-run',
    scanned: 0,
    matched: 2,
    modified: 0,
    remaining: 2,
    failures: 0,
    orphanedProjectReferences: 2,
  });
  assert.equal(collection.updateCalls, 0);
  assert.equal(Object.hasOwn(documents[0], 'chatProjectId'), false);
});

test('apply updates only missing fields and preserves every unrelated value', async () => {
  const documents = [
    {
      _id: 1,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-02-01T00:00:00Z'),
      _meiliIndex: true,
      title: 'unchanged',
    },
    { _id: 2, chatProjectId: null, title: 'already null' },
    { _id: 3, chatProjectId: 'project-1', title: 'assigned' },
  ];
  const before = clone(documents);
  const collection = new FakeCollection(documents);

  const summary = await runBackfill({
    conversationCollection: collection,
    projectCollection: {},
    options: options({ apply: true, expectedCount: 1 }),
    sleep: noSleep,
  });

  assert.equal(summary.modified, 1);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(documents[0], { ...before[0], chatProjectId: null });
  assert.deepEqual(documents[1], before[1]);
  assert.deepEqual(documents[2], before[2]);
});

test('failed batches can be retried and a completed rerun is a no-op', async () => {
  const documents = [{ _id: 1 }, { _id: 2 }, { _id: 3 }];
  const firstAttempt = new FakeCollection(documents, {
    failUpdate: (call) => call === 2,
  });

  await assert.rejects(
    runBackfill({
      conversationCollection: firstAttempt,
      projectCollection: {},
      options: options({ apply: true, expectedCount: 3, batchSize: 2 }),
      sleep: noSleep,
    }),
    (error) =>
      error instanceof BackfillError &&
      error.summary.modified === 2 &&
      error.summary.remaining === 1,
  );

  const retry = new FakeCollection(documents);
  const retrySummary = await runBackfill({
    conversationCollection: retry,
    projectCollection: {},
    options: options({ apply: true, expectedCount: 1, batchSize: 2 }),
    sleep: noSleep,
  });
  assert.equal(retrySummary.modified, 1);

  const noOpSummary = await runBackfill({
    conversationCollection: retry,
    projectCollection: {},
    options: options({ apply: true, expectedCount: 0 }),
    sleep: noSleep,
  });
  assert.equal(noOpSummary.modified, 0);
  assert.equal(noOpSummary.remaining, 0);
});

test('a concurrent project assignment is not overwritten', async () => {
  const documents = [{ _id: 1 }, { _id: 2 }];
  const collection = new FakeCollection(documents, {
    beforeUpdate: (rows) => {
      rows[0].chatProjectId = 'concurrent-project';
    },
  });

  const summary = await runBackfill({
    conversationCollection: collection,
    projectCollection: {},
    options: options({ apply: true, expectedCount: 2 }),
    sleep: noSleep,
  });

  assert.equal(summary.modified, 1);
  assert.equal(documents[0].chatProjectId, 'concurrent-project');
  assert.equal(documents[1].chatProjectId, null);
});

test('a new missing-field row after the snapshot is not mutated', async () => {
  const documents = [{ _id: 1 }, { _id: 2 }];
  const collection = new FakeCollection(documents, {
    beforeUpdate: (rows, call) => {
      if (call === 1) {
        rows.push({ _id: 3 });
      }
    },
  });

  await assert.rejects(
    runBackfill({
      conversationCollection: collection,
      projectCollection: {},
      options: options({ apply: true, expectedCount: 2 }),
      sleep: noSleep,
    }),
    (error) =>
      error instanceof BackfillError &&
      error.summary.modified === 2 &&
      error.summary.remaining === 1,
  );
  assert.equal(Object.hasOwn(documents[2], 'chatProjectId'), false);
});

test('safety gates reject count drift and invalid limits before writes', async () => {
  const collection = new FakeCollection([{ _id: 1 }, { _id: 2 }]);

  await assert.rejects(
    runBackfill({
      conversationCollection: collection,
      projectCollection: {},
      options: options({ apply: true, expectedCount: 1 }),
    }),
    /does not match/,
  );
  assert.equal(collection.updateCalls, 0);
  assert.throws(() => parseArgs(['--batch-size', '0']), /must be an integer/);
  assert.throws(() => parseArgs(['--max-documents', '-1']), /must be an integer/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--apply']), /requires --expected-count/);
});

test('missing MONGO_URI fails without echoing environment values', async () => {
  const secret = 'mongodb://sensitive-host/database';
  await assert.rejects(
    main({ argv: [], env: { OTHER_VALUE: secret }, log: () => {} }),
    (error) => error.message === 'MONGO_URI is required' && !error.message.includes(secret),
  );
});

test('dry-run and apply operate safely against an isolated MongoDB', async (context) => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  context.after(async () => {
    await client.close();
    await server.stop();
  });
  await client.connect();

  const database = client.db('kk20_385');
  const conversations = database.collection('conversations');
  const projects = database.collection('chatprojects');
  const projectId = new ObjectId();
  const createdAt = new Date('2025-01-01T00:00:00.000Z');
  const updatedAt = new Date('2025-02-01T00:00:00.000Z');
  await projects.insertOne({ _id: projectId, user: 'owner-1' });
  await conversations.insertMany([
    { user: 'owner-1', createdAt, updatedAt, _meiliIndex: true },
    { user: 'owner-2', createdAt, updatedAt },
    { user: 'owner-1', chatProjectId: null },
    { user: 'owner-1', chatProjectId: projectId.toString() },
    { user: 'owner-1', chatProjectId: new ObjectId().toString() },
  ]);

  const dryRun = await runBackfill({
    conversationCollection: conversations,
    projectCollection: projects,
    options: options(),
  });
  assert.equal(dryRun.matched, 2);
  assert.equal(dryRun.orphanedProjectReferences, 1);
  assert.equal(await conversations.countDocuments({ chatProjectId: { $exists: false } }), 2);

  const applied = await runBackfill({
    conversationCollection: conversations,
    projectCollection: projects,
    options: options({ apply: true, expectedCount: 2, batchSize: 1 }),
    sleep: noSleep,
  });
  assert.equal(applied.modified, 2);
  assert.equal(applied.remaining, 0);

  const preserved = await conversations.findOne({ user: 'owner-1', _meiliIndex: true });
  assert.deepEqual(preserved.createdAt, createdAt);
  assert.deepEqual(preserved.updatedAt, updatedAt);
  assert.equal(preserved._meiliIndex, true);

  const noOp = await runBackfill({
    conversationCollection: conversations,
    projectCollection: projects,
    options: options({ apply: true, expectedCount: 0 }),
    sleep: noSleep,
  });
  assert.equal(noOp.modified, 0);
});

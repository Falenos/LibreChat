'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  admitSchedulerUserRequest,
  isSchedulerUserDeleting,
  markSchedulerUserDeleting,
  prepareSchedulerUserDeletion,
  purgeSchedulerDataForUser,
} = require('./userLifecycle');

describe('scheduler user lifecycle', () => {
  let mongoServer;
  let client;
  let database;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    client = new MongoClient(mongoServer.getUri());
    await client.connect();
  });

  beforeEach(() => {
    database = client.db(`scheduler_user_lifecycle_${new ObjectId()}`);
  });

  afterAll(async () => {
    await client?.close();
    await mongoServer?.stop();
  });

  test('establishes a deletion barrier, aborts active jobs, and purges scheduler data', async () => {
    const userId = new ObjectId();
    await database
      .collection('knauf_agent_schedules')
      .insertOne({ user: userId, name: 'Daily summary' });
    await database
      .collection('knauf_scheduled_agent_runs')
      .insertOne({ ownerId: userId, status: 'started' });
    const generationJobManager = {
      getActiveJobIdsForUser: jest.fn().mockResolvedValue(['stream-1']),
      abortJob: jest.fn().mockResolvedValue({ success: true }),
    };

    await prepareSchedulerUserDeletion(
      { id: String(userId), _id: userId, tenantId: 'tenant-1' },
      { database, generationJobManager },
    );

    await expect(isSchedulerUserDeleting(userId, { database })).resolves.toBe(true);
    expect(generationJobManager.getActiveJobIdsForUser).toHaveBeenCalledWith(
      String(userId),
      'tenant-1',
    );
    expect(generationJobManager.abortJob).toHaveBeenCalledWith('stream-1');
    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(0);
    expect(await database.collection('knauf_scheduled_agent_runs').countDocuments()).toBe(0);
  });

  test('final purge removes both string and ObjectId owner representations', async () => {
    const userId = new ObjectId();
    await database
      .collection('knauf_agent_schedules')
      .insertMany([{ user: userId }, { user: String(userId) }]);
    await database
      .collection('knauf_scheduled_agent_runs')
      .insertMany([{ ownerId: userId }, { ownerId: String(userId) }]);

    await purgeSchedulerDataForUser(userId, { database });

    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(0);
    expect(await database.collection('knauf_scheduled_agent_runs').countDocuments()).toBe(0);
  });

  test('waits for admitted starts to register before snapshotting generation jobs', async () => {
    const userId = new ObjectId();
    const releaseAdmission = await admitSchedulerUserRequest(userId, { database });
    const generationJobManager = {
      getActiveJobIdsForUser: jest.fn().mockResolvedValue(['stream-1']),
      abortJob: jest.fn().mockResolvedValue({ success: true }),
    };

    const deletion = prepareSchedulerUserDeletion(
      { id: String(userId), _id: userId, tenantId: 'tenant-1' },
      { database, generationJobManager },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generationJobManager.getActiveJobIdsForUser).not.toHaveBeenCalled();

    await releaseAdmission();
    await deletion;

    expect(generationJobManager.getActiveJobIdsForUser).toHaveBeenCalledTimes(1);
    expect(generationJobManager.abortJob).toHaveBeenCalledWith('stream-1');
  });

  test('rejects new admissions after account deletion starts', async () => {
    const userId = new ObjectId();
    await markSchedulerUserDeleting(userId, { database });

    await expect(admitSchedulerUserRequest(userId, { database })).resolves.toBeNull();
  });
});

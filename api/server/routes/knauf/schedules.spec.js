'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createSchedulerRepository } = require('@knauf/knauf/server/scheduler');
const { createSchedulesRouter } = require('./schedules');

describe('Knauf schedules API', () => {
  let mongoServer;
  let client;
  let database;
  let repository;
  let clock;
  let userId;
  let resolveAgent;
  let getProject;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    client = new MongoClient(mongoServer.getUri());
    await client.connect();
  });

  beforeEach(async () => {
    database = client.db(`schedules_api_${new ObjectId()}`);
    clock = new Date('2026-08-10T10:00:00.000Z');
    userId = new ObjectId();
    repository = createSchedulerRepository({
      schedules: database.collection('knauf_agent_schedules'),
      runs: database.collection('knauf_scheduled_agent_runs'),
      now: () => new Date(clock),
    });
    await repository.ensureIndexes();
    resolveAgent = jest.fn().mockResolvedValue({
      snapshot: { id: 'agent-project', version: 3 },
    });
    getProject = jest.fn().mockResolvedValue({ id: 'project-1' });
  });

  afterAll(async () => {
    await client?.close();
    await mongoServer?.stop();
  });

  const createApp = ({
    authenticatedUserId = userId,
    enabled = true,
    limit = 10,
    resolve = resolveAgent,
    findProject = getProject,
    isUserDeleting = jest.fn().mockResolvedValue(false),
    runNowIpLimiter = (_req, _res, next) => next(),
  } = {}) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/schedules',
      createSchedulesRouter({
        getRepository: () => repository,
        authMiddleware: (req, _res, next) => {
          req.user = {
            id: String(authenticatedUserId),
            role: 'USER',
            tenantId: 'tenant-schedules',
          };
          next();
        },
        resolveAgent: resolve,
        getProject: findProject,
        isUserDeleting,
        runNowIpLimiter,
        apiEnabled: () => enabled,
        maxPerUser: () => limit,
        now: () => new Date(clock),
      }),
    );
    app.use((error, _req, res, _next) => {
      res.status(500).json({ error: error.message });
    });
    return app;
  };

  const validPayload = (overrides = {}) => ({
    name: 'Morning summary',
    prompt: 'Summarize the latest project state',
    agent_id: 'agent-project',
    chatProjectId: 'project-1',
    cadence: { frequency: 'weekdays', hour: 9, minute: 0 },
    timezone: 'Europe/Berlin',
    target: 'new',
    enabled: true,
    clientRequestId: 'create-1',
    ...overrides,
  });

  test('keeps the upstream-compatible mount seam wired', () => {
    const serverSource = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');
    expect(serverSource).toContain(
      "app.use('/api/schedules', require('./routes/knauf/schedules'));",
    );
  });

  test('stays feature-dark while the API flag is disabled', async () => {
    const response = await request(createApp({ enabled: false }))
      .get('/api/schedules')
      .expect(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });

  test('creates, lists, and reads an upstream-shaped schedule', async () => {
    const app = createApp();
    const created = await request(app).post('/api/schedules').send(validPayload()).expect(201);

    expect(created.body).toMatchObject({
      user: String(userId),
      name: 'Morning summary',
      agent_id: 'agent-project',
      chatProjectId: 'project-1',
      cadence: { frequency: 'weekdays', hour: 9, minute: 0 },
      timezone: 'Europe/Berlin',
      target: 'new',
      enabled: true,
      runCount: 0,
      failureCount: 0,
      configRevision: 0,
    });

    expect(created.body.nextRunAt).toEqual(expect.any(String));
    expect(resolveAgent).toHaveBeenCalledWith('agent-project', expect.any(Object));
    expect(getProject).toHaveBeenCalledWith(String(userId), 'project-1');

    const listed = await request(app).get('/api/schedules').expect(200);
    expect(listed.body).toMatchObject({
      schedules: [{ id: created.body.id }],
      limits: { maxPerUser: 10 },
    });

    await request(app)
      .get(`/api/schedules/${created.body.id}`)
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(created.body.id));
  });

  test('rejects unsupported attachment fields instead of silently dropping them', async () => {
    const response = await request(createApp())
      .post('/api/schedules')
      .send(validPayload({ file_ids: ['file-1'] }))
      .expect(400);

    expect(response.body).toEqual({ error: "Unrecognized key(s) in object: 'file_ids'" });
  });

  test('does not persist a schedule for an inaccessible project', async () => {
    const response = await request(createApp({ findProject: jest.fn().mockResolvedValue(null) }))
      .post('/api/schedules')
      .send(validPayload())
      .expect(400);

    expect(response.body).toEqual({ error: 'Project not found or not accessible' });
    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(0);
  });

  test('blocks schedule mutations after account deletion begins', async () => {
    const response = await request(createApp({ isUserDeleting: jest.fn().mockResolvedValue(true) }))
      .post('/api/schedules')
      .send(validPayload())
      .expect(410);

    expect(response.body).toEqual({ error: 'This account is being deleted' });
  });

  test('makes create retries idempotent and rejects key reuse with different intent', async () => {
    const app = createApp();
    const first = await request(app).post('/api/schedules').send(validPayload()).expect(201);
    const replay = await request(app).post('/api/schedules').send(validPayload()).expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(1);

    await request(app)
      .post('/api/schedules')
      .send(validPayload({ name: 'Different schedule' }))
      .expect(409);
  });

  test('enforces the per-user schedule cap under concurrent creates', async () => {
    const app = createApp({ limit: 1 });
    const responses = await Promise.all([
      request(app)
        .post('/api/schedules')
        .send(validPayload({ clientRequestId: 'first' })),
      request(app)
        .post('/api/schedules')
        .send(validPayload({ clientRequestId: 'second' })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(1);
  });

  test('fences stale edits and preserves ownership boundaries', async () => {
    const app = createApp();
    const created = await request(app).post('/api/schedules').send(validPayload()).expect(201);

    const updated = await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ name: 'Updated name', expectedConfigRevision: 0 })
      .expect(200);
    expect(updated.body).toMatchObject({ name: 'Updated name', configRevision: 1 });

    await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ chatProjectId: 'project-2', expectedConfigRevision: 1 })
      .expect(200);
    expect(getProject).toHaveBeenLastCalledWith(String(userId), 'project-2');

    await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ name: 'Stale edit', expectedConfigRevision: 0 })
      .expect(409);

    const otherUserApp = createApp({ authenticatedUserId: new ObjectId() });
    await request(otherUserApp).get(`/api/schedules/${created.body.id}`).expect(404);
    await request(otherUserApp).delete(`/api/schedules/${created.body.id}`).expect(404);
  });

  test('validates timezone, agent access, and delete behavior', async () => {
    const deniedApp = createApp({ resolve: jest.fn().mockResolvedValue(null) });
    await request(deniedApp).post('/api/schedules').send(validPayload()).expect(400);

    const app = createApp();
    await request(app)
      .post('/api/schedules')
      .send(validPayload({ timezone: 'Not/A_Timezone' }))
      .expect(400);

    const created = await request(app).post('/api/schedules').send(validPayload()).expect(201);
    await database.collection('knauf_scheduled_agent_runs').insertOne({
      id: 'terminal-history',
      scheduleId: created.body.id,
      ownerId: userId,
      active: false,
      status: 'success',
    });
    await request(app).delete(`/api/schedules/${created.body.id}`).expect(204);
    await request(app).get(`/api/schedules/${created.body.id}`).expect(404);
    expect(await database.collection('knauf_agent_schedules').countDocuments()).toBe(0);
    expect(await database.collection('knauf_scheduled_agent_runs').countDocuments()).toBe(0);
  });

  test('does not delete a schedule while its execution lease is active', async () => {
    const app = createApp();
    const created = await request(app).post('/api/schedules').send(validPayload()).expect(201);
    const schedule = await repository.getSchedule(created.body.id);
    await repository.claimOccurrence({
      schedule,
      workerId: 'worker-delete-test',
      leaseMs: 60_000,
    });

    await request(app).delete(`/api/schedules/${created.body.id}`).expect(409);
    await request(app).get(`/api/schedules/${created.body.id}`).expect(200);
    expect(await repository.getSchedule(created.body.id)).not.toBeNull();
  });

  test('queues Run Now for disabled schedules and serializes active executions', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/api/schedules')
      .send(validPayload({ enabled: false }))
      .expect(201);

    const started = await request(app).post(`/api/schedules/${created.body.id}/run`).expect(200);
    expect(started.body).toEqual({
      scheduleId: created.body.id,
      conversationId: expect.any(String),
      status: 'started',
    });
    expect(resolveAgent).toHaveBeenLastCalledWith('agent-project', expect.any(Object));
    expect(
      await database.collection('knauf_scheduled_agent_runs').findOne({
        scheduleId: created.body.id,
      }),
    ).toMatchObject({
      trigger: 'manual',
      status: 'queued',
      active: true,
      conversationId: started.body.conversationId,
      chatProjectId: 'project-1',
    });

    await request(app).post(`/api/schedules/${created.body.id}/run`).expect(409);
    await request(app).delete(`/api/schedules/${created.body.id}`).expect(409);
  });

  test('fails Run Now before enqueueing when the selected project was deleted', async () => {
    const app = createApp();
    const created = await request(app).post('/api/schedules').send(validPayload()).expect(201);
    getProject.mockResolvedValue(null);

    await request(app).post(`/api/schedules/${created.body.id}/run`).expect(409);
    expect(await database.collection('knauf_scheduled_agent_runs').countDocuments()).toBe(0);

    await database
      .collection('knauf_agent_schedules')
      .updateOne({ id: created.body.id }, { $unset: { chatProjectId: '' } });
    const disabled = await request(app)
      .patch(`/api/schedules/${created.body.id}`)
      .send({ enabled: false })
      .expect(200);
    expect(disabled.body.enabled).toBe(false);
  });
});

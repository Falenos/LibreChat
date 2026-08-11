'use strict';

const mockLoadAgent = jest.fn();
jest.mock('@librechat/api', () => ({ loadAgent: mockLoadAgent }));
jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/models', () => ({ getAgent: jest.fn() }));

const { extractSchedulerAgentSnapshot, getSchedulerAgentSnapshot } = require('./agentSnapshot');

test('extracts a signed scheduler snapshot from the ordinary request body', () => {
  const snapshot = { id: 'agent-1', provider: 'openAI', model: 'gpt-4.1' };
  const req = {
    body: { agent_id: 'agent-1', knaufAgentSnapshot: snapshot },
    knaufSchedulerFire: { trigger: 'automatic' },
  };

  extractSchedulerAgentSnapshot(req);

  expect(req.body).toEqual({ agent_id: 'agent-1' });
  expect(getSchedulerAgentSnapshot(req, 'agent-1')).toBe(snapshot);
});

test('rejects snapshots outside a verified scheduler request or for another agent', () => {
  const req = {
    knaufSchedulerAgentSnapshot: {
      id: 'agent-1',
      provider: 'openAI',
      model: 'gpt-4.1',
    },
  };

  expect(getSchedulerAgentSnapshot(req, 'agent-1')).toBeNull();
  req.knaufSchedulerFire = { trigger: 'automatic' };
  expect(getSchedulerAgentSnapshot(req, 'agent-2')).toBeNull();
});

test('builds scheduled Agent options from the pinned snapshot instead of mutable storage', async () => {
  const snapshot = {
    id: 'agent-1',
    provider: 'openAI',
    model: 'gpt-4.1',
    instructions: 'Pinned instructions',
  };
  const req = {
    body: { agent_id: 'agent-1', knaufAgentSnapshot: snapshot },
    knaufSchedulerFire: { trigger: 'automatic' },
  };
  extractSchedulerAgentSnapshot(req);
  const { buildOptions } = require('../../server/services/Endpoints/agents/build');

  const options = buildOptions(
    req,
    'agents',
    { agent_id: 'agent-1', provider: 'openAI', model: 'gpt-4.1' },
    'agents',
  );

  await expect(options.agent).resolves.toBe(snapshot);
  expect(mockLoadAgent).not.toHaveBeenCalled();
});

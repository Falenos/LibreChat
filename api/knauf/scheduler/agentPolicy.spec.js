'use strict';

const { PermissionBits, Permissions, PermissionTypes } = require('librechat-data-provider');
const { createAgentSnapshot, resolveSchedulableAgent } = require('./agentPolicy');

const agent = {
  _id: 'mongo-agent-id',
  id: 'agent-1',
  author: 'owner-1',
  instructions: 'Pinned instructions',
  model: 'gpt-4.1',
  provider: 'openAI',
  tools: ['tool-1'],
  versions: [{ instructions: 'old' }, { instructions: 'Pinned instructions' }],
  updatedAt: new Date(),
};

test('creates a bounded immutable execution snapshot without version history', () => {
  const snapshot = createAgentSnapshot(agent);

  expect(snapshot).toEqual({
    id: 'agent-1',
    author: 'owner-1',
    version: 2,
    instructions: 'Pinned instructions',
    model: 'gpt-4.1',
    provider: 'openAI',
    tools: ['tool-1'],
  });

  expect(snapshot).not.toHaveProperty('versions');
  expect(snapshot).not.toHaveProperty('updatedAt');
});

test('pins runtime artifact-editing augmentation in the execution snapshot', () => {
  expect(
    createAgentSnapshot({
      ...agent,
      artifacts: 'enabled',
      tools: ['tool-1'],
    }),
  ).toMatchObject({ tools: ['tool-1', 'edit_artifact'] });
});

test('allows owners and editors but rejects view-only users', async () => {
  const dependencies = {
    agentId: 'agent-1',
    getAgent: jest.fn().mockResolvedValue(agent),
    getRoleByName: jest.fn().mockResolvedValue({
      permissions: { [PermissionTypes.AGENTS]: { [Permissions.USE]: true } },
    }),
  };
  const checkPermission = jest.fn().mockResolvedValue(false);

  await expect(
    resolveSchedulableAgent({
      ...dependencies,
      user: { _id: 'owner-1', role: 'USER' },
      checkPermission,
    }),
  ).resolves.toMatchObject({ snapshot: { id: 'agent-1', version: 2 } });
  expect(checkPermission).not.toHaveBeenCalled();

  checkPermission.mockResolvedValueOnce(true);
  await expect(
    resolveSchedulableAgent({
      ...dependencies,
      user: { id: 'editor-1', role: 'USER' },
      checkPermission,
    }),
  ).resolves.toMatchObject({ snapshot: { id: 'agent-1', version: 2 } });
  expect(checkPermission).toHaveBeenLastCalledWith(
    expect.objectContaining({ requiredPermission: PermissionBits.EDIT }),
  );

  checkPermission.mockResolvedValueOnce(false);
  await expect(
    resolveSchedulableAgent({
      ...dependencies,
      user: { id: 'viewer-1', role: 'USER' },
      checkPermission,
    }),
  ).resolves.toBeNull();
});

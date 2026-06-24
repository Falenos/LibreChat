// [knauf] KK20-194 — pins the open_url default-seeding in createAgentHandler.
// New agents get open_url seeded into their stored tools so URL reading is on
// by default, while remaining a real stored tool the user can remove in the
// builder (subsequent updates are authoritative). filterAuthorizedTools drops
// it if open_url is not an available tool, so seeding is a no-op when disabled.
// End [knauf]
const { createAgent: createAgentHandler } = require('../v1');
const { createAgent } = require('~/models');

jest.mock('~/models');
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
}));
jest.mock('~/server/services/PermissionService', () => ({
  ...jest.requireActual('~/server/services/PermissionService'),
  grantPermission: jest.fn().mockResolvedValue(undefined),
}));

const { getCachedTools } = require('~/server/services/Config');

const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

const baseBody = { provider: 'azureOpenAI', model: 'gpt-5.4' };

describe('[knauf] createAgentHandler — open_url default seeding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // open_url and file_search are available tools; seeding survives the filter.
    getCachedTools.mockResolvedValue({ open_url: {}, file_search: {} });
    createAgent.mockImplementation(async (data) => ({ ...data, _id: 'mongo_id' }));
  });

  it('seeds open_url when an agent is created with no tools', async () => {
    const req = { body: { ...baseBody }, user: { id: 'user_1', role: 'USER' } };
    await createAgentHandler(req, makeRes());

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0][0].tools).toContain('open_url');
  });

  it('seeds open_url alongside explicitly chosen tools', async () => {
    const req = {
      body: { ...baseBody, tools: ['file_search'] },
      user: { id: 'user_1', role: 'USER' },
    };
    await createAgentHandler(req, makeRes());

    const stored = createAgent.mock.calls[0][0].tools;
    expect(stored).toEqual(expect.arrayContaining(['file_search', 'open_url']));
  });

  it('does not duplicate open_url when the user already selected it', async () => {
    const req = {
      body: { ...baseBody, tools: ['open_url'] },
      user: { id: 'user_1', role: 'USER' },
    };
    await createAgentHandler(req, makeRes());

    const stored = createAgent.mock.calls[0][0].tools;
    expect(stored.filter((t) => t === 'open_url')).toHaveLength(1);
  });

  it('does not store open_url when it is not an available tool (no-op seeding)', async () => {
    getCachedTools.mockResolvedValue({ file_search: {} });
    const req = {
      body: { ...baseBody, tools: ['file_search'] },
      user: { id: 'user_1', role: 'USER' },
    };
    await createAgentHandler(req, makeRes());

    const stored = createAgent.mock.calls[0][0].tools;
    expect(stored).not.toContain('open_url');
  });
});

// [knauf] KK20-286 — pin Agent Builder reconciliation into database startup ordering.
const mockCallOrder = [];
const mockEnsureAgentBuilderRole = jest.fn(async () => {
  mockCallOrder.push('ensureAgentBuilderRole');
});
const mockGetLogStores = jest.fn();
const mockMethods = {
  initializeRoles: jest.fn(async () => {
    mockCallOrder.push('initializeRoles');
  }),
  seedDefaultRoles: jest.fn(async () => {
    mockCallOrder.push('seedDefaultRoles');
  }),
  ensureDefaultCategories: jest.fn(async () => {
    mockCallOrder.push('ensureDefaultCategories');
  }),
  seedSystemGrants: jest.fn(async () => {
    mockCallOrder.push('seedSystemGrants');
  }),
};

jest.mock('mongoose', () => ({ models: { Role: { modelName: 'Role' } } }));
jest.mock('@librechat/data-schemas', () => ({
  createMethods: jest.fn(() => mockMethods),
}));
jest.mock('@librechat/api', () => ({
  matchModelName: jest.fn(),
  findMatchingPattern: jest.fn(),
}));
jest.mock('~/cache/getLogStores', () => mockGetLogStores);
jest.mock('~/knauf/roles/agentBuilderRole', () => ({
  ensureAgentBuilderRole: mockEnsureAgentBuilderRole,
}));

const { seedDatabase } = require('./index');

describe('seedDatabase Agent Builder lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallOrder.length = 0;
  });

  it('reconciles the role after built-in roles and before dependent seeds', async () => {
    await seedDatabase();

    expect(mockCallOrder).toEqual([
      'initializeRoles',
      'ensureAgentBuilderRole',
      'seedDefaultRoles',
      'ensureDefaultCategories',
      'seedSystemGrants',
    ]);
    expect(mockEnsureAgentBuilderRole).toHaveBeenCalledWith({
      Role: expect.anything(),
      getCache: mockGetLogStores,
    });
  });
});
// End [knauf]

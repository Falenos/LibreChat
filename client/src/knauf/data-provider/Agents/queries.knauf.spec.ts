const mockUseQuery = jest.fn();
const mockGetQueryData = jest.fn(() => ({ agents: {} }));

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useInfiniteQuery: jest.fn(),
  useQueryClient: () => ({ getQueryData: mockGetQueryData }),
}));

jest.mock('librechat-data-provider', () => ({
  QueryKeys: { endpoints: 'endpoints', agents: 'agents', agent: 'agent' },
  dataService: { listAgents: jest.fn(), getAgentById: jest.fn() },
  EModelEndpoint: { agents: 'agents' },
  PermissionBits: { EDIT: 2 },
}));

jest.mock('~/common', () => ({ isEphemeralAgent: () => false }));

import { useGetAgentByIdQuery, useListAgentsQuery } from '~/data-provider/Agents/queries';

describe('agent avatar query refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseQuery.mockReturnValue({});
  });

  it.each([
    ['agent list', () => useListAgentsQuery()],
    ['single agent', () => useGetAgentByIdQuery('agent-1')],
  ])('refreshes stale signed avatar URLs for the %s query', (_name, runQuery) => {
    runQuery();

    expect(mockUseQuery.mock.calls.at(-1)?.[2]).toMatchObject({
      staleTime: 2 * 60 * 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
    });
  });
});

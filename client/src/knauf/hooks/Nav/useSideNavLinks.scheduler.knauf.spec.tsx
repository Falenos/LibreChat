import { renderHook } from '@testing-library/react';

jest.mock('@librechat/client', () => ({
  AttachmentIcon: () => null,
  MCPIcon: () => null,
  OpenAIMinimalIcon: () => null,
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    agents: 'agents',
    assistants: 'assistants',
    azureAssistants: 'azureAssistants',
  },
  PermissionTypes: {
    AGENTS: 'AGENTS',
    BOOKMARKS: 'BOOKMARKS',
    MCP_SERVERS: 'MCP_SERVERS',
    MEMORIES: 'MEMORIES',
    PROMPTS: 'PROMPTS',
    SKILLS: 'SKILLS',
  },
  Permissions: {
    CREATE: 'CREATE',
    READ: 'READ',
    USE: 'USE',
  },
  isAgentsEndpoint: () => false,
  isAssistantsEndpoint: () => false,
  isParamEndpoint: () => false,
}));

jest.mock('~/hooks', () => ({
  useAgentCapabilities: () => ({ skillsEnabled: false }),
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useHasAccess: () => true,
  useMCPServerManager: () => ({ availableMCPServers: [] }),
}));

jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/SidePanel/Files/Panel', () => () => null);
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));
jest.mock('~/knauf/components/Schedules', () => ({ SchedulePanel: () => null }));

import useSideNavLinks from '~/hooks/Nav/useSideNavLinks';

const baseProps = {
  keyProvided: true,
  endpointsConfig: { agents: { order: 0 } },
  includeHidePanel: false,
};

describe('useSideNavLinks scheduler seam', () => {
  it('keeps schedules hidden when interface.knauf.scheduler is omitted', () => {
    const { result } = renderHook(() => useSideNavLinks({ ...baseProps, interfaceConfig: {} }));

    expect(result.current.some((link) => link.id === 'schedules')).toBe(false);
  });

  it('registers the scheduler panel when explicitly enabled', () => {
    const { result } = renderHook(() =>
      useSideNavLinks({
        ...baseProps,
        interfaceConfig: { knauf: { scheduler: true } },
      }),
    );

    const scheduleLink = result.current.find((link) => link.id === 'schedules');
    expect(scheduleLink?.title).toBe('com_knauf_scheduler_title');
    expect(scheduleLink?.Component).toBeDefined();
  });
});

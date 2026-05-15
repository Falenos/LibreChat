import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufMCPTools from './KnaufMCPTools';

const mockUseHasAccess = jest.fn();
const mockMcpServersMap = new Map<string, unknown>();

jest.mock('~/hooks', () => ({
  useHasAccess: () => mockUseHasAccess(),
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ mcpServersMap: mockMcpServersMap }),
}));

jest.mock('~/components/SidePanel/Agents/UninitializedMCPTool', () => ({
  __esModule: true,
  default: ({ serverInfo }: { serverInfo: { serverName: string } }) => (
    <div data-testid="uninitialized-mcp-tool">{serverInfo.serverName}</div>
  ),
}));

jest.mock('~/components/SidePanel/Agents/UnconfiguredMCPTool', () => ({
  __esModule: true,
  default: ({ serverName }: { serverName: string }) => (
    <div data-testid="unconfigured-mcp-tool">{serverName}</div>
  ),
}));

jest.mock('~/components/SidePanel/Agents/MCPTool', () => ({
  __esModule: true,
  default: ({ serverInfo }: { serverInfo: { serverName: string } }) => (
    <div data-testid="mcp-tool">{serverInfo.serverName}</div>
  ),
}));

describe('KnaufMCPTools', () => {
  beforeEach(() => {
    mockMcpServersMap.clear();
    mockUseHasAccess.mockReturnValue(true);
  });

  it('returns null when the user lacks MCP_SERVERS access', () => {
    mockUseHasAccess.mockReturnValue(false);
    const { container } = render(
      <KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders configured servers that expose tools as <MCPTool>', () => {
    mockMcpServersMap.set('atlassian', {
      serverName: 'atlassian',
      isConfigured: true,
      tools: [{ name: 'jira_get_issue' }],
    });
    render(<KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />);
    expect(screen.getByTestId('mcp-tool')).toHaveTextContent('atlassian');
  });

  it('renders configured servers without tools as <UninitializedMCPTool>', () => {
    mockMcpServersMap.set('atlassian', {
      serverName: 'atlassian',
      isConfigured: true,
      tools: [],
    });
    render(<KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />);
    expect(screen.getByTestId('uninitialized-mcp-tool')).toHaveTextContent('atlassian');
  });

  it('renders unconfigured servers as <UnconfiguredMCPTool>', () => {
    mockMcpServersMap.set('atlassian', { serverName: 'atlassian', isConfigured: false });
    render(<KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />);
    expect(screen.getByTestId('unconfigured-mcp-tool')).toHaveTextContent('atlassian');
  });

  it('treats a missing server entry as unconfigured', () => {
    render(<KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />);
    expect(screen.getByTestId('unconfigured-mcp-tool')).toHaveTextContent('atlassian');
  });

  it('does not render the upstream MCPTools heading or inner button', () => {
    /**
     * Regression guard for KK20-115: the duplicate "MCP servers" label and
     * the duplicate "Add MCP Server Tools" button reappear if anyone ports
     * upstream's MCPTools internals back into this fork. KnaufAgentConfig
     * already provides the section title and the single "Add MCP server"
     * button.
     */
    mockMcpServersMap.set('atlassian', {
      serverName: 'atlassian',
      isConfigured: true,
      tools: [{ name: 'jira_get_issue' }],
    });
    render(<KnaufMCPTools agentId="agent-1" mcpServerNames={['atlassian']} />);
    expect(screen.queryByText('com_ui_mcp_servers')).toBeNull();
    expect(screen.queryByText('com_assistants_add_mcp_server_tools')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

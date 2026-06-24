/**
 * [knauf] KK20-194 — open_url rides the web-search switch.
 *
 * These tests are the behavioural anchor for the two ToolService seams that
 * inject `open_url` whenever `web_search` is enabled:
 *   - loadToolDefinitionsWrapper  → model-facing definitions path
 *   - loadAgentTools (execution)  → runtime tool construction path
 *
 * They fail if either seam is removed, if open_url stops being gated on
 * web_search, or if it gets double-added. Self-contained mock setup mirrors
 * ToolService.spec.js so the upstream test file stays untouched.
 */

const {
  Tools,
  EModelEndpoint,
  AgentCapabilities,
} = require('librechat-data-provider');

const mockGetEndpointsConfig = jest.fn();
const mockGetMCPServerTools = jest.fn();
const mockGetCachedTools = jest.fn();
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
  getMCPServerTools: (...args) => mockGetMCPServerTools(...args),
  getCachedTools: (...args) => mockGetCachedTools(...args),
}));

const mockLoadToolDefinitions = jest.fn();
const mockGetUserMCPAuthMap = jest.fn();
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  loadToolDefinitions: (...args) => mockLoadToolDefinitions(...args),
  getUserMCPAuthMap: (...args) => mockGetUserMCPAuthMap(...args),
}));

const mockLoadToolsUtil = jest.fn();
jest.mock('~/app/clients/tools/util', () => ({
  loadTools: (...args) => mockLoadToolsUtil(...args),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/Tools/search', () => ({
  createOnSearchResults: jest.fn(),
}));
jest.mock('~/server/services/Tools/mcp', () => ({
  reinitMCPServer: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  processFileURL: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/server/services/Files/Code/process', () => ({
  primeFiles: jest.fn().mockResolvedValue({}),
}));
jest.mock('../ActionService', () => ({
  loadActionSets: jest.fn().mockResolvedValue([]),
  decryptMetadata: jest.fn(),
  createActionTool: jest.fn(),
  domainParser: jest.fn(),
  legacyDomainEncode: jest.fn(),
}));
jest.mock('~/server/services/Threads', () => ({
  recordUsage: jest.fn(),
}));
jest.mock('~/models', () => ({
  findPluginAuthsByKeys: jest.fn(),
}));
jest.mock('~/config', () => ({
  getFlowStateManager: jest.fn(() => ({})),
}));
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({})),
}));

const { loadAgentTools } = require('../ToolService');

function createMockReq(capabilities) {
  return {
    user: { id: 'user_123' },
    config: {
      endpoints: {
        [EModelEndpoint.agents]: { capabilities },
      },
    },
  };
}

function createEndpointsConfig(capabilities) {
  return { [EModelEndpoint.agents]: { capabilities } };
}

describe('[knauf] open_url rides the web-search switch (ToolService)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadToolDefinitions.mockResolvedValue({
      toolDefinitions: [],
      toolRegistry: new Map(),
      hasDeferredTools: false,
    });
    mockLoadToolsUtil.mockResolvedValue({ loadedTools: [], toolContextMap: {} });
  });

  describe('definitions path (definitionsOnly=true)', () => {
    it('injects open_url when web_search is enabled and present', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search, 'calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).toContain('open_url');
      expect(callArgs.tools).toContain(Tools.web_search);
    });

    it('does NOT inject open_url when web_search capability is disabled', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        // web_search is in the agent's tools but the capability is off -> filtered out
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search, 'calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain('open_url');
      expect(callArgs.tools).not.toContain(Tools.web_search);
    });

    it('does NOT inject open_url when web_search is simply absent', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: ['calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain('open_url');
    });

    it('does not double-add open_url if already present', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search, 'open_url'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      const occurrences = callArgs.tools.filter((t) => t === 'open_url').length;
      expect(occurrences).toBe(1);
    });
  });

  describe('execution path (definitionsOnly=false)', () => {
    it('injects open_url into the tools passed to loadTools when web_search is enabled', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        definitionsOnly: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).toContain('open_url');
    });

    it('does NOT inject open_url on the execution path when web_search is disabled', async () => {
      const capabilities = [AgentCapabilities.tools];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: ['calculator'] },
        definitionsOnly: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).not.toContain('open_url');
    });
  });
});

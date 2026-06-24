/**
 * [knauf] KK20-194 — open_url rides the web-search switch.
 *
 * These tests are the behavioural anchor for the three ToolService seams that
 * bind `open_url` presence exactly to `web_search` (add when on, strip when off):
 *   - loadToolDefinitionsWrapper  → model-facing definitions path (authoritative)
 *   - loadAgentTools (execution)  → runtime tool construction path
 *   - loadToolsForExecution       → fail-closed guard on lazy tool execution
 *
 * They fail if any seam is removed, if open_url stops being gated on web_search,
 * if a baked-in open_url is no longer stripped when web_search is off (the toggle
 * must stay authoritative), or if it gets double-added. Self-contained mock setup
 * mirrors ToolService.spec.js so the upstream test file stays untouched.
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

const { loadAgentTools, loadToolsForExecution } = require('../ToolService');

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

    it('STRIPS a baked-in open_url when web_search is absent (toggle stays authoritative)', async () => {
      // Simulates an agent created during an earlier default-on iteration: open_url
      // is stored in its tools, but web_search is off. open_url must NOT survive.
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: ['open_url', 'calculator'] },
        definitionsOnly: true,
      });

      const [callArgs] = mockLoadToolDefinitions.mock.calls[0];
      expect(callArgs.tools).not.toContain('open_url');
      expect(callArgs.tools).toContain('calculator');
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

    it('STRIPS a baked-in open_url on the execution path when web_search is absent', async () => {
      const capabilities = [AgentCapabilities.tools, AgentCapabilities.web_search];
      const req = createMockReq(capabilities);
      mockGetEndpointsConfig.mockResolvedValue(createEndpointsConfig(capabilities));

      await loadAgentTools({
        req,
        res: {},
        agent: { id: 'agent_123', tools: ['open_url', 'calculator'] },
        definitionsOnly: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).not.toContain('open_url');
      expect(callArgs.tools).toContain('calculator');
    });
  });

  describe('fail-closed execution guard (loadToolsForExecution)', () => {
    it('drops an open_url call when the agent has no web_search tool', async () => {
      const req = createMockReq([AgentCapabilities.tools]);

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123', tools: ['calculator'] },
        toolNames: ['open_url'],
        actionsEnabled: false,
      });

      // open_url was the only requested tool and it was stripped -> loadTools either
      // not called, or called without open_url.
      if (mockLoadToolsUtil.mock.calls.length > 0) {
        const [callArgs] = mockLoadToolsUtil.mock.calls[0];
        expect(callArgs.tools).not.toContain('open_url');
      } else {
        expect(mockLoadToolsUtil).not.toHaveBeenCalled();
      }
    });

    it('executes an open_url call when the agent has web_search enabled', async () => {
      const req = createMockReq([AgentCapabilities.tools, AgentCapabilities.web_search]);

      await loadToolsForExecution({
        req,
        res: {},
        agent: { id: 'agent_123', tools: [Tools.web_search] },
        toolNames: ['open_url'],
        actionsEnabled: false,
      });

      expect(mockLoadToolsUtil).toHaveBeenCalledTimes(1);
      const [callArgs] = mockLoadToolsUtil.mock.calls[0];
      expect(callArgs.tools).toContain('open_url');
    });
  });
});

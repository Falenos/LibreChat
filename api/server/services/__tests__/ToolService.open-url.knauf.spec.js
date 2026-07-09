/**
 * [knauf] KK20-194 — open_url rides the "Browse the internet" switch.
 *
 * These tests are the behavioural anchor for the three ToolService seams that
 * bind `open_url` presence to the RAW browse intent — `web_search` present in the
 * agent's OWN tools — independent of `endpoints.agents.capabilities` (add when on,
 * strip when off):
 *   - loadToolDefinitionsWrapper  → model-facing definitions path (authoritative)
 *   - loadAgentTools (execution)  → runtime tool construction path
 *   - loadToolsForExecution       → fail-closed guard on lazy tool execution
 *
 * Raw-intent gating is load-bearing: we deliberately keep `web_search` OUT of the
 * agents capability list so the provider-less LangChain web_search tool is never
 * surfaced (no GDPR-sensitive third-party search provider); the working search
 * engine is Azure's model-level web_search, and open_url is its prioritised
 * companion. So `open_url` must be injected whenever the agent carries web_search
 * in its tools EVEN IF the capability is absent, while the LangChain web_search
 * tool itself stays stripped.
 *
 * They fail if any seam is removed, if open_url stops being gated on the raw browse
 * intent, if the LangChain web_search tool starts leaking into the definitions, if
 * a baked-in open_url is no longer stripped when browse is off (the switch must stay
 * authoritative), or if open_url gets double-added. Self-contained mock setup
 * mirrors ToolService.spec.js so the upstream test file stays untouched.
 */

const { Tools, EModelEndpoint, AgentCapabilities } = require('librechat-data-provider');

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
  // v0.8.7: ToolService.loadTools now calls createMCPPermissionContext(req).
  createMCPPermissionContext: jest.fn(() => ({})),
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

    it('injects open_url on RAW browse intent even when web_search is NOT a capability, while the LangChain web_search tool stays stripped', async () => {
      // Option A (KK20-194): web_search is intentionally absent from
      // endpoints.agents.capabilities, so the capability filter strips the
      // provider-less LangChain web_search tool. open_url must still be injected
      // because the agent carries the raw browse intent (web_search in its tools).
      const capabilities = [AgentCapabilities.tools];
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
      // The LangChain web_search tool must NOT leak into the model-facing tools.
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

    it('does NOT inject open_url on the execution path when there is no browse intent', async () => {
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

    it('injects open_url on RAW browse intent even when web_search is NOT a capability', async () => {
      const capabilities = [AgentCapabilities.tools];
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
      expect(callArgs.tools).not.toContain(Tools.web_search);
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

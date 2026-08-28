const mongoose = require('mongoose');
const {
  ResourceType,
  PermissionBits,
  PrincipalType,
  PrincipalModel,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  Constants,
  // [knauf] KK20-243 — for the SKILLS.USE chat-path gate regression test.
  Permissions,
  PermissionTypes,
  // End [knauf]
} = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockInitializeAgent = jest.fn();
const mockValidateAgentModel = jest.fn();

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
  GenerationJobManager: { setCollectedUsage: jest.fn() },
  getCustomEndpointConfig: jest.fn(),
  createSequentialChainEdges: jest.fn(),
}));

/** Captured by the `getDefaultHandlers` mock so tests can drive the
 *  `ON_TOOL_EXECUTE` pipeline with a real subagent id and observe whether
 *  the tool context (agent, tool_resources, skill ACLs) was preserved. */
let capturedToolExecuteOptions;
jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn((opts) => {
    capturedToolExecuteOptions = opts?.toolExecuteOptions;
    return {};
  }),
}));

const mockLoadToolsForExecution = jest.fn();
jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn(),
  loadToolsForExecution: (...args) => mockLoadToolsForExecution(...args),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

let agentClientArgs;
jest.mock('~/server/controllers/agents/client', () => {
  return jest.fn().mockImplementation((args) => {
    agentClientArgs = args;
    return {};
  });
});

jest.mock('./addedConvo', () => ({
  processAddedConvo: jest.fn().mockResolvedValue({ userMCPAuthMap: undefined }),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

const { initializeClient } = require('./initialize');
const { getSkillToolDeps } = require('./skillDeps');
const { logger } = require('@librechat/data-schemas');
// [knauf] KK20-243 — `Role` for the SKILLS.USE chat-path gate regression test.
const { User, AclEntry, Role } = require('~/db/models');
// End [knauf]
const db = require('~/models');
const { createAgent, createSkill } = db;

jest.spyOn(logger, 'warn').mockImplementation(() => {});

const PRIMARY_ID = 'agent_primary';
const TARGET_ID = 'agent_target';
const AUTHORIZED_ID = 'agent_authorized';

describe('initializeClient — processAgent ACL gate', () => {
  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;

    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  const makeReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_1', files: [] },
    config: { endpoints: {} },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = (edges) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
  });

  it('should skip handoff agent and filter its edge when user lacks VIEW access', async () => {
    await createAgent({
      id: TARGET_ID,
      name: 'Target Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    const edges = [{ from: PRIMARY_ID, to: TARGET_ID, edgeType: 'handoff' }];
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig(edges));

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.edges).toEqual([]);
  });

  // [knauf] KK20-297 — keep request-scoped file tools available on follow-up turns.
  it('carries owner-authorized thread attachments into follow-up tool initialization', async () => {
    const req = makeReq();
    req.body.parentMessageId = 'assistant-1';
    const historicalFile = {
      file_id: 'idml-1',
      filename: 'datasheet.idml',
      type: 'application/vnd.adobe.indesign-idml-package',
      user: testUser._id.toString(),
    };
    jest.spyOn(db, 'getMessages').mockResolvedValueOnce([
      {
        messageId: 'user-1',
        parentMessageId: Constants.NO_PARENT,
        files: [{ file_id: historicalFile.file_id }],
      },
      { messageId: 'assistant-1', parentMessageId: 'user-1' },
    ]);
    const getFiles = jest.spyOn(db, 'getFiles').mockResolvedValueOnce([historicalFile]);
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ requestFiles: [historicalFile] }),
      expect.any(Object),
    );
    expect(req.body.files).toEqual([]);
    expect(req.knaufToolFiles).toEqual([historicalFile]);
    expect(getFiles).toHaveBeenCalledWith(
      { file_id: { $in: [historicalFile.file_id] }, user: testUser._id.toString() },
      null,
      { text: 0 },
    );
  });
  // End [knauf]

  it('should initialize handoff agent and keep its edge when user has VIEW access', async () => {
    const authorizedAgent = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Authorized Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: authorizedAgent._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const requestAttachment = { file_id: 'request_file', filename: 'request.txt' };
    const primaryContextAttachment = { file_id: 'primary_context', filename: 'primary.txt' };
    const handoffContextAttachment = { file_id: 'handoff_context', filename: 'handoff.txt' };
    const primaryConfig = {
      ...makePrimaryConfig(edges),
      attachments: [primaryContextAttachment, requestAttachment],
      requestAttachments: [requestAttachment],
      agentContextAttachments: [primaryContextAttachment],
    };
    const handoffConfig = {
      id: AUTHORIZED_ID,
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      agentContextAttachments: [handoffContextAttachment],
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? Promise.resolve(primaryConfig) : Promise.resolve(handoffConfig);
    });

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.edges).toHaveLength(1);
    expect(agentClientArgs.agent.edges[0].to).toBe(AUTHORIZED_ID);
    expect(agentClientArgs.attachments).toEqual([requestAttachment]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(PRIMARY_ID)).toEqual([
      primaryContextAttachment,
    ]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(AUTHORIZED_ID)).toEqual([
      handoffContextAttachment,
    ]);
  });

  it('does not enable skill authoring for VIEW-only shared skills', async () => {
    const { skill } = await createSkill({
      name: 'shared-view-only',
      description: 'Use for read-only sharing.',
      body: '# Shared view-only skill\n',
      author: new mongoose.Types.ObjectId(),
      authorName: 'Skill Owner',
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const endpointOption = makeEndpointOption();
    endpointOption.agent = Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      skills_enabled: true,
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(false);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.accessibleSkillIds.map(String)).toContain(skill._id.toString());
    expect(initializeParams.skillAuthoringAvailable).toBe(false);
  });

  it('adds ready project knowledge files to the primary agent request files', async () => {
    const projectId = new mongoose.Types.ObjectId();
    await mongoose.models.ChatProject.create({
      _id: projectId,
      user: testUser._id,
      name: 'Sample Project',
      instructions: 'Use project docs',
    });
    await mongoose.models.File.create({
      user: testUser._id,
      file_id: 'project-file-1',
      filename: 'project-knowledge.txt',
      filepath: '/uploads/project-knowledge.txt',
      type: 'text/plain',
      source: 'azure_blob',
      embedded: true,
      bytes: 16,
    });
    await mongoose.models.ChatProjectSource.create({
      user: testUser._id,
      projectId,
      file_id: 'project-file-1',
      sourceType: 'file',
      status: 'ready',
    });

    const endpointOption = makeEndpointOption();
    endpointOption.chatProjectId = projectId.toString();
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption,
    });

    expect(mockInitializeAgent.mock.calls[0][0].requestFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_id: 'project-file-1',
          filename: 'project-knowledge.txt',
          embedded: true,
        }),
      ]),
    );
  });

  // [knauf] KK20-243 — SKILLS.USE must gate the CHAT path, not only the REST routes.
  /**
   * Before this, `skillsCapabilityEnabled` came from `endpoints.agents.capabilities`
   * alone. `accessibleSkillIds` was then built from resource ACLs — a different
   * authorization axis — and `withDeploymentSkillIds` appended every deployment
   * skill unconditionally. So a role with `SKILLS.USE: false` still received the
   * catalog and could invoke `karl-brand` / `karl-artifacts` in a default KARL
   * chat. KK20-286 fixed the missing AGENT_BUILDER role fields at startup, but
   * this test still proves an explicit Admin denial is enforced during a run.
   *
   * Two role names rather than one document toggled twice, because
   * `getRoleByName` memoises per name and a flipped document can be served stale.
   * Neither is a system role, so `getRoleByName` will not auto-create it from
   * `roleDefaults` (where SKILLS.USE is true) and mask the assertion.
   */
  const seedRole = (name, skillsUse) =>
    Role.create({
      name,
      permissions: {
        [PermissionTypes.SKILLS]: {
          [Permissions.USE]: skillsUse,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: false,
        },
      },
    });

  /** A skill the user holds a VIEW ACL on — so only the permission can deny it. */
  const grantViewOnNewSkill = async (name) => {
    const { skill } = await createSkill({
      name,
      description: 'Use for the SKILLS.USE gate regression test.',
      body: '# Gate test skill\n',
      author: new mongoose.Types.ObjectId(),
      authorName: 'Skill Owner',
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
    return skill;
  };

  const initializeWithRole = async (role) => {
    const endpointOption = makeEndpointOption();
    endpointOption.agent = Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      skills_enabled: true,
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.user.role = role;
    req.config.endpoints.agents = { capabilities: ['skills'] };

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption,
    });

    return mockInitializeAgent.mock.calls[0][0];
  };

  it('withholds every skill from a chat when the role denies SKILLS.USE', async () => {
    await seedRole('KNAUF_GATE_DENIED', false);
    const skill = await grantViewOnNewSkill('gate-denied-skill');

    const initializeParams = await initializeWithRole('KNAUF_GATE_DENIED');

    // Empty, not merely missing the ACL skill: `[]` is what the gated ternary
    // produces, which is also what stops the unconditional deployment merge.
    expect(initializeParams.accessibleSkillIds).toEqual([]);
    expect(initializeParams.accessibleSkillIds.map(String)).not.toContain(skill._id.toString());
    expect(initializeParams.skillAuthoringAvailable).toBe(false);
  });

  it('admits skills for the same shape of role once SKILLS.USE is granted', async () => {
    // The control. Without this, the test above could pass for an unrelated
    // reason — a non-system role failing some other lookup, say — and we would
    // believe the gate worked when nothing was being gated.
    await seedRole('KNAUF_GATE_ALLOWED', true);
    const skill = await grantViewOnNewSkill('gate-allowed-skill');

    const initializeParams = await initializeWithRole('KNAUF_GATE_ALLOWED');

    expect(initializeParams.accessibleSkillIds.map(String)).toContain(skill._id.toString());
  });
  // End [knauf]

  it('enables skill authoring when model specs enable skills for an ephemeral agent', async () => {
    const endpointOption = makeEndpointOption();
    endpointOption.spec = 'spec-skills';
    endpointOption.agent = Promise.resolve({
      id: Constants.EPHEMERAL_AGENT_ID,
      name: 'Ephemeral Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    req.config.modelSpecs = {
      list: [{ name: 'spec-skills', skills: true }],
    };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(true);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.agent.skills_enabled).toBe(true);
    expect(initializeParams.skillAuthoringAvailable).toBe(true);
  });
});

describe('initializeClient — subagent loading', () => {
  const SUBAGENT_ID = 'agent_subagent_1';
  const DUPLICATE_SUBAGENT_ID = 'agent_subagent_dup';
  const HANDOFF_AND_SUB_ID = 'agent_handoff_and_sub';

  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;
    capturedToolExecuteOptions = undefined;
    mockLoadToolsForExecution.mockReset();
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [] });

    testUser = await User.create({
      email: 'subagent@example.com',
      name: 'Subagent User',
      username: 'subuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  /** Grant the test user VIEW on an agent so processAgent loads it. */
  const grantView = async (agentDoc) => {
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: agentDoc._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
  };

  /** Build a request with the `subagents` capability enabled. */
  const makeSubagentReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_sub', files: [] },
    config: {
      endpoints: {
        agents: {
          capabilities: ['subagents'],
        },
      },
    },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = ({ edges = [], subagents, agent_ids }) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
    subagents,
    agent_ids,
  });

  const makeSubagentConfig = (id) => ({
    id,
    endpoint: 'agents',
    edges: [],
    toolDefinitions: [{ name: 'web', description: 'web', parameters: {} }],
    toolRegistry: new Map([['web', { name: 'web' }]]),
    userMCPAuthMap: null,
    tool_resources: { file_search: { file_ids: ['file_1'] } },
    accessibleSkillIds: ['skill_1'],
    actionsEnabled: true,
    resendFiles: false,
    maxContextTokens: 4096,
  });

  const makeNestedSubagentConfig = (id, childIds = []) => ({
    ...makeSubagentConfig(id),
    subagents: { enabled: true, allowSelf: false, agent_ids: childIds },
  });

  const createViewableAgent = async (id) => {
    const agent = await createAgent({
      id,
      name: id,
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(agent);
    return agent;
  };

  it('loads a configured subagent, populates `subagentAgentConfigs`, and keeps it out of `agentConfigs`', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    let subagentConvoFileIds;
    mockInitializeAgent.mockImplementation(async (params, dbDeps) => {
      call += 1;
      if (call === 1) {
        return primaryConfig;
      }
      subagentConvoFileIds = await dbDeps.getConvoFiles(params.conversationId);
      return subagentConfig;
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    const subagentDbDeps = mockInitializeAgent.mock.calls[1][1];
    expect(subagentDbDeps.getConvoFiles).toBeInstanceOf(Function);
    expect(subagentDbDeps.db).toBeUndefined();
    expect(subagentConvoFileIds).toEqual([]);

    /** The subagent's AgentConfig is attached to the primary for run.ts to
     *  turn into `SubagentConfig[]` on the parent's `AgentInputs`. */
    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    expect(agentClientArgs.agent.subagentAgentConfigs[0].id).toBe(SUBAGENT_ID);

    /** Subagent-only agents must NOT appear in `agentConfigs` — otherwise the
     *  graph would treat them as a parallel/handoff node. */
    expect(agentClientArgs.agentConfigs).toBeDefined();
    expect(agentClientArgs.agentConfigs.has(SUBAGENT_ID)).toBe(false);
  });

  it('preserves subagent tool context for ON_TOOL_EXECUTE (Codex P1 regression guard)', async () => {
    /** Verifies the Codex P1 fix: `agentToolContexts.delete(subagentId)` is
     *  NOT called for subagent-only agents, so when the child dispatches
     *  `ON_TOOL_EXECUTE` the parent can still resolve its tool context
     *  (agent, tool_resources, skill ACLs, actionsEnabled) to run tools
     *  with the right scope. We drive the real `loadTools` closure that
     *  `initializeClient` wires into `toolExecuteOptions`. */
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : subagentConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);

    /** Invoke the real closure with the subagent's id. If `agentToolContexts`
     *  had been deleted (as in the pre-fix code), this would call
     *  `loadToolsForExecution` with `agent: undefined` — actions/resource-
     *  scoped tools would silently drop. */
    await capturedToolExecuteOptions.loadTools(['web'], SUBAGENT_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    const arg = mockLoadToolsForExecution.mock.calls[0][0];
    expect(arg.agent).toBeDefined();
    expect(arg.agent.id).toBe(SUBAGENT_ID);
    expect(arg.toolRegistry).toBeInstanceOf(Map);
    expect(arg.tool_resources).toEqual({ file_search: { file_ids: ['file_1'] } });
    expect(arg.actionsEnabled).toBe(true);
  });

  it('threads run-scoped MCP tool definitions into ON_TOOL_EXECUTE loading', async () => {
    /** Regression guard for the request-scoped MCP/PTC handoff: the
     *  `mcpAvailableTools` discovered at run start must survive
     *  `buildAgentToolContext` and reach `loadToolsForExecution`, otherwise
     *  request-scoped servers reinitialize on every programmatic tool call
     *  and can trip the MCP circuit breaker under parallel calls. */
    const mcpTool = 'list_tables_mcp_ClickHouse';
    const mcpAvailableTools = {
      ClickHouse: {
        [mcpTool]: {
          type: 'function',
          function: {
            name: mcpTool,
            description: 'List tables',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    };
    const primaryConfig = {
      ...makePrimaryConfig({}),
      toolRegistry: new Map([[mcpTool, { name: mcpTool }]]),
      mcpAvailableTools,
    };
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);
    await capturedToolExecuteOptions.loadTools([mcpTool], PRIMARY_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAvailableTools }),
    );
  });

  it('deduplicates repeated ids in subagents.agent_ids', async () => {
    const subAgent = await createAgent({
      id: DUPLICATE_SUBAGENT_ID,
      name: 'Dup Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: {
        enabled: true,
        allowSelf: false,
        /** Same id three times — the backend must not load the agent
         *  repeatedly and must not emit three SubagentConfig entries. */
        agent_ids: [DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID],
      },
    });
    const subagentConfig = makeSubagentConfig(DUPLICATE_SUBAGENT_ID);

    let initCalls = 0;
    mockInitializeAgent.mockImplementation(() => {
      initCalls += 1;
      return Promise.resolve(initCalls === 1 ? primaryConfig : subagentConfig);
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** One call for primary, one for the subagent — not four. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
  });

  it('rejects nested subagent chains deeper than MAX_SUBAGENT_DEPTH', async () => {
    const ids = Array.from(
      { length: MAX_SUBAGENT_DEPTH + 1 },
      (_, index) => `agent_depth_${index}`,
    );
    for (const id of ids) {
      await createViewableAgent(id);
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [ids[0]] },
    });
    const nestedConfigs = new Map(
      ids.map((id, index) => [
        id,
        makeNestedSubagentConfig(id, index < ids.length - 1 ? [ids[index + 1]] : []),
      ]),
    );

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph depth limit exceeded',
      expect.objectContaining({
        agentId: `agent_depth_${MAX_SUBAGENT_DEPTH - 1}`,
        primaryAgentId: PRIMARY_ID,
        depth: MAX_SUBAGENT_DEPTH,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
        childCount: 1,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('preserves deeper path depth when a handoff root is also a nested subagent', async () => {
    const chainIds = Array.from(
      { length: MAX_SUBAGENT_DEPTH },
      (_, index) => `agent_overlap_depth_${index}`,
    );
    const allIds = [HANDOFF_AND_SUB_ID, ...chainIds];
    for (const id of allIds) {
      await createViewableAgent(id);
    }

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: false, agent_ids: [HANDOFF_AND_SUB_ID] },
    });
    const nestedConfigs = new Map([
      [HANDOFF_AND_SUB_ID, makeNestedSubagentConfig(HANDOFF_AND_SUB_ID, [chainIds[0]])],
      ...chainIds.map((id, index) => [
        id,
        makeNestedSubagentConfig(id, index < chainIds.length - 1 ? [chainIds[index + 1]] : []),
      ]),
    ]);

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph depth limit exceeded',
      expect.objectContaining({
        primaryAgentId: PRIMARY_ID,
        depth: MAX_SUBAGENT_DEPTH,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
        childCount: 1,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('rejects subagent graphs that exceed MAX_SUBAGENT_GRAPH_NODES unique agents', async () => {
    const firstLevelIds = Array.from({ length: 10 }, (_, index) => `agent_graph_${index}`);
    const secondLevelIdsByParent = new Map(
      firstLevelIds.map((id) => [
        id,
        Array.from({ length: 5 }, (_, index) => `${id}_child_${index}`),
      ]),
    );
    const allIds = [...firstLevelIds, ...Array.from(secondLevelIdsByParent.values()).flat()];

    for (const id of allIds) {
      await createViewableAgent(id);
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: firstLevelIds },
    });
    const nestedConfigs = new Map(
      firstLevelIds.map((id) => [id, makeNestedSubagentConfig(id, secondLevelIdsByParent.get(id))]),
    );
    for (const id of Array.from(secondLevelIdsByParent.values()).flat()) {
      nestedConfigs.set(id, makeNestedSubagentConfig(id));
    }

    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : nestedConfigs.get(agent.id)),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph node limit exceeded',
      expect.objectContaining({
        primaryAgentId: PRIMARY_ID,
        loadedSubagentCount: MAX_SUBAGENT_GRAPH_NODES,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('keeps an agent in `agentConfigs` when it is BOTH a handoff target and a subagent', async () => {
    /** Overlap case: the same child is used both via handoff edges (needs to
     *  be in agentConfigs) and as a subagent (needs to be in
     *  subagentAgentConfigs, and its tool context preserved). The pipeline
     *  shouldn't silently drop it from the handoff map. */
    const shared = await createAgent({
      id: HANDOFF_AND_SUB_ID,
      name: 'Shared Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(shared);

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: {
        enabled: true,
        allowSelf: false,
        agent_ids: [HANDOFF_AND_SUB_ID],
      },
    });
    const sharedConfig = makeSubagentConfig(HANDOFF_AND_SUB_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : sharedConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    /** Shared agent must stay in agentConfigs — it's still the handoff target. */
    expect(agentClientArgs.agentConfigs.has(HANDOFF_AND_SUB_ID)).toBe(true);
  });

  it('clears subagents config on primary when the capability is disabled', async () => {
    /** Admin can turn subagents off at the endpoint level even if an agent was
     *  configured for them. The primary's `subagents` field should be
     *  suppressed so run.ts never builds a SubagentConfig. */
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    const req = makeSubagentReq();
    /** Remove the capability from the admin config. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagents).toBeUndefined();
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });

  it('clears subagents on handoff agents too when capability is disabled (Codex P2 regression)', async () => {
    /** Codex P2: the capability gate must suppress `subagents` on EVERY
     *  loaded config, not just the primary. `run.ts` iterates all agents
     *  and calls `buildSubagentConfigs` per agent, so a handoff target
     *  with `subagents.enabled: true` persisted on its document would
     *  otherwise still expose self-spawn even when the admin has disabled
     *  the capability globally. */
    const authorized = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Handoff Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(authorized);

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    const handoffConfig = {
      id: AUTHORIZED_ID,
      endpoint: 'agents',
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      /** Handoff agent document has subagents enabled of its own accord. */
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++callCount === 1 ? primaryConfig : handoffConfig),
    );

    const req = makeSubagentReq();
    /** Capability OFF at endpoint level. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Primary cleared. */
    expect(agentClientArgs.agent.subagents).toBeUndefined();
    /** Handoff target must ALSO be cleared — otherwise its self-spawn
     *  would still fire when run.ts iterates agentConfigs. */
    const handoffLoaded = agentClientArgs.agentConfigs.get(AUTHORIZED_ID);
    expect(handoffLoaded).toBeDefined();
    expect(handoffLoaded.subagents).toBeUndefined();
    expect(handoffLoaded.subagentAgentConfigs).toBeUndefined();
  });

  it('skips subagent loading entirely when the feature is disabled on the agent', async () => {
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: false, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Only one initializeAgent call — for the primary. No subagent loaded. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });
});

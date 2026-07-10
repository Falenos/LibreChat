const mockDataProvider = {
  Capabilities: {
    actions: 'actions',
    code_interpreter: 'code_interpreter',
    image_vision: 'image_vision',
    retrieval: 'retrieval',
    tools: 'tools',
  },
  EModelEndpoint: {
    agents: 'agents',
    anthropic: 'anthropic',
    assistants: 'assistants',
    azureAssistants: 'azureAssistants',
    azureOpenAI: 'azureOpenAI',
    bedrock: 'bedrock',
    google: 'google',
    openAI: 'openAI',
  },
  defaultAgentCapabilities: [],
  defaultRetrievalModels: [],
  defaultAssistantsVersion: {
    assistants: 1,
    azureAssistants: 2,
  },
  isAgentsEndpoint: (endpoint) => endpoint === 'agents',
  isAssistantsEndpoint: (endpoint) => endpoint === 'assistants' || endpoint === 'azureAssistants',
  // [knauf] Complete the data-provider mock with ResourceType so that if the real
  // @librechat/api -> @librechat/data-schemas chain loads, its capabilities.ts init
  // (ResourceCapabilityMap, keyed by ResourceType) does not throw "Cannot read
  // properties of undefined (reading 'AGENT')". This surfaced only in CI, where this
  // spec shares a jest worker with one that already loaded the real @librechat/api.
  ResourceType: {
    AGENT: 'agent',
    PROMPTGROUP: 'promptGroup',
    MCPSERVER: 'mcpServer',
    REMOTE_AGENT: 'remoteAgent',
    SKILL: 'skill',
    SHARED_LINK: 'sharedLink',
  },
  // End [knauf]
};

// [knauf] Drop `virtual: true` — @librechat/api is a real, resolvable workspace package.
// A virtual mock of a resolvable module is not reliably re-applied after jest.resetModules()
// once the real module has been loaded by another spec in the same CI worker, which lets the
// real dist (and its data-schemas capabilities.ts init) load instead of this stub.
jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  isEnabled: (value) => value === true || value === 'true' || value === '1',
  isUserProvided: (value) => value === 'user_provided',
}));
// End [knauf]

jest.mock('librechat-data-provider', () => mockDataProvider, { virtual: true });

jest.mock('~/server/utils/handleText', () => ({
  generateConfig: (key) => (key ? { userProvide: key === 'user_provided' } : false),
}));

describe('EndpointService', () => {
  let originalEnv;
  const { EModelEndpoint } = mockDataProvider;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  function loadConfig(env) {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_USE_VERTEX;
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    delete process.env.BEDROCK_AWS_SESSION_TOKEN;
    delete process.env.BEDROCK_AWS_BEARER_TOKEN;
    delete process.env.BEDROCK_AWS_PROFILE;
    delete process.env.BEDROCK_AWS_DEFAULT_REGION;
    Object.assign(process.env, env);
    return require('../EndpointService').config;
  }

  it('does not require a user Anthropic API key when Vertex AI is enabled by env', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'user_provided',
      ANTHROPIC_USE_VERTEX: 'true',
    });

    expect(config[EModelEndpoint.anthropic]).toEqual({ userProvide: false });
  });

  it('requires a user Anthropic API key when user_provided is set without Vertex AI', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'user_provided',
    });

    expect(config[EModelEndpoint.anthropic]).toEqual({ userProvide: true });
  });

  it('requires a user Bedrock key when bearer token user_provided is set with a legacy static secret', () => {
    const config = loadConfig({
      BEDROCK_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
      BEDROCK_AWS_BEARER_TOKEN: 'user_provided',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: true });
  });

  it('enables Bedrock with static bearer token before static secret credentials', () => {
    const config = loadConfig({
      BEDROCK_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
      BEDROCK_AWS_BEARER_TOKEN: 'bedrock-api-key',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: false });
  });

  it('skips blank optional Bedrock env vars before falling back to region', () => {
    const config = loadConfig({
      BEDROCK_AWS_BEARER_TOKEN: '',
      BEDROCK_AWS_PROFILE: '',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: false });
  });
});

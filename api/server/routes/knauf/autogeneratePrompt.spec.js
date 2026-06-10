jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  getProviderConfig: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
  getTenantId: jest.fn().mockReturnValue('tenant-1'),
}));

jest.mock('@librechat/agents', () => ({
  initializeModel: jest.fn(),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn(),
  SystemMessage: jest.fn(),
}));

jest.mock('~/models', () => ({
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  specialVariables: { current_date: '', current_user: '' },
  EModelEndpoint: { azureOpenAI: 'azureOpenAI', openAI: 'openAI' },
}));

const express = require('express');
const request = require('supertest');
const { getAppConfig } = require('~/server/services/Config');
const { getProviderConfig } = require('@librechat/api');
const { initializeModel } = require('@librechat/agents');

const router = require('./autogeneratePrompt');
const { buildUserMessage } = require('./autogeneratePrompt');

const app = express();
app.use('/', router);

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_SPEC = {
  name: 'karl-autogenerate-prompt',
  preset: {
    endpoint: 'openAI',
    model: 'gpt-4o',
    promptPrefix: 'Draft agent instructions.',
    max_completion_tokens: 500,
  },
};

function makeConfig(specOverride) {
  return {
    modelSpecs: { list: [specOverride ?? VALID_SPEC] },
  };
}

function makeGetOptions(llmConfig = { apiKey: 'test-key' }) {
  return jest.fn().mockResolvedValue({ llmConfig, configOptions: {} });
}

// ── buildUserMessage (pure) ────────────────────────────────────────────────

describe('buildUserMessage', () => {
  const minInput = () => ({
    agent: {
      name: 'KARL',
      description: '',
      category: '',
      personality: { label: '', description: '' },
      capabilities: [],
      knowledgeFileCount: 0,
      tools: [],
      mcpServers: [],
    },
    currentDraft: '',
  });

  it('always includes agent name and variables lines', () => {
    const msg = buildUserMessage(minInput());
    expect(msg).toContain('Agent name: KARL');
    expect(msg).toContain('Available variables (replaced at chat time):');
    expect(msg).toContain('{{current_date}}');
  });

  it('falls back to "this agent" when name is blank', () => {
    const input = minInput();
    input.agent.name = '  ';
    const msg = buildUserMessage(input);
    expect(msg).toContain('Agent name: this agent');
  });

  it('omits empty optional lines so the message has no blank entries', () => {
    const msg = buildUserMessage(minInput());
    // description, category, personality lines should not appear
    expect(msg).not.toContain("What it's for:");
    expect(msg).not.toContain('Category:');
    expect(msg).not.toContain('Personality:');
    // capabilities default line should appear
    expect(msg).toContain('What it can do: reply from its own knowledge only');
  });

  it('wraps currentDraft in triple-quotes when present', () => {
    const input = minInput();
    input.currentDraft = 'You are a helpful bot.';
    const msg = buildUserMessage(input);
    expect(msg).toContain("User's draft:");
    expect(msg).toContain('"""');
    expect(msg).toContain('You are a helpful bot.');
  });

  it('includes all populated fields', () => {
    const input = {
      agent: {
        name: 'Sales Bot',
        description: 'Handles sales enquiries',
        category: 'Sales',
        personality: { label: 'Precise', description: 'Sticks to the facts.' },
        capabilities: ['Browse the internet'],
        knowledgeFileCount: 3,
        tools: ['Web Search'],
        mcpServers: ['sharepoint'],
      },
      currentDraft: '',
    };
    const msg = buildUserMessage(input);
    expect(msg).toContain("What it's for: Handles sales enquiries");
    expect(msg).toContain('Category: Sales');
    expect(msg).toContain('Personality: Precise');
    expect(msg).toContain('What it can do: Browse the internet');
    expect(msg).toContain('Knowledge: 3 attached documents');
    expect(msg).toContain('Tools available: Web Search');
    expect(msg).toContain('MCP servers connected: sharepoint');
  });
});

// ── POST / ────────────────────────────────────────────────────────────────

describe('POST /', () => {
  const VALID_BODY = { agent: {} };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 for invalid body (knowledgeFileCount is not a number)', async () => {
    const res = await request(app)
      .post('/')
      .send({ agent: { knowledgeFileCount: 'bad' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid request body.');
    expect(res.body.issues).toBeDefined();
  });

  it('returns 500 when the autogenerate spec is missing from modelSpecs', async () => {
    getAppConfig.mockResolvedValue({ modelSpecs: { list: [] } });
    const res = await request(app).post('/').send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/not configured/i);
  });

  it('returns 500 when spec has no endpoint or model', async () => {
    getAppConfig.mockResolvedValue(
      makeConfig({ name: 'karl-autogenerate-prompt', preset: {} }),
    );
    const res = await request(app).post('/').send(VALID_BODY);
    expect(res.status).toBe(500);
  });

  it('returns 502 when the LLM returns an empty completion', async () => {
    getAppConfig.mockResolvedValue(makeConfig());
    getProviderConfig.mockReturnValue({ getOptions: makeGetOptions() });
    const mockInvoke = jest.fn().mockResolvedValue({ content: '   ' });
    initializeModel.mockReturnValue({ invoke: mockInvoke });

    const res = await request(app).post('/').send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('No draft was returned.');
  });

  it('returns 200 with the generated text on success', async () => {
    getAppConfig.mockResolvedValue(makeConfig());
    getProviderConfig.mockReturnValue({ getOptions: makeGetOptions() });
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'You are a sales expert.' });
    initializeModel.mockReturnValue({ invoke: mockInvoke });

    const res = await request(app)
      .post('/')
      .send({ agent: { name: 'Sales Bot' } });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('You are a sales expert.');
    // Lock in the provider-agnostic contract: we feed the YAML-resolved
    // provider straight to @librechat/agents' single entry point.
    expect(initializeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openAI',
        clientOptions: expect.objectContaining({
          streaming: false,
          disableStreaming: true,
        }),
      }),
    );
  });

  it('switches provider from azureOpenAI to openAI when useResponsesApi is active', async () => {
   const azureSpec = {
     name: 'karl-autogenerate-prompt',
     preset: {
       endpoint: 'azureOpenAI',
       model: 'gpt-4o',
       promptPrefix: 'Draft agent instructions.',
       max_completion_tokens: 500,
     },
   };
   getAppConfig.mockResolvedValue(makeConfig(azureSpec));
   // Simulate the config pipeline output when web_search triggers useResponsesApi:
   // Azure fields are stripped, apiKey + baseURL are set instead.
   getProviderConfig.mockReturnValue({
     getOptions: makeGetOptions({ apiKey: 'test-key', useResponsesApi: true }),
   });
   const mockInvoke = jest.fn().mockResolvedValue({ content: 'Generated instructions.' });
   initializeModel.mockReturnValue({ invoke: mockInvoke });

   const res = await request(app).post('/').send(VALID_BODY);

   expect(res.status).toBe(200);
   expect(res.body.text).toBe('Generated instructions.');
   // Must use 'openAI' (ChatOpenAI), not 'azureOpenAI' (AzureChatOpenAI),
   // because the Azure fields were stripped by constructAzureResponsesApi.
   const call = initializeModel.mock.calls[0][0];
   expect(call.provider).toBe('openAI');
   // Responses API uses max_output_tokens, not max_completion_tokens.
   expect(call.clientOptions.modelKwargs).toHaveProperty('max_output_tokens', 500);
   expect(call.clientOptions.modelKwargs).not.toHaveProperty('max_completion_tokens');
  });

  it('keeps azureOpenAI provider when useResponsesApi is not active', async () => {
   const azureSpec = {
    name: 'karl-autogenerate-prompt',
    preset: {
      endpoint: 'azureOpenAI',
      model: 'gpt-4o',
      promptPrefix: 'Draft agent instructions.',
      max_completion_tokens: 500,
    },
   };
   getAppConfig.mockResolvedValue(makeConfig(azureSpec));
   getProviderConfig.mockReturnValue({
    getOptions: makeGetOptions({ apiKey: 'test-key' }),
   });
   const mockInvoke = jest.fn().mockResolvedValue({ content: 'Generated instructions.' });
   initializeModel.mockReturnValue({ invoke: mockInvoke });

   const res = await request(app).post('/').send(VALID_BODY);

   expect(res.status).toBe(200);
   const call = initializeModel.mock.calls[0][0];
   expect(call.provider).toBe('azureOpenAI');
   // Completions API uses max_completion_tokens.
   expect(call.clientOptions.modelKwargs).toHaveProperty('max_completion_tokens', 500);
   expect(call.clientOptions.modelKwargs).not.toHaveProperty('max_output_tokens');
  });
});

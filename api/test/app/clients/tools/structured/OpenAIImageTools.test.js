const mockFormDataInstances = [];
const { Readable } = require('stream');
const axios = require('axios');
const OpenAI = require('openai');
const createOpenAIImageTools = require('~/app/clients/tools/structured/OpenAIImageTools');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

jest.mock(
  'form-data',
  () =>
    class MockFormData {
      constructor() {
        this.fields = [];
        mockFormDataInstances.push(this);
      }

      append(name, value) {
        this.fields.push([name, value]);
      }

      getHeaders() {
        return {};
      }
    },
);

// [knauf] Mock image usage transaction ledger used by the FinOps cost visibility seam.
const mockSpendTokens = jest.fn();
const mockSpendStructuredTokens = jest.fn();
// End [knauf]

jest.mock('openai');
jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  oaiToolkit: {
    image_gen_oai: {
      name: 'image_gen_oai',
      description: 'Generate an image',
      schema: {},
    },
    image_edit_oai: {
      name: 'image_edit_oai',
      description: 'Edit an image',
      schema: {},
    },
  },
  extractBaseURL: jest.fn((url) => url),
  // [knauf] Provide cost-ledger config helpers consumed by image usage recording.
  getBalanceConfig: jest.fn(() => ({ enabled: false })),
  getTransactionsConfig: jest.fn(() => ({ enabled: true })),
  // End [knauf]
  getProxyDispatcher: jest.fn(() => undefined),
  applyAxiosProxyConfig: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
  // [knauf] Assert image usage flows through the same transaction path as chat tokens.
  spendTokens: (...args) => mockSpendTokens(...args),
  spendStructuredTokens: (...args) => mockSpendStructuredTokens(...args),
  // End [knauf]
}));

describe('OpenAIImageTools - IMAGE_GEN_OAI_MODEL environment variable', () => {
  let originalEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFormDataInstances.length = 0;
    // [knauf] Reset image usage transaction mock between cost visibility cases.
    mockSpendTokens.mockResolvedValue(undefined);
    mockSpendStructuredTokens.mockResolvedValue(undefined);
    // End [knauf]
    originalEnv = { ...process.env };

    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';

    OpenAI.mockImplementation(() => ({
      images: {
        generate: jest.fn().mockResolvedValue({
          data: [
            {
              b64_json: 'base64-encoded-image-data',
            },
          ],
        }),
      },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use default model "gpt-image-2" when IMAGE_GEN_OAI_MODEL is not set', async () => {
    delete process.env.IMAGE_GEN_OAI_MODEL;

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2',
      }),
      expect.any(Object),
    );
  });

  it('should use "gpt-image-1.5" when IMAGE_GEN_OAI_MODEL is set to "gpt-image-1.5"', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'gpt-image-1.5';

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-1.5',
      }),
      expect.any(Object),
    );
  });

  it('should use custom model name from IMAGE_GEN_OAI_MODEL environment variable', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'custom-image-model';

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-image-model',
      }),
      expect.any(Object),
    );
  });

  // [knauf] Pin GPT Image usage to conversation/message transaction records for cost visibility.
  it('records image generation token usage in the transaction ledger', async () => {
    delete process.env.IMAGE_GEN_OAI_MODEL;

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
      usage: {
        input_tokens: 123,
        output_tokens: 456,
        input_tokens_details: {
          text_tokens: 23,
          image_tokens: 100,
        },
      },
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' }, config: {} },
    });

    await imageGenTool.func({ prompt: 'test prompt' }, undefined, {
      configurable: { thread_id: 'conversation-1', run_id: 'message-1' },
    });

    expect(mockSpendStructuredTokens).toHaveBeenCalledWith(
      {
        user: 'test-user',
        model: 'gpt-image-2',
        messageId: 'message-1',
        conversationId: 'conversation-1',
        context: 'image_generation',
        balance: { enabled: false },
        transactions: { enabled: true },
      },
      {
        promptTokens: { input: 23, write: 100 },
        completionTokens: 456,
      },
    );
  });
  // End [knauf]

  // [knauf] KK20-168 — pin GPT Image 2 generation/edit output payloads.
  it('sends one generated image with the requested GPT Image 2 output controls', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'gpt-image-2';
    const mockGenerate = jest.fn().mockResolvedValue({
      data: [{ b64_json: 'base64-encoded-image-data' }],
    });
    OpenAI.mockImplementation(() => ({ images: { generate: mockGenerate } }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    await imageGenTool.func({
      prompt: 'test prompt',
      background: 'opaque',
      output_format: 'jpeg',
      output_compression: 85,
      quality: 'medium',
      size: '1536x1024',
    });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2',
        n: 1,
        background: 'opaque',
        output_format: 'jpeg',
        output_compression: 85,
        quality: 'medium',
        size: '1536x1024',
      }),
      expect.any(Object),
    );
  });

  it('sends matching GPT Image 2 output controls for edits', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'gpt-image-2';
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from('image')),
    });
    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: 'edited-base64-image-data' }] },
    });

    const [, imageEditTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
      imageFiles: [
        {
          file_id: 'image-1',
          source: 'local',
          filepath: '/tmp/image.png',
          filename: 'image.png',
          type: 'image/png',
        },
      ],
    });

    const result = await imageEditTool.func({
      prompt: 'change only the lighting',
      image_ids: ['image-1'],
      background: 'opaque',
      output_format: 'jpeg',
      output_compression: 85,
      quality: 'high',
      size: '1024x1536',
    });

    const fields = mockFormDataInstances[0].fields;
    expect(fields).toEqual(
      expect.arrayContaining([
        ['model', 'gpt-image-2'],
        ['background', 'opaque'],
        ['output_format', 'jpeg'],
        ['output_compression', '85'],
        ['quality', 'high'],
        ['size', '1024x1536'],
      ]),
    );
    expect(result[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });
  // End [knauf]
});

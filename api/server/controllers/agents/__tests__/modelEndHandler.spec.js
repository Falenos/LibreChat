jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  emitEvent: jest.fn(),
  createToolExecuteHandler: jest.fn(),
  markSummarizationUsage: (usage) => usage,
}));
jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));
jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

const {
  ModelEndHandler,
  createZeroUsageRefusalRetryHandler,
  isZeroUsageGenericRefusal,
  stripRetriedGenericRefusal,
} = require('../callbacks');

const buildGraph = () => ({
  getAgentContext: () => ({
    provider: 'vertexai',
    clientOptions: { model: 'gemini-3.1-flash-lite-preview' },
  }),
});

describe('ModelEndHandler — Vertex thoughtSignature capture (issue #13006 follow-up)', () => {
  it('maps non-empty signatures onto tool_call_ids in order', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          tool_calls: [
            { id: 'tc_a', name: 'a', args: {} },
            { id: 'tc_b', name: 'b', args: {} },
          ],
          additional_kwargs: { signatures: ['SIG_A', '', 'SIG_B'] },
        },
      },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({ tc_a: 'SIG_A', tc_b: 'SIG_B' });
    expect(collectedUsage).toHaveLength(1);
  });

  it('accumulates per-id across multiple model_end events (multi-step tool turn)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG_step1'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );
    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step2', name: 'b', args: {} }],
          additional_kwargs: { signatures: ['SIG_step2'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({
      tc_step1: 'SIG_step1',
      tc_step2: 'SIG_step2',
    });
  });

  it('is a no-op for signatures when collectedThoughtSignatures is null', async () => {
    const collectedUsage = [];
    const handler = new ModelEndHandler(collectedUsage, null);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedUsage).toHaveLength(1);
  });

  it('does not store anything when signatures field is missing (non-Vertex providers)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: {},
        },
      },
      { ls_model_name: 'gpt-4', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('does not store anything when tool_calls is missing', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          additional_kwargs: { signatures: ['SIG_orphan'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('tags the producing agent on collected + emitted usage for per-endpoint pricing', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);
    const graph = {
      getAgentContext: () => ({
        provider: 'openai',
        agentId: 'agent_sub',
        clientOptions: { model: 'gpt-4' },
      }),
    };

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gpt-4', run_id: 'r1', user_id: 'u1' },
      graph,
    );

    expect(collectedUsage[0].agentId).toBe('agent_sub');
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent_sub' }));
  });

  // [knauf] Pin Model Router usage to the provider-returned underlying model.
  it.each([
    [
      'LangChain-concatenated metadata',
      { model_name: 'model-router', model: 'model-routergpt-5.4-mini-2026-03-17' },
      'gpt-5.4-mini-2026-03-17',
    ],
    [
      'provider-separated metadata',
      { model_name: 'model-router', model: 'gpt-5.4-mini-2026-03-17' },
      'gpt-5.4-mini-2026-03-17',
    ],
    ['missing terminal metadata', { model_name: 'model-router' }, 'model-router'],
  ])(
    'resolves the response model from %s for usage',
    async (_case, responseMetadata, expectedModel) => {
      const collectedUsage = [];
      const emitUsage = jest.fn();
      const handler = new ModelEndHandler(collectedUsage, null, emitUsage);
      const graph = {
        getAgentContext: () => ({
          provider: 'openai',
          clientOptions: { model: 'model-router-chat' },
        }),
      };

      await handler.handle(
        'on_chat_model_end',
        {
          output: {
            usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            response_metadata: responseMetadata,
          },
        },
        { ls_model_name: 'model-router-chat', run_id: 'r1', user_id: 'u1' },
        graph,
      );

      expect(collectedUsage[0].model).toBe(expectedModel);
      expect(collectedUsage[0].knauf_requestedModel).toBe('model-router-chat');
      expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ model: expectedModel }));
    },
  );
  // End [knauf]

  it('leaves usage untagged when the graph context has no agentId (single-endpoint)', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', run_id: 'r1', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedUsage[0].agentId).toBeUndefined();
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: undefined }));
  });

  it('throws when collectedUsage is not an array (existing contract)', () => {
    expect(() => new ModelEndHandler(null)).toThrow('collectedUsage must be an array');
  });
});

// [knauf] NO-TICKET — regression coverage for Model Router's successful-looking refusal.
describe('zero-usage generic refusal recovery', () => {
  const refusalResult = {
    generations: [
      [
        {
          text: "I'm sorry, but I cannot assist with that request.",
          message: {
            content: "I'm sorry, but I cannot assist with that request.",
            usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        },
      ],
    ],
  };

  it('raises a retry signal only for the exact zero-usage refusal', () => {
    expect(isZeroUsageGenericRefusal(refusalResult)).toBe(true);
    expect(
      isZeroUsageGenericRefusal({
        generations: [
          [
            {
              ...refusalResult.generations[0][0],
              message: {
                ...refusalResult.generations[0][0].message,
                usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            },
          ],
        ],
      }),
    ).toBe(false);

    const { handler, state } = createZeroUsageRefusalRetryHandler({ messageId: 'm1' });
    expect(() => handler.handleLLMEnd(refusalResult)).toThrow('zero_usage_generic_refusal');
    expect(state.refusalCount).toBe(1);
    expect(handler.raiseError).toBe(true);
  });

  it('removes the failed streamed refusal while preserving fallback text', () => {
    expect(
      stripRetriedGenericRefusal([
        { type: 'text', text: "I'm sorry, but I cannot assist with that request." },
        { type: 'text', text: 'Here is the requested chart.' },
      ]),
    ).toEqual([{ type: 'text', text: 'Here is the requested chart.' }]);
  });
});
// End [knauf]

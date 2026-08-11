jest.mock('@librechat/data-schemas', () => ({
  // [knauf] KK20-252 — `warn` is required by the content-filter branch; without
  // it in this exhaustive mock, `logger.warn` is undefined and the handler throws
  // instead of logging.
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
  // End [knauf]
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

const { AIMessage, HumanMessage, ToolMessage } = require('@librechat/agents/langchain/messages');

const {
  ModelEndHandler,
  createModelRetryHandler,
  isOutputTruncated,
  isZeroUsageGenericRefusal,
  stampLangfuseResponseModel,
  stripRetriedModelOutput,
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

// [knauf] KK20-194 — regression coverage for bounded model recovery.
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

    const { handler, state } = createModelRetryHandler({ messageId: 'm1' });
    expect(() => handler.handleLLMEnd(refusalResult)).toThrow('zero_usage_generic_refusal');
    expect(state.refusalCount).toBe(1);
    expect(handler.raiseError).toBe(true);
  });

  it('removes the failed streamed refusal while preserving fallback text', () => {
    expect(
      stripRetriedModelOutput(
        [
          { type: 'text', text: "I'm sorry, but I cannot assist with that request." },
          { type: 'text', text: 'Here is the requested chart.' },
        ],
        { refusalCount: 1, truncatedTexts: [] },
      ),
    ).toEqual([{ type: 'text', text: 'Here is the requested chart.' }]);
  });

  it('stamps the routed model for Langfuse before downstream callbacks run', () => {
    const result = {
      generations: [
        [
          {
            message: {
              response_metadata: {
                model_name: 'model-router',
                model: 'model-routergpt-5.4-mini-2026-03-17',
              },
            },
          },
        ],
      ],
    };

    stampLangfuseResponseModel(result);

    expect(result.generations[0][0].message.response_metadata.model_name).toBe(
      'gpt-5.4-mini-2026-03-17',
    );
  });

  it('repairs only structurally invalid Model Router tool history', () => {
    const { handler } = createModelRetryHandler({ messageId: 'm1' });
    const valid = [
      new HumanMessage('question'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-1', name: 'file_search', args: {} }],
      }),
      new ToolMessage({ content: 'result', tool_call_id: 'call-1' }),
    ];
    handler.handleChatModelStart(null, [valid], null, null, null, {
      ls_model_name: 'model-router',
    });
    expect(valid).toHaveLength(3);

    const orphaned = [
      new HumanMessage('question'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-2', name: 'file_search', args: {} }],
      }),
      new ToolMessage({ content: 'result', tool_call_id: '' }),
    ];
    handler.handleChatModelStart(null, [orphaned], null, null, null, {
      ls_model_name: 'model-router',
    });

    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].getType()).toBe('human');
  });
});

describe('output-limit recovery', () => {
  const truncatedResult = {
    generations: [
      [
        {
          message: {
            content: 'Partial answer that must be discarded.',
            response_metadata: {
              incomplete_details: { reason: 'max_output_tokens' },
            },
          },
        },
      ],
    ],
  };

  it('retries a truncated turn once with a concise replacement instruction', () => {
    expect(isOutputTruncated(truncatedResult)).toBe(true);
    expect(
      isOutputTruncated({
        generations: [
          [
            {
              message: {
                response_metadata: { incomplete_details: { reason: 'content_filter' } },
              },
            },
          ],
        ],
      }),
    ).toBe(false);

    const { handler, state } = createModelRetryHandler({ messageId: 'm1' });
    const initialMessages = [new HumanMessage('Explain this.')];
    handler.handleChatModelStart(null, [initialMessages], null, null, null, {
      ls_model_name: 'model-router',
    });
    expect(initialMessages).toHaveLength(1);

    expect(() => handler.handleLLMEnd(truncatedResult)).toThrow('output_truncated');
    expect(state.truncationCount).toBe(1);

    const retryMessages = [new HumanMessage('Explain this.')];
    handler.handleChatModelStart(null, [retryMessages], null, null, null, {
      ls_model_name: 'model-router',
    });
    expect(retryMessages).toHaveLength(2);
    expect(retryMessages.at(-1).content).toMatch(/complete replacement/i);
    expect(retryMessages.at(-1).content).toMatch(/300 words/i);
  });

  it('removes the failed partial text before persisting the retry', () => {
    expect(
      stripRetriedModelOutput(
        [{ type: 'text', text: 'Partial answer that must be discarded.Complete answer.' }],
        {
          refusalCount: 0,
          truncatedTexts: ['Partial answer that must be discarded.'],
          truncatedToolCallIds: [],
        },
      ),
    ).toEqual([{ type: 'text', text: 'Complete answer.' }]);
  });

  it('removes a truncated tool call before persisting the retry', () => {
    const result = {
      generations: [
        [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'partial-call', name: 'image_gen_oai', args: {} }],
              response_metadata: {
                incomplete_details: { reason: 'max_output_tokens' },
              },
            },
          },
        ],
      ],
    };
    const { handler, state } = createModelRetryHandler({ messageId: 'm1' });

    expect(() => handler.handleLLMEnd(result)).toThrow('output_truncated');
    expect(
      stripRetriedModelOutput(
        [
          {
            type: 'tool_call',
            tool_call: { id: 'partial-call', name: 'image_gen_oai', args: '{}' },
          },
          { type: 'text', text: 'Complete retry.' },
        ],
        state,
      ),
    ).toEqual([{ type: 'text', text: 'Complete retry.' }]);
  });
});
// End [knauf]

// [knauf] KK20-194 — bind final native-search phase capture to ModelEndHandler.
describe('native web-search final output capture', () => {
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

  it('captures final_answer and clears it on a later visible non-search call', async () => {
    const sink = { text: '' };
    const handler = new ModelEndHandler([], null, null, sink);
    const metadata = { ls_model_name: 'gpt-5', user_id: 'u1', hide_sequential_outputs: false };

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: usage,
          response_metadata: {
            output: [
              { type: 'web_search_call', id: 'ws_1' },
              {
                type: 'message',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'Draft.' }],
              },
              {
                type: 'message',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Final.' }],
              },
            ],
          },
        },
      },
      metadata,
      buildGraph(),
    );
    expect(sink.text).toBe('Final.');

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: usage, response_metadata: { output: [] } } },
      metadata,
      buildGraph(),
    );
    expect(sink.text).toBe('');
  });
});
// End [knauf]

// [knauf] KK20-252 — Azure content-filter surfacing.
//
// Upstream types `finish_reason` as including 'content_filter' and then never
// reads it, so a filtered completion looked identical to the model declining. On
// KK20-252 that ambiguity cost real diagnosis time: the visible symptom was
// "I'm sorry, but I cannot assist with that request.", which turned out to be a
// genuine refusal driven by contradictory instructions — but nothing in the
// codebase could have told us that.
describe('[knauf] ModelEndHandler — Azure content filter', () => {
  const { logger } = require('@librechat/data-schemas');

  const handleWith = async (responseMetadata) => {
    const collectedUsage = [];
    const handler = new ModelEndHandler(collectedUsage);
    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          response_metadata: responseMetadata,
        },
      },
      { ls_model_name: 'model-router', run_id: 'r1', user_id: 'u1', thread_id: 'c1' },
      buildGraph(),
    );
    return collectedUsage;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('warns, with identifiers, when the completion was filtered', async () => {
    await handleWith({
      finish_reason: 'content_filter',
      content_filter_results: { hate: { filtered: true, severity: 'high' } },
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls[0];
    expect(message).toContain('content filter');
    // The identifiers are the point — a warn nobody can trace to a conversation
    // is no better than silence.
    expect(context).toMatchObject({
      userId: 'u1',
      messageId: 'r1',
      conversationId: 'c1',
      model: 'model-router',
      contentFilterResults: { hate: { filtered: true, severity: 'high' } },
    });
  });

  it('stays silent on a normal stop', async () => {
    await handleWith({ finish_reason: 'stop' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when response_metadata is absent', async () => {
    const collectedUsage = [];
    const handler = new ModelEndHandler(collectedUsage);
    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      { ls_model_name: 'model-router', run_id: 'r1', user_id: 'u1' },
      buildGraph(),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still records usage — the filter is logged, never thrown', async () => {
    // Deliberately not converted to a user-facing error: a content filter can
    // arrive alongside partial streamed content, and throwing would discard
    // output the user can already see. Usage must still be billed.
    const collectedUsage = await handleWith({ finish_reason: 'content_filter' });
    expect(collectedUsage).toHaveLength(1);
    expect(collectedUsage[0]).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});
// End [knauf]

// [knauf] NO-TICKET — make output-cap truncation visible in production logs.
describe('[knauf] ModelEndHandler — incomplete output', () => {
  const { logger } = require('@librechat/data-schemas');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('warns with usage and identifiers when the provider reaches its output cap', async () => {
    const handler = new ModelEndHandler([]);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 100, output_tokens: 8192, total_tokens: 8292 },
          response_metadata: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          },
        },
      },
      { ls_model_name: 'model-router', run_id: 'r1', user_id: 'u1', thread_id: 'c1' },
      buildGraph(),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      '[ModelEndHandler] Completion reached its output limit',
      expect.objectContaining({
        userId: 'u1',
        messageId: 'r1',
        conversationId: 'c1',
        outputTokens: 8192,
        incompleteDetails: { reason: 'max_output_tokens' },
      }),
    );
  });
});
// End [knauf]

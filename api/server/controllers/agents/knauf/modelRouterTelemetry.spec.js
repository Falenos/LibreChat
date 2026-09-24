const { createRequire } = require('node:module');

jest.mock('@librechat/api', () => ({
  recordFoundryModelCall: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
  },
  tenantStorage: {
    run: jest.fn((_context, callback) => callback()),
  },
}));

const { CallbackManager } = require('@langchain/core/callbacks/manager');
const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const modelStackRequire = createRequire(require.resolve('@langchain/openai'));
const { BaseChatModel } = modelStackRequire('@langchain/core/language_models/chat_models');
const { AIMessage, HumanMessage } = modelStackRequire('@langchain/core/messages');
const { RunnableLambda } = modelStackRequire('@langchain/core/runnables');
const { Annotation, END, START, StateGraph } = require('@langchain/langgraph');
const { recordFoundryModelCall } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const {
  classifyError,
  createModelRouterTelemetry,
  getAttempt,
  normalizeReturnedModel,
} = require('./modelRouterTelemetry');

const routedResult = {
  generations: [
    [
      {
        message: {
          response_metadata: {
            model_name: 'model-router',
            model: 'model-routergpt-5.5-2026-04-01',
            request_id: 'azure-request-1',
            headers: {
              'apim-request-id': 'azure-correlation-1',
            },
          },
          usage_metadata: { input_tokens: 100, output_tokens: 25 },
        },
      },
    ],
  ],
};

describe('[knauf] Model Router telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records duration, TTFT, returned model, tokens, and a generation summary', () => {
    let currentTime = 1_000;
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: ({ output }) =>
        output.response_metadata.model.replace('model-router', ''),
      correlation: {
        messageId: 'message-1',
        conversationId: 'conversation-1',
        streamId: 'stream-1',
      },
      startedAtMs: currentTime,
      now: () => currentTime,
    });

    currentTime = 1_100;
    telemetry.handler.handleChatModelStart(
      null,
      [[{ getType: () => 'human' }]],
      'model-run-1',
      undefined,
      undefined,
      [],
      { ls_model_name: 'model-router-chat', langgraph_node: 'agent' },
    );
    currentTime = 1_350;
    telemetry.handler.handleLLMNewToken('hello', { prompt: 0, completion: 0 }, 'model-run-1');
    currentTime = 2_100;
    telemetry.handler.handleLLMEnd(routedResult, 'model-run-1');
    currentTime = 2_200;
    telemetry.finalize();

    expect(recordFoundryModelCall).toHaveBeenCalledWith({
      result: 'success',
      returnedModel: 'gpt-5.5',
      phase: 'primary',
      attempt: '1',
      durationSeconds: 1,
      ttftSeconds: 0.25,
    });
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        messageId: 'message-1',
        modelRunId: 'model-run-1',
        inputTokens: 100,
        outputTokens: 25,
        providerRequestId: 'azure-request-1',
        providerCorrelationId: 'azure-correlation-1',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({
        streamId: 'stream-1',
        clientSurface: 'none',
        clientOutputState: 'none',
        durationMs: 1_200,
        timeToFirstModelContentMs: 350,
        modelTelemetryScope: 'parent_graph',
        observedParentModelCallCount: 1,
        observedParentAggregateModelWaitMs: 1_000,
      }),
    );
    expect(tenantStorage.run).toHaveBeenCalledWith({}, expect.any(Function));
  });

  it('waits for the first non-empty content token before recording TTFT', () => {
    let currentTime = 1_000;
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.5',
      startedAtMs: currentTime,
      now: () => currentTime,
    });

    currentTime = 1_100;
    telemetry.handler.handleChatModelStart(null, [[]], 'model-run-1', undefined, undefined, [], {
      ls_model_name: 'model-router',
    });
    currentTime = 1_150;
    telemetry.handler.handleLLMNewToken('', { prompt: 0, completion: 0 }, 'model-run-1');
    currentTime = 1_300;
    telemetry.handler.handleLLMNewToken('hello', { prompt: 0, completion: 0 }, 'model-run-1');
    currentTime = 1_500;
    telemetry.handler.handleLLMEnd(routedResult, 'model-run-1');
    telemetry.finalize();

    expect(recordFoundryModelCall).toHaveBeenCalledWith(
      expect.objectContaining({ ttftSeconds: 0.2 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({ timeToFirstModelContentMs: 300 }),
    );
  });

  it('records a known retry and marks the replacement attempt as 2+', () => {
    let currentTime = 0;
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.4-mini',
      startedAtMs: currentTime,
      now: () => currentTime,
    });

    telemetry.handler.handleChatModelStart(null, [[]], 'first', 'agent-node', undefined, [], {
      ls_model_name: 'model-router',
    });
    currentTime = 10;
    telemetry.recordRetry({ runId: 'first', reason: 'refusal', output: routedResult });
    currentTime = 20;
    telemetry.handler.handleChatModelStart(null, [[]], 'replacement', 'agent-node', undefined, [], {
      ls_model_name: 'model-router',
    });
    currentTime = 40;
    telemetry.handler.handleLLMEnd(routedResult, 'replacement');
    telemetry.finalize();

    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ result: 'retry', attempt: '1' }),
    );
    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: 'success', attempt: '2+' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        modelRunId: 'first',
        retryLineage: 'agent-node',
        attemptNumber: 1,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        modelRunId: 'replacement',
        retryLineage: 'agent-node',
        attemptNumber: 2,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Retry lineage completed',
      expect.objectContaining({
        retryLineage: 'agent-node',
        outcome: 'recovered',
        attemptCount: 2,
        initialResult: 'retry',
        terminalResult: 'success',
        retryReason: 'refusal',
      }),
    );
  });

  it('uses LangChain retry tags for provider retry attempts', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.6-luna',
      startedAtMs: 0,
      now: () => 10,
    });

    telemetry.handler.handleChatModelStart(
      null,
      [[]],
      'model-run-2',
      'parent-run',
      undefined,
      ['retry:attempt:2'],
      { ls_model_name: 'model-router' },
    );
    telemetry.handler.handleLLMEnd(routedResult, 'model-run-2');

    expect(recordFoundryModelCall).toHaveBeenCalledWith(expect.objectContaining({ attempt: '2+' }));
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        attempt: '2+',
        retryReason: 'langchain_retry',
      }),
    );
  });

  it('matches the installed LangChain retry-tag contract', async () => {
    let attemptCount = 0;
    const observedTags = [];
    const observer = BaseCallbackHandler.fromMethods({
      handleChainStart(_chain, _inputs, _runId, _runType, tags) {
        observedTags.push(tags ?? []);
      },
    });
    const retriedRunnable = RunnableLambda.from(() => {
      attemptCount += 1;
      if (attemptCount === 1) {
        throw new Error('expected retry');
      }
      return 'ok';
    }).withRetry({ stopAfterAttempt: 2 });

    await expect(
      retriedRunnable.invoke('input', {
        callbacks: [observer],
      }),
    ).resolves.toBe('ok');

    const generatedRetryTag = observedTags.flat().find((tag) => tag.startsWith('retry:attempt:'));
    expect(generatedRetryTag).toBe('retry:attempt:2');
    expect(getAttempt([generatedRetryTag], undefined)).toBe('2+');
  });

  it('attributes a real LangGraph node retry to attempt 2+', async () => {
    let modelAttempts = 0;
    class RetryModel extends BaseChatModel {
      constructor() {
        super({});
      }

      _llmType() {
        return 'model-router-contract';
      }

      async _generate() {
        modelAttempts += 1;
        if (modelAttempts === 1) {
          throw Object.assign(new Error('private streamed provider detail'), {
            code: 'server_error',
            type: 'server_error',
            requestID: 'azure-stream-request',
          });
        }
        return {
          generations: [{ text: 'ok', message: new AIMessage('ok') }],
        };
      }
    }

    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.6-luna',
      startedAtMs: 0,
      now: () => 10,
    });
    const State = Annotation.Root({
      messages: Annotation({
        reducer: (left, right) => left.concat(right),
        default: () => [],
      }),
    });
    const model = new RetryModel();
    const graph = new StateGraph(State)
      .addNode(
        'agent',
        async (state, config) => ({
          messages: [await model.invoke(state.messages, config)],
        }),
        {
          retryPolicy: {
            maxAttempts: 2,
            initialInterval: 1,
            jitter: false,
            logWarning: false,
          },
        },
      )
      .addEdge(START, 'agent')
      .addEdge('agent', END)
      .compile();

    await graph.invoke(
      { messages: [new HumanMessage('hello')] },
      {
        callbacks: [telemetry.handler],
        metadata: { ls_model_name: 'model-router' },
      },
    );

    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ result: 'provider_error', attempt: '1' }),
    );
    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: 'success', attempt: '2+' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        result: 'provider_error',
        attempt: '1',
        providerRetryable: true,
        providerCode: 'server_error',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        result: 'success',
        attempt: '2+',
        retryReason: 'langgraph_retry',
        returnedModel: 'gpt-5.6-luna',
      }),
    );
  });

  it('awaits callback-manager dispatch before finalizing the generation lifecycle', async () => {
    let currentTime = 0;
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.4-mini',
      startedAtMs: currentTime,
      now: () => currentTime,
    });
    const manager = CallbackManager.configure(
      [telemetry.handler],
      undefined,
      undefined,
      undefined,
      { ls_model_name: 'model-router' },
    );

    currentTime = 10;
    const [runManager] = await manager.handleChatModelStart({}, [[{ getType: () => 'human' }]]);
    currentTime = 30;
    await runManager.handleLLMEnd(routedResult);
    currentTime = 40;
    telemetry.finalize();

    expect(telemetry.handler.awaitHandlers).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({
        observedParentModelCallCount: 1,
        observedParentAggregateModelWaitMs: 20,
      }),
    );
  });

  it('keeps replacement markers scoped to their parent model lineage', () => {
    let currentTime = 0;
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'gpt-5.4-mini',
      startedAtMs: currentTime,
      now: () => currentTime,
    });
    const start = (runId, parentRunId) =>
      telemetry.handler.handleChatModelStart(null, [[]], runId, parentRunId, undefined, [], {
        ls_model_name: 'model-router',
      });

    start('retry-source', 'lineage-a');
    currentTime = 10;
    telemetry.recordRetry({
      runId: 'retry-source',
      reason: 'output_limit',
      output: routedResult,
    });
    start('unrelated', 'lineage-b');
    currentTime = 20;
    telemetry.handler.handleLLMEnd(routedResult, 'unrelated');
    start('replacement', 'lineage-a');
    currentTime = 30;
    telemetry.handler.handleLLMEnd(routedResult, 'replacement');

    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: '1' }),
    );
    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ attempt: '2+' }),
    );
  });

  it('uses the generation outcome instead of intermediate call failures', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'unknown',
      startedAtMs: 1_000,
      now: () => 2_000,
    });

    telemetry.handler.handleChatModelStart(null, [[]], 'model-run-1', undefined, undefined, [], {
      ls_model_name: 'model-router',
    });
    telemetry.handler.handleLLMError(new Error('provider failure'), 'model-run-1');
    telemetry.finalize({ failed: false });

    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({ result: 'success' }),
    );
  });

  it('records only bounded OpenAI SDK error diagnostics', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'unknown',
      startedAtMs: 1_000,
      now: () => 2_000,
    });
    const error = Object.assign(new Error('sensitive provider response'), {
      status: 400,
      code: 'unsupported_value',
      type: 'invalid_request_error',
      param: 'text.verbosity',
      requestID: 'azure-request-400',
      headers: new Headers({
        'x-request-id': 'azure-request-400',
        'apim-request-id': 'azure-correlation-400',
        authorization: 'Bearer provider-secret',
      }),
      request: { body: { input: 'private prompt' } },
    });

    telemetry.handler.handleChatModelStart(null, [[]], 'model-run-1', undefined, undefined, [], {
      ls_model_name: 'model-router',
    });
    telemetry.handler.handleLLMError(error, 'model-run-1');

    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        result: 'provider_error',
        attempt: '1',
        providerRetryable: false,
        providerStatus: 400,
        providerCode: 'unsupported_value',
        providerType: 'invalid_request_error',
        providerParam: 'text.verbosity',
        errorName: 'Error',
        providerRequestId: 'azure-request-400',
        providerCorrelationId: 'azure-correlation-400',
      }),
    );
    const event = logger.info.mock.calls.at(-1)[1];
    expect(JSON.stringify(event)).not.toContain('sensitive provider response');
    expect(JSON.stringify(event)).not.toContain('private prompt');
    expect(JSON.stringify(event)).not.toContain('provider-secret');
  });

  it('records an unsafe post-output failure as not retried', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'unknown',
      startedAtMs: 1_000,
      now: () => 2_000,
    });
    const error = {
      code: 'server_error',
      headers: new Headers({
        'x-request-id': 'azure-request-unsafe',
        'apim-request-id': 'azure-correlation-unsafe',
      }),
      error: {
        knauf_retry_decision: 'unsafe_after_output',
        knauf_output_state: 'answer_text',
        knauf_incomplete_reason: 'content_filter',
      },
    };

    telemetry.handler.handleChatModelStart(
      null,
      [[]],
      'model-run-1',
      'logical-call-1',
      undefined,
      [],
      { ls_model_name: 'model-router' },
    );
    telemetry.handler.handleLLMError(error, 'model-run-1');
    telemetry.finalize({
      failed: true,
      clientSurface: 'incomplete_response',
      clientOutputState: 'answer_text',
      clientIncompleteReason: 'content_filter',
    });

    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({
        retryLineage: 'logical-call-1',
        providerRetryable: false,
        retryDecision: 'unsafe_after_output',
        outputState: 'answer_text',
        incompleteReason: 'content_filter',
        providerRequestId: 'azure-request-unsafe',
        providerCorrelationId: 'azure-correlation-unsafe',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Retry lineage completed',
      expect.objectContaining({
        retryLineage: 'logical-call-1',
        outcome: 'unsafe_not_retried',
        attemptCount: 1,
        initialResult: 'provider_error',
        initialOutputState: 'answer_text',
        initialIncompleteReason: 'content_filter',
        initialProviderCorrelationId: 'azure-correlation-unsafe',
        terminalProviderCorrelationId: 'azure-correlation-unsafe',
        terminalResult: 'provider_error',
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({
        result: 'error',
        clientSurface: 'incomplete_response',
        clientOutputState: 'answer_text',
        clientIncompleteReason: 'content_filter',
      }),
    );
  });

  it('bounds unknown client surfaces on the lifecycle event', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'unknown',
      startedAtMs: 1_000,
      now: () => 2_000,
    });
    telemetry.handler.handleChatModelStart(null, [[]], 'model-run-1', undefined, undefined, [], {
      ls_model_name: 'model-router',
    });
    telemetry.handler.handleLLMEnd(routedResult, 'model-run-1');

    telemetry.finalize({
      clientSurface: 'private-user-data',
      clientOutputState: 'private-user-data',
      clientIncompleteReason: 'private-user-data',
    });

    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({
        clientSurface: 'none',
        clientOutputState: 'none',
      }),
    );
    const event = logger.info.mock.calls.at(-1)[1];
    expect(event).not.toHaveProperty('clientIncompleteReason');
  });

  it('bounds incomplete reasons on model-call telemetry', () => {
    const telemetry = createModelRouterTelemetry({
      responseModelExtractor: () => 'model-router',
      startedAtMs: 1_000,
      now: () => 2_000,
    });
    const incompleteResult = {
      generations: [
        [
          {
            message: {
              response_metadata: {
                model: 'model-router',
                incomplete_details: { reason: 'provider_extension' },
              },
            },
          },
        ],
      ],
    };
    telemetry.handler.handleChatModelStart(null, [[]], 'model-run-1', undefined, undefined, [], {
      ls_model_name: 'model-router',
    });
    telemetry.handler.handleLLMEnd(incompleteResult, 'model-run-1');

    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Model call completed',
      expect.objectContaining({ incompleteReason: 'other' }),
    );
  });

  it('classifies the existing stream idle timeout distinctly', () => {
    expect(
      classifyError(new DOMException('Model Router stream timed out', 'TimeoutError'), false),
    ).toBe('stream_idle_timeout');
    expect(classifyError(Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }), false)).toBe(
      'timeout',
    );
    expect(classifyError(new Error('provider'), true)).toBe('cancelled');
  });

  it('bounds returned model labels', () => {
    expect(normalizeReturnedModel('gpt-5.4-nano-2026')).toBe('gpt-5.4-nano');
    expect(normalizeReturnedModel('model-routergpt-5.6-luna-2026-07-09')).toBe('gpt-5.6-luna');
    expect(normalizeReturnedModel('model-routergpt-5.6-terra-2026-07-09')).toBe('gpt-5.6-terra');
    expect(normalizeReturnedModel('model-routergpt-5.6-sol-2026-07-09')).toBe('gpt-5.6-sol');
    expect(normalizeReturnedModel('unplanned-model-123')).toBe('other');
    expect(normalizeReturnedModel()).toBe('unknown');
  });

  it('keeps attempt labels bounded when callback tags are unavailable', () => {
    expect(getAttempt([], undefined)).toBe('1');
    expect(getAttempt(['retry:attempt:2'], undefined)).toBe('2+');
    expect(getAttempt(['retry:attempt:12'], undefined)).toBe('2+');
    expect(getAttempt({ 'retry:attempt:2': true }, undefined)).toBe('unknown');
    expect(getAttempt([], 'output_limit')).toBe('2+');
  });
});

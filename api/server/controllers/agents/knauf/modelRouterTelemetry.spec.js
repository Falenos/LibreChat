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
const { recordFoundryModelCall } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const {
  classifyError,
  createModelRouterTelemetry,
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
      attempt: 'unknown',
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
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[FoundryRouterTelemetry] Generation lifecycle completed',
      expect.objectContaining({
        streamId: 'stream-1',
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

    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ result: 'retry', attempt: 'unknown' }),
    );
    expect(recordFoundryModelCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ result: 'success', attempt: '2+' }),
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
      expect.objectContaining({ attempt: 'unknown' }),
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
    expect(normalizeReturnedModel('unplanned-model-123')).toBe('other');
    expect(normalizeReturnedModel()).toBe('unknown');
  });
});

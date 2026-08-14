const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const { logger } = require('@librechat/data-schemas');
const { recordFoundryModelCall } = require('@librechat/api');
const { getProviderRequestId } = require('./providerError');

const MODEL_ROUTER = 'model-router';
const STREAM_IDLE_MESSAGE = 'Model Router stream timed out';

const normalizeReturnedModel = (value) => {
  if (typeof value !== 'string' || value === '') {
    return 'unknown';
  }
  const model = value.toLowerCase();
  if (model.includes('gpt-5.4-nano')) return 'gpt-5.4-nano';
  if (model.includes('gpt-5.4-mini')) return 'gpt-5.4-mini';
  if (model.includes('gpt-5.4')) return 'gpt-5.4';
  if (model.includes('gpt-5.5')) return 'gpt-5.5';
  if (model.includes(MODEL_ROUTER)) return MODEL_ROUTER;
  return 'other';
};

const messageType = (message) =>
  typeof message?.getType === 'function' ? message.getType() : message?.role;

const getPhase = (messages, metadata, tags) => {
  const node =
    typeof metadata?.langgraph_node === 'string' ? metadata.langgraph_node.toLowerCase() : '';
  if (node.includes('summar')) return 'summarization';
  if (
    metadata?.is_subagent === true ||
    node.includes('subagent') ||
    tags?.some((tag) => typeof tag === 'string' && tag.toLowerCase().includes('subagent'))
  ) {
    return 'subagent';
  }
  const lastMessage = messages?.at(-1)?.at(-1);
  if (messageType(lastMessage) === 'tool') return 'tool';
  return node === '' || node.includes('agent') ? 'primary' : 'other';
};

const getGenerationMessage = (result) => result?.generations?.at(-1)?.at(-1)?.message;

const getUsage = (result) => {
  const message = getGenerationMessage(result);
  const usage =
    message?.usage_metadata ?? result?.llmOutput?.tokenUsage ?? result?.llmOutput?.usage;
  return {
    inputTokens: usage?.input_tokens ?? usage?.promptTokens ?? usage?.prompt_tokens,
    outputTokens: usage?.output_tokens ?? usage?.completionTokens ?? usage?.completion_tokens,
  };
};

const getReturnedModel = (result, responseModelExtractor) => {
  const message = getGenerationMessage(result);
  return normalizeReturnedModel(
    responseModelExtractor({
      output: {
        response_metadata: message?.response_metadata ?? result?.llmOutput ?? {},
      },
    }),
  );
};

const getSuccessRequestId = (result) => {
  const responseMetadata = getGenerationMessage(result)?.response_metadata;
  return (
    getProviderRequestId(responseMetadata) ??
    getProviderRequestId(responseMetadata?.response) ??
    getProviderRequestId(result?.llmOutput)
  );
};

const classifyError = (error, cancelled) => {
  if (cancelled || error?.name === 'AbortError') return 'cancelled';
  if (error?.name === 'TimeoutError' && error?.message === STREAM_IDLE_MESSAGE) {
    return 'stream_idle_timeout';
  }
  if (
    error?.name === 'TimeoutError' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNABORTED'
  ) {
    return 'timeout';
  }
  return 'provider_error';
};

/**
 * Request-scoped telemetry for interactive Azure Foundry Model Router calls.
 * The handler intentionally records only fields exposed by the current SDK.
 */
function createModelRouterTelemetry({
  responseModelExtractor,
  correlation = {},
  startedAtMs = Date.now(),
  now = Date.now,
  isCancelled = () => false,
}) {
  const calls = new Map();
  const completedCalls = [];
  let firstModelChunkAtMs;
  let pendingRetryReason;
  let finalized = false;

  const finishCall = (runId, result, output, error) => {
    const call = calls.get(runId);
    if (!call) return;
    calls.delete(runId);

    const completedAtMs = now();
    const durationMs = Math.max(0, completedAtMs - call.startedAtMs);
    const ttftMs =
      call.firstChunkAtMs == null ? undefined : Math.max(0, call.firstChunkAtMs - call.startedAtMs);
    const returnedModel =
      output == null ? 'unknown' : getReturnedModel(output, responseModelExtractor);
    const usage = output == null ? {} : getUsage(output);
    const providerRequestId =
      error == null ? getSuccessRequestId(output) : getProviderRequestId(error);

    recordFoundryModelCall?.({
      result,
      returnedModel,
      phase: call.phase,
      attempt: call.attempt,
      durationSeconds: durationMs / 1000,
      ...(ttftMs != null && { ttftSeconds: ttftMs / 1000 }),
    });

    const event = {
      ...correlation,
      modelRunId: runId,
      result,
      returnedModel,
      phase: call.phase,
      attempt: call.attempt,
      durationMs,
      ...(ttftMs != null && { ttftMs }),
      ...(call.retryReason != null && { retryReason: call.retryReason }),
      ...(Number.isFinite(usage.inputTokens) && { inputTokens: usage.inputTokens }),
      ...(Number.isFinite(usage.outputTokens) && { outputTokens: usage.outputTokens }),
      ...(providerRequestId != null && { providerRequestId }),
    };
    completedCalls.push(event);
    logger.info('[FoundryRouterTelemetry] Model call completed', event);
  };

  const handler = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, messages, runId, _parentRunId, _extraParams, tags, metadata) {
      const runtimeMetadata = metadata ?? (Array.isArray(tags) ? undefined : tags) ?? {};
      const requestedModel = runtimeMetadata?.ls_model_name;
      if (
        typeof requestedModel !== 'string' ||
        !requestedModel.toLowerCase().includes(MODEL_ROUTER)
      ) {
        return;
      }
      const retryReason = pendingRetryReason;
      pendingRetryReason = undefined;
      calls.set(runId, {
        startedAtMs: now(),
        phase: getPhase(messages, runtimeMetadata, Array.isArray(tags) ? tags : []),
        attempt: retryReason == null ? 'unknown' : '2+',
        retryReason,
      });
    },
    handleLLMNewToken(_token, _indices, runId) {
      const call = calls.get(runId);
      if (!call || call.firstChunkAtMs != null) return;
      call.firstChunkAtMs = now();
      firstModelChunkAtMs ??= call.firstChunkAtMs;
    },
    handleLLMEnd(output, runId) {
      finishCall(runId, 'success', output);
    },
    handleLLMError(error, runId) {
      finishCall(runId, classifyError(error, isCancelled()), undefined, error);
    },
  });

  const recordRetry = ({ runId, reason, output }) => {
    pendingRetryReason = reason;
    finishCall(runId, 'retry', output);
  };

  const finalize = ({ cancelled = false, failed = false } = {}) => {
    if (finalized) return;
    finalized = true;
    if (completedCalls.length === 0 && calls.size === 0) return;
    const completedAtMs = now();
    const modelWaitMs = completedCalls.reduce((total, call) => total + call.durationMs, 0);
    const terminalResult = cancelled ? 'cancelled' : failed ? 'error' : 'success';
    logger.info('[FoundryRouterTelemetry] Visible turn completed', {
      ...correlation,
      result: terminalResult,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      ...(firstModelChunkAtMs != null && {
        timeToFirstModelChunkMs: Math.max(0, firstModelChunkAtMs - startedAtMs),
      }),
      modelCallCount: completedCalls.length,
      aggregateModelWaitMs: modelWaitMs,
    });
  };

  return { handler, finalize, recordRetry };
}

module.exports = {
  classifyError,
  createModelRouterTelemetry,
  getPhase,
  normalizeReturnedModel,
};

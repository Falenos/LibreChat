const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { recordFoundryModelCall } = require('@librechat/api');
const { getProviderRequestId, summarizeProviderError } = require('./providerError');

const MODEL_ROUTER = 'model-router';
const STREAM_IDLE_MESSAGE = 'Model Router stream timed out';

const logTelemetry = (message, event) => tenantStorage.run({}, () => logger.info(message, event));

const normalizeReturnedModel = (value) => {
  if (typeof value !== 'string' || value === '') {
    return 'unknown';
  }
  const model = value.toLowerCase();
  if (model.includes('gpt-5.4-nano')) return 'gpt-5.4-nano';
  if (model.includes('gpt-5.4-mini')) return 'gpt-5.4-mini';
  if (model.includes('gpt-5.4')) return 'gpt-5.4';
  if (model.includes('gpt-5.5')) return 'gpt-5.5';
  if (model.includes('gpt-5.6-luna')) return 'gpt-5.6-luna';
  if (model.includes('gpt-5.6-terra')) return 'gpt-5.6-terra';
  if (model.includes('gpt-5.6-sol')) return 'gpt-5.6-sol';
  if (model.includes(MODEL_ROUTER)) return MODEL_ROUTER;
  return 'other';
};

const messageType = (message) =>
  typeof message?.getType === 'function' ? message.getType() : message?.role;

const getPhase = (messages, metadata) => {
  const node =
    typeof metadata?.langgraph_node === 'string' ? metadata.langgraph_node.toLowerCase() : '';
  if (node.includes('summar')) return 'summarization';
  const lastMessage = messages?.at(-1)?.at(-1);
  if (messageType(lastMessage) === 'tool') return 'tool';
  return node === '' || node.includes('agent') ? 'primary' : 'other';
};

const getAttempt = (tags, retryReason) => {
  if (retryReason != null) return '2+';
  if (!Array.isArray(tags)) return 'unknown';
  const retryTag = tags.find((tag) => {
    if (typeof tag !== 'string') return false;
    const match = /^retry:attempt:([0-9]+)$/.exec(tag);
    return match != null && Number(match[1]) >= 2;
  });
  return retryTag == null ? '1' : '2+';
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
  const pendingRetriesByParentRunId = new Map();
  let firstModelContentAtMs;
  let finalized = false;

  const consumePendingRetry = (parentRunId) => {
    if (parentRunId == null) return;
    const reasons = pendingRetriesByParentRunId.get(parentRunId);
    const reason = reasons?.shift();
    if (reasons?.length === 0) {
      pendingRetriesByParentRunId.delete(parentRunId);
    }
    return reason;
  };

  const finishCall = (runId, result, output, error) => {
    const call = calls.get(runId);
    if (!call) return;
    calls.delete(runId);

    const completedAtMs = now();
    const durationMs = Math.max(0, completedAtMs - call.startedAtMs);
    const ttftMs =
      call.firstContentTokenAtMs == null
        ? undefined
        : Math.max(0, call.firstContentTokenAtMs - call.startedAtMs);
    const returnedModel =
      output == null ? 'unknown' : getReturnedModel(output, responseModelExtractor);
    const usage = output == null ? {} : getUsage(output);
    const providerError =
      error == null ? undefined : summarizeProviderError(error, 'model_router_call');
    const providerRequestId =
      error == null ? getSuccessRequestId(output) : providerError?.requestId;

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
      ...(providerError != null && { providerRetryable: providerError.retryable }),
      ...(providerError?.providerStatus != null && {
        providerStatus: providerError.providerStatus,
      }),
      ...(providerError?.code != null && { providerCode: providerError.code }),
      ...(providerError?.type != null && { providerType: providerError.type }),
      ...(providerError?.param != null && { providerParam: providerError.param }),
      ...(providerError?.errorName != null && { errorName: providerError.errorName }),
      ...(providerRequestId != null && { providerRequestId }),
    };
    completedCalls.push(event);
    logTelemetry('[FoundryRouterTelemetry] Model call completed', event);
  };

  const handler = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, messages, runId, parentRunId, _extraParams, tags, metadata) {
      const runtimeMetadata = metadata ?? (Array.isArray(tags) ? undefined : tags) ?? {};
      const requestedModel = runtimeMetadata?.ls_model_name;
      if (
        typeof requestedModel !== 'string' ||
        !requestedModel.toLowerCase().includes(MODEL_ROUTER)
      ) {
        return;
      }
      const explicitRetryReason = consumePendingRetry(parentRunId);
      const attempt = getAttempt(tags, explicitRetryReason);
      const retryReason = explicitRetryReason ?? (attempt === '2+' ? 'langchain_retry' : undefined);
      calls.set(runId, {
        startedAtMs: now(),
        parentRunId,
        phase: getPhase(messages, runtimeMetadata),
        attempt,
        retryReason,
      });
    },
    handleLLMNewToken(token, _indices, runId) {
      const call = calls.get(runId);
      if (
        !call ||
        call.firstContentTokenAtMs != null ||
        typeof token !== 'string' ||
        token.length === 0
      ) {
        return;
      }
      call.firstContentTokenAtMs = now();
      firstModelContentAtMs ??= call.firstContentTokenAtMs;
    },
    handleLLMEnd(output, runId) {
      finishCall(runId, 'success', output);
    },
    handleLLMError(error, runId) {
      finishCall(runId, classifyError(error, isCancelled()), undefined, error);
    },
  });
  handler.awaitHandlers = true;

  const recordRetry = ({ runId, reason, output }) => {
    const parentRunId = calls.get(runId)?.parentRunId;
    if (parentRunId != null) {
      const reasons = pendingRetriesByParentRunId.get(parentRunId) ?? [];
      reasons.push(reason);
      pendingRetriesByParentRunId.set(parentRunId, reasons);
    }
    finishCall(runId, 'retry', output);
  };

  const finalize = ({ cancelled = false, failed = false } = {}) => {
    if (finalized) return;
    finalized = true;
    if (completedCalls.length === 0 && calls.size === 0) return;
    const completedAtMs = now();
    const modelWaitMs = completedCalls.reduce((total, call) => total + call.durationMs, 0);
    let terminalResult = 'success';
    if (cancelled) {
      terminalResult = 'cancelled';
    } else if (failed) {
      terminalResult = 'error';
    }
    logTelemetry('[FoundryRouterTelemetry] Generation lifecycle completed', {
      ...correlation,
      result: terminalResult,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      ...(firstModelContentAtMs != null && {
        timeToFirstModelContentMs: Math.max(0, firstModelContentAtMs - startedAtMs),
      }),
      modelTelemetryScope: 'parent_graph',
      observedParentModelCallCount: completedCalls.length,
      observedParentAggregateModelWaitMs: modelWaitMs,
    });
  };

  return { handler, finalize, recordRetry };
}

module.exports = {
  classifyError,
  createModelRouterTelemetry,
  getAttempt,
  getPhase,
  normalizeReturnedModel,
};

const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { recordFoundryModelCall } = require('@librechat/api');
const {
  getProviderCorrelationId,
  getProviderRequestId,
  summarizeProviderError,
} = require('./providerError');

const MODEL_ROUTER = 'model-router';
const STREAM_IDLE_MESSAGE = 'Model Router stream timed out';
const MAX_RETRY_LINEAGE_LENGTH = 512;
const CLIENT_SURFACES = new Set(['none', 'generic_error', 'incomplete_response']);
const OUTPUT_STATES = new Set(['none', 'answer_text', 'activity_only']);
const INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter', 'other']);

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

const getRetryLineage = (metadata, parentRunId) => {
  const lineage = metadata?.langgraph_checkpoint_ns ?? metadata?.checkpoint_ns ?? parentRunId;
  return typeof lineage === 'string' && lineage.length <= MAX_RETRY_LINEAGE_LENGTH
    ? lineage
    : undefined;
};

const getAttemptNumber = (tags, retryReason) => {
  if (Array.isArray(tags)) {
    const retryTag = tags.find((tag) => typeof tag === 'string' && /^retry:attempt:\d+$/.test(tag));
    if (retryTag != null) {
      return Number(retryTag.slice(retryTag.lastIndexOf(':') + 1));
    }
  }
  return retryReason == null ? 1 : 2;
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

const getSuccessCorrelationId = (result) => {
  const responseMetadata = getGenerationMessage(result)?.response_metadata;
  return (
    getProviderCorrelationId(responseMetadata) ??
    getProviderCorrelationId(responseMetadata?.response) ??
    getProviderCorrelationId(result?.llmOutput)
  );
};

const getResultIncompleteReason = (result) => {
  const reason = getGenerationMessage(result)?.response_metadata?.incomplete_details?.reason;
  if (reason === 'max_output_tokens' || reason === 'content_filter') {
    return reason;
  }
  return reason == null ? undefined : 'other';
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
  const pendingRetriesByLineage = new Map();
  let firstModelContentAtMs;
  let finalized = false;

  const queuePendingRetry = (lineage, reason) => {
    if (lineage == null) return;
    const reasons = pendingRetriesByLineage.get(lineage) ?? [];
    reasons.push(reason);
    pendingRetriesByLineage.set(lineage, reasons);
  };

  const consumePendingRetry = (lineage) => {
    if (lineage == null) return;
    const reasons = pendingRetriesByLineage.get(lineage);
    const reason = reasons?.shift();
    if (reasons?.length === 0) {
      pendingRetriesByLineage.delete(lineage);
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
    const providerCorrelationId =
      error == null ? getSuccessCorrelationId(output) : providerError?.correlationId;
    const incompleteReason =
      error == null ? getResultIncompleteReason(output) : providerError?.incompleteReason;
    if (providerError?.retryable === true) {
      queuePendingRetry(call.retryLineage, 'langgraph_retry');
    }

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
      attemptNumber: call.attemptNumber,
      retryLineage: call.retryLineage ?? runId,
      durationMs,
      ...(ttftMs != null && { ttftMs }),
      ...(call.retryReason != null && { retryReason: call.retryReason }),
      ...(Number.isFinite(usage.inputTokens) && { inputTokens: usage.inputTokens }),
      ...(Number.isFinite(usage.outputTokens) && { outputTokens: usage.outputTokens }),
      ...(providerError != null && { providerRetryable: providerError.retryable }),
      ...(providerError?.retryDecision != null && {
        retryDecision: providerError.retryDecision,
      }),
      ...(providerError?.outputState != null && { outputState: providerError.outputState }),
      ...(incompleteReason != null && { incompleteReason }),
      ...(providerError?.providerStatus != null && {
        providerStatus: providerError.providerStatus,
      }),
      ...(providerError?.code != null && { providerCode: providerError.code }),
      ...(providerError?.type != null && { providerType: providerError.type }),
      ...(providerError?.param != null && { providerParam: providerError.param }),
      ...(providerError?.errorName != null && { errorName: providerError.errorName }),
      ...(providerRequestId != null && { providerRequestId }),
      ...(providerCorrelationId != null && { providerCorrelationId }),
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
      const retryLineage = getRetryLineage(runtimeMetadata, parentRunId);
      const explicitRetryReason = consumePendingRetry(retryLineage);
      const attempt = getAttempt(tags, explicitRetryReason);
      const retryReason = explicitRetryReason ?? (attempt === '2+' ? 'langchain_retry' : undefined);
      calls.set(runId, {
        startedAtMs: now(),
        parentRunId,
        retryLineage,
        phase: getPhase(messages, runtimeMetadata),
        attempt,
        attemptNumber: getAttemptNumber(tags, retryReason),
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
    const retryLineage = calls.get(runId)?.retryLineage;
    queuePendingRetry(retryLineage, reason);
    finishCall(runId, 'retry', output);
  };

  const finalize = ({
    cancelled = false,
    failed = false,
    clientSurface = 'none',
    clientOutputState = 'none',
    clientIncompleteReason,
  } = {}) => {
    if (finalized) return;
    finalized = true;
    if (completedCalls.length === 0 && calls.size === 0) return;
    const completedAtMs = now();
    const modelWaitMs = completedCalls.reduce((total, call) => total + call.durationMs, 0);
    const callsByLineage = new Map();
    for (const call of completedCalls) {
      const lineageCalls = callsByLineage.get(call.retryLineage) ?? [];
      lineageCalls.push(call);
      callsByLineage.set(call.retryLineage, lineageCalls);
    }
    for (const [retryLineage, lineageCalls] of callsByLineage) {
      const orderedCalls = lineageCalls.toSorted((a, b) => a.attemptNumber - b.attemptNumber);
      const initial = orderedCalls[0];
      const terminal = orderedCalls.at(-1);
      if (initial == null || terminal == null || initial.result === 'success') {
        continue;
      }
      let outcome = 'retry_not_observed';
      if (orderedCalls.length > 1) {
        outcome = terminal.result === 'success' ? 'recovered' : 'exhausted';
      } else if (initial.retryDecision === 'unsafe_after_output') {
        outcome = 'unsafe_not_retried';
      } else if (initial.result === 'cancelled') {
        outcome = 'cancelled';
      } else if (initial.retryDecision === 'not_retryable' || initial.providerRetryable === false) {
        outcome = 'not_retryable';
      }
      logTelemetry('[FoundryRouterTelemetry] Retry lineage completed', {
        ...correlation,
        retryLineage,
        outcome,
        attemptCount: orderedCalls.length,
        initialResult: initial.result,
        terminalResult: terminal.result,
        ...(initial.providerStatus != null && { initialProviderStatus: initial.providerStatus }),
        ...(initial.providerCode != null && { initialProviderCode: initial.providerCode }),
        ...(initial.outputState != null && { initialOutputState: initial.outputState }),
        ...(initial.incompleteReason != null && {
          initialIncompleteReason: initial.incompleteReason,
        }),
        ...(initial.providerCorrelationId != null && {
          initialProviderCorrelationId: initial.providerCorrelationId,
        }),
        ...(terminal.providerCorrelationId != null && {
          terminalProviderCorrelationId: terminal.providerCorrelationId,
        }),
        ...(terminal.retryReason != null && { retryReason: terminal.retryReason }),
      });
    }
    let terminalResult = 'success';
    if (cancelled) {
      terminalResult = 'cancelled';
    } else if (failed) {
      terminalResult = 'error';
    }
    logTelemetry('[FoundryRouterTelemetry] Generation lifecycle completed', {
      ...correlation,
      result: terminalResult,
      clientSurface: CLIENT_SURFACES.has(clientSurface) ? clientSurface : 'none',
      clientOutputState: OUTPUT_STATES.has(clientOutputState) ? clientOutputState : 'none',
      ...(INCOMPLETE_REASONS.has(clientIncompleteReason) && { clientIncompleteReason }),
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

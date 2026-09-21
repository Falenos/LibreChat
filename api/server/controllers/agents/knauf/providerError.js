const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);
const RETRYABLE_PROVIDER_IDENTIFIERS = new Set(['server_error']);
const RETRY_DECISIONS = new Set(['retry', 'not_retryable', 'unsafe_after_output', 'cancelled']);
const OUTPUT_STATES = new Set(['none', 'answer_text', 'activity_only']);
const INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter', 'other']);

const boundedIdentifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

const boundedParameter = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,256}$/.test(value) ? value : undefined;

const getStatus = (error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};

const getRetryDecision = (error) => {
  const decision = error?.knaufRetryDecision ?? error?.error?.knauf_retry_decision;
  return RETRY_DECISIONS.has(decision) ? decision : undefined;
};

const getOutputState = (error) => {
  const state = error?.knaufOutputState ?? error?.error?.knauf_output_state;
  return OUTPUT_STATES.has(state) ? state : undefined;
};

const getIncompleteReason = (error) => {
  const reason = error?.knaufIncompleteReason ?? error?.error?.knauf_incomplete_reason;
  return INCOMPLETE_REASONS.has(reason) ? reason : undefined;
};

const getProviderRequestId = (value) => {
  const headers = value?.headers ?? value?.response?.headers;
  return boundedIdentifier(
    value?.request_id ??
      value?.requestId ??
      value?.requestID ??
      headers?.get?.('x-request-id') ??
      headers?.['x-request-id'] ??
      headers?.['apim-request-id'],
  );
};

const isRetryableProviderError = (error) => {
  const retryDecision = getRetryDecision(error);
  if (retryDecision != null) {
    return retryDecision === 'retry';
  }
  const status = getStatus(error);
  if (status != null) {
    return status === 408 || status === 429 || status >= 500;
  }
  const code = error?.code ?? error?.error?.code;
  const type = error?.type ?? error?.error?.type;
  return (
    NETWORK_ERROR_CODES.has(code) ||
    RETRYABLE_PROVIDER_IDENTIFIERS.has(code) ||
    RETRYABLE_PROVIDER_IDENTIFIERS.has(type)
  );
};

const summarizeProviderError = (error, operation) => {
  const providerStatus = getStatus(error);
  const code = boundedIdentifier(error?.code ?? error?.error?.code);
  const type = boundedIdentifier(error?.type ?? error?.error?.type);
  const param = boundedParameter(error?.param ?? error?.error?.param);
  const constructorName = boundedIdentifier(error?.constructor?.name);
  const errorName =
    (constructorName === 'Object' ? undefined : constructorName) ?? boundedIdentifier(error?.name);
  const requestId = getProviderRequestId(error);
  const retryDecision = getRetryDecision(error);
  const outputState = getOutputState(error);
  const incompleteReason = getIncompleteReason(error);

  return {
    operation,
    retryable: isRetryableProviderError(error),
    ...(providerStatus != null && { providerStatus }),
    ...(code != null && { code }),
    ...(type != null && { type }),
    ...(param != null && { param }),
    ...(errorName != null && { errorName }),
    ...(requestId != null && { requestId }),
    ...(retryDecision != null && { retryDecision }),
    ...(outputState != null && { outputState }),
    ...(incompleteReason != null && { incompleteReason }),
  };
};

// [knauf] NO-TICKET — expose only stable, actionable generation classes.
const getPublicGenerationError = (summary) => {
  if (summary.code === 'attachment_unavailable') {
    return summary.code;
  }
  return summary.providerStatus === 400 ? 'provider_bad_request' : 'provider_request_failed';
};
// End [knauf]

const GENERIC_GENERATION_ERROR = 'An error occurred while processing the request';
const INCOMPLETE_RESPONSE_ERROR = JSON.stringify({ type: 'incomplete_response' });

const hasVisibleText = (contentParts) =>
  Array.isArray(contentParts) &&
  contentParts.some((part) => {
    if (part?.type !== 'text') {
      return false;
    }
    const text = part.text;
    return typeof text === 'string'
      ? text.trim().length > 0
      : typeof text?.value === 'string' && text.value.trim().length > 0;
  });

const getPersistedGenerationError = (summary, contentParts) => {
  if (summary?.retryDecision === 'cancelled') {
    return null;
  }
  if (
    summary?.retryDecision === 'unsafe_after_output' &&
    summary?.outputState === 'answer_text' &&
    hasVisibleText(contentParts)
  ) {
    return { content: INCOMPLETE_RESPONSE_ERROR, surface: 'incomplete_response' };
  }
  return { content: GENERIC_GENERATION_ERROR, surface: 'generic_error' };
};

module.exports = {
  getIncompleteReason,
  getOutputState,
  getPersistedGenerationError,
  getProviderRequestId,
  getRetryDecision,
  getPublicGenerationError,
  isRetryableProviderError,
  summarizeProviderError,
};

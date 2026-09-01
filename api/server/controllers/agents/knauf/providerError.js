const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);
const RETRYABLE_PROVIDER_IDENTIFIERS = new Set(['server_error']);

const boundedIdentifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

const boundedParameter = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,256}$/.test(value) ? value : undefined;

const getStatus = (error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
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

  return {
    operation,
    retryable: isRetryableProviderError(error),
    ...(providerStatus != null && { providerStatus }),
    ...(code != null && { code }),
    ...(type != null && { type }),
    ...(param != null && { param }),
    ...(errorName != null && { errorName }),
    ...(requestId != null && { requestId }),
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

module.exports = {
  getProviderRequestId,
  getPublicGenerationError,
  isRetryableProviderError,
  summarizeProviderError,
};

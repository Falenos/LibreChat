const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const boundedIdentifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

const getStatus = (error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};

const getRequestId = (error) => {
  const headers = error?.headers ?? error?.response?.headers;
  return boundedIdentifier(
    error?.request_id ??
      error?.requestId ??
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
  return NETWORK_ERROR_CODES.has(error?.code);
};

const summarizeProviderError = (error, operation) => {
  const providerStatus = getStatus(error);
  const code = boundedIdentifier(error?.code ?? error?.error?.code);
  const type = boundedIdentifier(error?.type ?? error?.error?.type);
  const requestId = getRequestId(error);

  return {
    operation,
    retryable: isRetryableProviderError(error),
    ...(providerStatus != null && { providerStatus }),
    ...(code != null && { code }),
    ...(type != null && { type }),
    ...(requestId != null && { requestId }),
  };
};

module.exports = { isRetryableProviderError, summarizeProviderError };

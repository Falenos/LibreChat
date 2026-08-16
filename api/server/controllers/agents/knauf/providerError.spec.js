const { createRequire } = require('node:module');
const {
  getProviderRequestId,
  isRetryableProviderError,
  summarizeProviderError,
} = require('./providerError');

describe('[knauf] provider error safety', () => {
  it.each([
    [{ status: 408 }, true],
    [{ status: 429 }, true],
    [{ status: 503 }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ status: 400 }, false],
    [{ status: 422 }, false],
    [{ status: 403 }, false],
  ])('classifies retryability for %p', (error, expected) => {
    expect(isRetryableProviderError(error)).toBe(expected);
  });

  it('keeps only bounded operational fields from a rich provider error', () => {
    const base64 = Buffer.alloc(20_000, 'a').toString('base64');
    const error = Object.assign(new Error(`data:image/png;base64,${base64}`), {
      status: 400,
      code: 'invalid_payload',
      type: 'invalid_request_error',
      param: 'input[3].content[1].image_url',
      request_id: 'req-safe-123',
      userId: 'user-secret',
      path: '/private/upload.png',
      request: { body: { input: base64 } },
    });

    const summary = summarizeProviderError(error, 'agent_generation');

    expect(summary).toEqual({
      operation: 'agent_generation',
      retryable: false,
      providerStatus: 400,
      code: 'invalid_payload',
      type: 'invalid_request_error',
      param: 'input[3].content[1].image_url',
      errorName: 'Error',
      requestId: 'req-safe-123',
    });
    expect(JSON.stringify(summary)).not.toContain(base64.substring(0, 32));
    expect(JSON.stringify(summary)).not.toContain('user-secret');
    expect(JSON.stringify(summary)).not.toContain('upload.png');
  });

  it('drops unsafe and unbounded identifiers', () => {
    const summary = summarizeProviderError(
      {
        status: 500,
        code: 'bad code with user data',
        type: 'x'.repeat(200),
        param: 'input /private/upload.png',
        request_id: 'id with spaces',
      },
      'agent_generation',
    );

    expect(summary).toEqual({
      operation: 'agent_generation',
      retryable: true,
      providerStatus: 500,
    });
  });

  it('uses the bounded SDK error class name when available', () => {
    class BadRequestError extends Error {}

    expect(summarizeProviderError(new BadRequestError('private'), 'model_router_call')).toEqual({
      operation: 'model_router_call',
      retryable: false,
      errorName: 'BadRequestError',
    });
  });

  it('matches the OpenAI SDK contract used by @langchain/openai', () => {
    const openAIRequire = createRequire(require.resolve('@langchain/openai'));
    const { APIError, BadRequestError } = openAIRequire('openai');
    const error = APIError.generate(
      400,
      {
        error: {
          message: 'private provider detail',
          code: 'unsupported_value',
          type: 'invalid_request_error',
          param: 'text.verbosity',
        },
      },
      undefined,
      new Headers({ 'x-request-id': 'azure-request-contract' }),
    );

    expect(error).toBeInstanceOf(BadRequestError);
    const summary = summarizeProviderError(error, 'model_router_call');
    expect(summary).toEqual({
      operation: 'model_router_call',
      retryable: false,
      providerStatus: 400,
      code: 'unsupported_value',
      type: 'invalid_request_error',
      param: 'text.verbosity',
      errorName: 'BadRequestError',
      requestId: 'azure-request-contract',
    });
    expect(JSON.stringify(summary)).not.toContain('private provider detail');
  });

  it('extracts a bounded provider request ID from response headers', () => {
    expect(
      getProviderRequestId({
        response: { headers: { 'apim-request-id': 'azure-request-123' } },
      }),
    ).toBe('azure-request-123');
    expect(getProviderRequestId({ requestID: 'sdk-request-456' })).toBe('sdk-request-456');
    expect(
      getProviderRequestId({ headers: { 'x-request-id': 'unsafe request id' } }),
    ).toBeUndefined();
  });
});

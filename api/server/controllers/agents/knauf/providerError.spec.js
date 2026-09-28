const { createRequire } = require('node:module');
const {
  getIncompleteReason,
  getOutputState,
  getPersistedGenerationError,
  getProviderCorrelationId,
  getProviderRequestId,
  getPublicGenerationError,
  getRetryDecision,
  isRetryableProviderError,
  summarizeProviderError,
} = require('./providerError');

describe('[knauf] provider error safety', () => {
  it.each([
    [{ status: 408 }, true],
    [{ status: 429 }, true],
    [{ status: 503 }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ code: 'server_error' }, true],
    [{ error: { type: 'server_error' } }, true],
    [{ status: 400 }, false],
    [{ status: 422 }, false],
    [{ status: 403 }, false],
    [{ code: 'unsupported_value' }, false],
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
      headers: {
        'apim-request-id': 'corr-safe-123',
        authorization: 'Bearer provider-secret',
      },
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
      correlationId: 'corr-safe-123',
    });
    expect(JSON.stringify(summary)).not.toContain(base64.substring(0, 32));
    expect(JSON.stringify(summary)).not.toContain('user-secret');
    expect(JSON.stringify(summary)).not.toContain('upload.png');
    expect(JSON.stringify(summary)).not.toContain('provider-secret');
  });

  it('drops unsafe and unbounded identifiers', () => {
    const summary = summarizeProviderError(
      {
        status: 500,
        code: 'bad code with user data',
        type: 'x'.repeat(200),
        param: 'input /private/upload.png',
        request_id: 'id with spaces',
        apim_request_id: 'correlation id with spaces',
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
      new Headers({
        'x-request-id': 'azure-request-contract',
        'apim-request-id': 'azure-correlation-contract',
      }),
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
      correlationId: 'azure-correlation-contract',
    });
    expect(JSON.stringify(summary)).not.toContain('private provider detail');
  });

  it('matches a streamed OpenAI server error without an HTTP status', () => {
    const openAIRequire = createRequire(require.resolve('@langchain/openai'));
    const { APIError } = openAIRequire('openai');
    const error = new APIError(
      undefined,
      {
        message: 'private streamed provider detail',
        code: 'server_error',
        type: 'server_error',
      },
      undefined,
      new Headers({
        'x-request-id': 'azure-stream-request',
        'apim-request-id': 'azure-stream-correlation',
      }),
    );

    const summary = summarizeProviderError(error, 'model_router_call');
    expect(summary).toEqual({
      operation: 'model_router_call',
      retryable: true,
      code: 'server_error',
      type: 'server_error',
      errorName: 'APIError',
      requestId: 'azure-stream-request',
      correlationId: 'azure-stream-correlation',
    });
    expect(JSON.stringify(summary)).not.toContain('private streamed provider detail');
  });

  it('honors the bounded stream retry decision over a retryable provider code', () => {
    const error = {
      code: 'server_error',
      error: {
        knauf_retry_decision: 'unsafe_after_output',
        knauf_output_state: 'answer_text',
      },
    };

    expect(getRetryDecision(error)).toBe('unsafe_after_output');
    expect(getOutputState(error)).toBe('answer_text');
    expect(isRetryableProviderError(error)).toBe(false);
    expect(summarizeProviderError(error, 'model_router_call')).toEqual({
      operation: 'model_router_call',
      retryable: false,
      code: 'server_error',
      retryDecision: 'unsafe_after_output',
      outputState: 'answer_text',
    });
  });

  it('keeps partial streamed text without adding a user-facing error', () => {
    const persisted = getPersistedGenerationError(
      {
        retryDecision: 'unsafe_after_output',
        outputState: 'answer_text',
        code: 'private_provider_code',
        message: 'private provider response',
      },
      [{ type: 'text', text: 'Partial answer' }],
    );

    expect(persisted).toBeNull();
  });

  it.each([
    { outputState: 'answer_text', contentParts: [], label: 'no content' },
    {
      outputState: 'answer_text',
      contentParts: [{ type: 'text', text: '   ' }],
      label: 'blank text',
    },
    {
      outputState: 'activity_only',
      contentParts: [{ type: 'tool_call', tool_call: { name: 'external_side_effect' } }],
      label: 'tool activity',
    },
    {
      outputState: 'activity_only',
      contentParts: [{ type: 'text', text: 'Answer from an earlier model phase' }],
      label: 'earlier-phase text',
    },
    {
      outputState: 'none',
      contentParts: [{ type: 'text', text: 'Answer from an earlier model phase' }],
      label: 'pre-answer failure after earlier-phase text',
    },
  ])('keeps the generic error for unsafe failures with $label', ({ outputState, contentParts }) => {
    expect(
      getPersistedGenerationError(
        { retryDecision: 'unsafe_after_output', outputState },
        contentParts,
      ),
    ).toEqual({
      content: 'An error occurred while processing the request',
      surface: 'generic_error',
    });
  });

  it('silences a cancellation even when the outer abort signal has not propagated', () => {
    expect(
      getPersistedGenerationError({ retryDecision: 'cancelled', outputState: 'activity_only' }, [
        { type: 'text', text: 'Earlier text' },
      ]),
    ).toBeNull();
  });

  it('accepts only bounded output state and incomplete reason fields', () => {
    const wrapped = {
      error: {
        knauf_output_state: 'activity_only',
        knauf_incomplete_reason: 'content_filter',
      },
    };
    expect(getOutputState(wrapped)).toBe('activity_only');
    expect(getIncompleteReason(wrapped)).toBe('content_filter');
    expect(getOutputState({ knaufOutputState: 'answer_text' })).toBe('answer_text');
    expect(getOutputState({ knaufOutputState: 'private text' })).toBeUndefined();
    expect(
      getIncompleteReason({ error: { knauf_incomplete_reason: 'private text' } }),
    ).toBeUndefined();
  });

  it('projects output state from the installed OpenAI stream error shape', () => {
    const openAIRequire = createRequire(require.resolve('@langchain/openai'));
    const { APIError } = openAIRequire('openai');
    const error = new APIError(
      undefined,
      {
        message: 'private streamed provider detail',
        code: 'response_incomplete',
        type: 'content_filter',
        knauf_retry_decision: 'unsafe_after_output',
        knauf_output_state: 'answer_text',
        knauf_incomplete_reason: 'content_filter',
      },
      undefined,
      new Headers(),
    );

    expect(summarizeProviderError(error, 'model_router_call')).toEqual({
      operation: 'model_router_call',
      retryable: false,
      code: 'response_incomplete',
      type: 'content_filter',
      errorName: 'APIError',
      retryDecision: 'unsafe_after_output',
      outputState: 'answer_text',
      incompleteReason: 'content_filter',
    });
  });

  it('keeps the provider request and Azure diagnostic correlation IDs distinct', () => {
    const response = {
      response: {
        headers: {
          'x-request-id': 'azure-request-123',
          'apim-request-id': 'azure-correlation-123',
        },
      },
    };

    expect(getProviderRequestId(response)).toBe('azure-request-123');
    expect(getProviderCorrelationId(response)).toBe('azure-correlation-123');
    expect(getProviderRequestId({ requestID: 'sdk-request-456' })).toBe('sdk-request-456');
    expect(
      getProviderRequestId({ headers: { 'apim-request-id': 'correlation-only' } }),
    ).toBeUndefined();
    expect(getProviderCorrelationId({ apimRequestID: 'sdk-correlation-456' })).toBe(
      'sdk-correlation-456',
    );
    expect(
      getProviderRequestId({ headers: { 'x-request-id': 'unsafe request id' } }),
    ).toBeUndefined();
    expect(
      getProviderCorrelationId({ headers: { 'apim-request-id': 'unsafe correlation id' } }),
    ).toBeUndefined();
  });

  it('preserves only the stable missing-attachment outcome', () => {
    expect(getPublicGenerationError({ code: 'attachment_unavailable' })).toBe(
      'attachment_unavailable',
    );
    expect(getPublicGenerationError({ code: 'private_provider_code' })).toBe(
      'provider_request_failed',
    );
  });

  it('classifies provider 400 responses without provider text', () => {
    expect(getPublicGenerationError({ providerStatus: 400 })).toBe('provider_bad_request');
  });
});

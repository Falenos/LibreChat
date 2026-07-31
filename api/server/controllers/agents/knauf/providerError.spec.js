const { isRetryableProviderError, summarizeProviderError } = require('./providerError');

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
});

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: { azureOpenAI: 'azureOpenAI', openAI: 'openAI' },
}));

const { resolveProvider, tokenLimitParam } = require('./resolveProvider');

describe('resolveProvider', () => {
  it('switches azureOpenAI → openAI when useResponsesApi is active', () => {
    const result = resolveProvider({
      provider: 'azureOpenAI',
      llmConfig: { useResponsesApi: true },
    });
    expect(result.provider).toBe('openAI');
    expect(result.useResponsesApi).toBe(true);
  });

  it('keeps azureOpenAI when useResponsesApi is falsy', () => {
    const result = resolveProvider({
      provider: 'azureOpenAI',
      llmConfig: { useResponsesApi: false },
    });
    expect(result.provider).toBe('azureOpenAI');
    expect(result.useResponsesApi).toBe(false);
  });

  it('keeps azureOpenAI when llmConfig has no useResponsesApi', () => {
    const result = resolveProvider({
      provider: 'azureOpenAI',
      llmConfig: {},
    });
    expect(result.provider).toBe('azureOpenAI');
    expect(result.useResponsesApi).toBe(false);
  });

  it('passes through non-Azure providers unchanged even with useResponsesApi', () => {
    const result = resolveProvider({
      provider: 'openAI',
      llmConfig: { useResponsesApi: true },
    });
    expect(result.provider).toBe('openAI');
    expect(result.useResponsesApi).toBe(true);
  });

  it('handles missing llmConfig gracefully', () => {
    const result = resolveProvider({ provider: 'azureOpenAI', llmConfig: null });
    expect(result.provider).toBe('azureOpenAI');
    expect(result.useResponsesApi).toBe(false);
  });
});

describe('tokenLimitParam', () => {
  it('returns max_output_tokens for Responses API', () => {
    expect(tokenLimitParam(true)).toBe('max_output_tokens');
  });

  it('returns max_completion_tokens for Completions API', () => {
    expect(tokenLimitParam(false)).toBe('max_completion_tokens');
  });
});

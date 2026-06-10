const {
  EModelEndpoint,
  parseCompactConvo,
  getDefaultParamsEndpoint,
} = require('librechat-data-provider');
const { normalizeImportedSpecOptions, hydrateParsedBodyFromCurrentSpec } = require('./modelSpec');

describe('Knauf model spec compatibility helpers', () => {
  const appConfig = {
    modelSpecs: {
      list: [
        {
          name: 'karl',
          label: 'KARL',
          iconURL: 'current-icon',
          preset: {
            endpoint: EModelEndpoint.azureOpenAI,
            model: 'current-karl-model',
            promptPrefix: 'Current Karl prompt',
            useResponsesApi: true,
            reasoning_effort: 'medium',
          },
        },
      ],
    },
  };

  it('normalizes imported spec options from the current model spec preset', () => {
    const normalized = normalizeImportedSpecOptions(
      {
        title: 'Imported legacy chat',
        tags: ['audit'],
        spec: 'karl',
        endpoint: 'gptPlugins',
        model: 'gpt-5',
        promptPrefix: 'Old Karl prompt',
        useResponsesApi: false,
        tools: ['legacy-tool'],
        agentOptions: { model: 'gpt-5' },
        iconURL: 'gptPlugins',
      },
      appConfig,
    );

    expect(normalized).toEqual({
      title: 'Imported legacy chat',
      tags: ['audit'],
      spec: 'karl',
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'current-karl-model',
      promptPrefix: 'Current Karl prompt',
      useResponsesApi: true,
      reasoning_effort: 'medium',
      iconURL: 'current-icon',
    });
  });

  it('leaves imports unchanged when the spec is not configured anymore', () => {
    const options = {
      spec: 'missing-spec',
      endpoint: 'gptPlugins',
      model: 'gpt-5',
    };

    expect(normalizeImportedSpecOptions(options, appConfig)).toBe(options);
  });

  it('hydrates stale parsed request bodies from the current model spec preset', () => {
    const hydrated = hydrateParsedBodyFromCurrentSpec({
      parsedBody: {
        spec: 'karl',
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'gpt-5',
        promptPrefix: 'Old Karl prompt',
        useResponsesApi: false,
      },
      appConfig,
      endpointsConfig: {
        [EModelEndpoint.azureOpenAI]: {},
      },
      parseCompactConvo,
      getDefaultParamsEndpoint,
    });

    expect(hydrated).toMatchObject({
      endpoint: EModelEndpoint.azureOpenAI,
      endpointType: undefined,
      parsedBody: {
        spec: 'karl',
        model: 'current-karl-model',
        promptPrefix: 'Current Karl prompt',
        useResponsesApi: true,
        reasoning_effort: 'medium',
        iconURL: 'current-icon',
      },
    });
  });
});

const SPEC_PRESET_FIELDS = [
  'endpoint',
  'endpointType',
  'model',
  'modelLabel',
  'chatGptLabel',
  'promptPrefix',
  'temperature',
  'top_p',
  'topP',
  'topK',
  'presence_penalty',
  'frequency_penalty',
  'resendFiles',
  'imageDetail',
  'maxContextTokens',
  'max_tokens',
  'maxOutputTokens',
  'maxTokens',
  'reasoning_effort',
  'reasoning_summary',
  'verbosity',
  'useResponsesApi',
  'web_search',
  'disableStreaming',
  'fileTokenLimit',
  'tools',
  'greeting',
  'iconURL',
  'agent_id',
  'assistant_id',
  'instructions',
  'additional_instructions',
  'append_current_datetime',
  'artifacts',
  'stop',
  'region',
  'examples',
  'context',
  'promptCache',
  'thinking',
  'thinkingBudget',
  'thinkingLevel',
  'effort',
  'thinkingDisplay',
];

const LEGACY_RUNTIME_FIELDS = ['agentOptions'];

function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function getCurrentModelSpec(appConfig, specName) {
  if (!specName) {
    return null;
  }
  return appConfig?.modelSpecs?.list?.find((spec) => spec.name === specName) ?? null;
}

function getCurrentModelSpecIconURL(modelSpec) {
  return modelSpec?.iconURL ?? modelSpec?.preset?.iconURL ?? modelSpec?.preset?.endpoint;
}

function stripSpecRuntimeFields(options) {
  const cleaned = { ...(options ?? {}) };
  for (const key of SPEC_PRESET_FIELDS) {
    delete cleaned[key];
  }
  for (const key of LEGACY_RUNTIME_FIELDS) {
    delete cleaned[key];
  }
  return cleaned;
}

function normalizeImportedSpecOptions(options, appConfig) {
  const specName = options?.spec;
  const modelSpec = getCurrentModelSpec(appConfig, specName);
  if (!modelSpec?.preset) {
    return options;
  }

  return removeUndefined({
    ...stripSpecRuntimeFields(options),
    ...modelSpec.preset,
    spec: specName,
    iconURL: getCurrentModelSpecIconURL(modelSpec),
  });
}

function hydrateParsedBodyFromCurrentSpec({
  parsedBody,
  appConfig,
  endpointsConfig,
  parseCompactConvo,
  getDefaultParamsEndpoint,
}) {
  const specName = parsedBody?.spec;
  const modelSpec = getCurrentModelSpec(appConfig, specName);
  if (!modelSpec?.preset?.endpoint) {
    return null;
  }

  const endpoint = modelSpec.preset.endpoint;
  const endpointType = modelSpec.preset.endpointType;
  const nextParsedBody = parseCompactConvo({
    endpoint,
    endpointType,
    conversation: {
      ...modelSpec.preset,
      spec: specName,
      chatProjectId: parsedBody.chatProjectId,
    },
    defaultParamsEndpoint: getDefaultParamsEndpoint(endpointsConfig, endpoint),
  });
  if (!nextParsedBody) {
    return null;
  }

  const iconURL = getCurrentModelSpecIconURL(modelSpec);
  if (iconURL != null && iconURL !== '') {
    nextParsedBody.iconURL = iconURL;
  }

  return {
    endpoint,
    endpointType,
    parsedBody: nextParsedBody,
  };
}

module.exports = {
  getCurrentModelSpec,
  normalizeImportedSpecOptions,
  hydrateParsedBodyFromCurrentSpec,
};

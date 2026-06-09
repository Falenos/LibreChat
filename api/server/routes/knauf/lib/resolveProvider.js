/**
 * Resolve the effective provider for initializeModel.
 *
 * When the Azure config pipeline enables the Responses API (e.g. via
 * `addParams: { web_search: true }` on an Azure group), it strips
 * Azure-specific fields (instanceName, deploymentName) from llmConfig
 * and replaces them with a plain apiKey + baseURL pointing at the
 * Azure "/openai/v1" endpoint. The resulting config is OpenAI-compatible,
 * so we must use ChatOpenAI (provider 'openAI'), not AzureChatOpenAI
 * (provider 'azureOpenAI') — the latter would crash because the Azure
 * fields it requires no longer exist.
 *
 * Similarly, the Responses API expects `max_output_tokens` instead of
 * the Completions API's `max_completion_tokens`.
 *
 * This helper centralises that knowledge so every Knauf route that calls
 * initializeModel can resolve the provider in one place.
 */
const { EModelEndpoint } = require('librechat-data-provider');

/**
 * @param {object}  opts
 * @param {string}  opts.provider   – original provider from config (e.g. 'azureOpenAI')
 * @param {object}  opts.llmConfig  – config returned by getProviderConfig → getOptions
 * @returns {{ provider: string, useResponsesApi: boolean }}
 */
function resolveProvider({ provider, llmConfig }) {
  const useResponsesApi = Boolean(llmConfig?.useResponsesApi);
  const resolved =
    useResponsesApi && provider === EModelEndpoint.azureOpenAI
      ? EModelEndpoint.openAI
      : provider;
  return { provider: resolved, useResponsesApi };
}

/**
 * Return the correct token-limit parameter name for the active API mode.
 * @param {boolean} useResponsesApi
 * @returns {string}
 */
function tokenLimitParam(useResponsesApi) {
  return useResponsesApi ? 'max_output_tokens' : 'max_completion_tokens';
}

module.exports = { resolveProvider, tokenLimitParam };

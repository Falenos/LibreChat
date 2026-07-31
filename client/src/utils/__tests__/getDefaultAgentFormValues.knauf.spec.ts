/**
 * [knauf] KK20-194 — "Browse the internet" defaults ON for new agents.
 *
 * Anchors the default-on seam in getDefaultAgentFormValues (forms.tsx). It must
 * replicate browseInternet.applyToForm(true) exactly: the `web_search` form flag
 * (which AgentPanel.onSubmit turns into the raw browse intent that gates open_url)
 * AND model_parameters.{web_search, useResponsesApi} (which enable Azure-native
 * model-level web_search). Fails if a future change drops the default-on or only
 * sets one half of the pair.
 */
import { Tools } from 'librechat-data-provider';
import { getDefaultAgentFormValues } from '../forms';

describe('[knauf] getDefaultAgentFormValues — browse-default-on', () => {
  it('defaults the web_search form flag ON', () => {
    const values = getDefaultAgentFormValues() as Record<string, unknown>;
    expect(values[Tools.web_search]).toBe(true);
  });

  it('defaults model_parameters to enable Azure-native web_search via Responses API', () => {
    const values = getDefaultAgentFormValues() as Record<string, unknown>;
    const params = values.model_parameters as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params.web_search).toBe(true);
    expect(params.useResponsesApi).toBe(true);
  });
});

// [knauf] New-agent forms opt into the dynamic full catalog of accessible deployment/public skills.
describe('[knauf] getDefaultAgentFormValues — skills-default-on', () => {
  it('enables all accessible skills by default without freezing an allowlist', () => {
    const values = getDefaultAgentFormValues();
    expect(values.skills_enabled).toBe(true);
    expect(values.skills).toBeUndefined();
  });
});
// End [knauf]

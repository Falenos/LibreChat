import { EModelEndpoint } from 'librechat-data-provider';
import { hasKnaufPickerSelection } from './KnaufModelSelector';

describe('[knauf] KnaufModelSelector default binding (KK20-256)', () => {
  it.each([
    {
      name: 'an empty startup selection',
      selection: { endpoint: '', model: '', modelSpec: '' },
    },
    {
      name: 'a raw Azure startup fallback',
      selection: {
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'agent-default',
        modelSpec: '',
      },
    },
  ])('treats $name as replaceable', ({ selection }) => {
    expect(hasKnaufPickerSelection(selection)).toBe(false);
  });

  it.each([
    {
      name: 'a model spec',
      selection: {
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'agent-default',
        modelSpec: 'karl',
      },
    },
    {
      name: 'a custom agent',
      selection: {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        modelSpec: '',
      },
    },
  ])('preserves $name', ({ selection }) => {
    expect(hasKnaufPickerSelection(selection)).toBe(true);
  });
});

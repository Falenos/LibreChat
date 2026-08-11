import type { TConversation, TModelSpec, TPreset } from 'librechat-data-provider';
import { knaufHardDefaultSpecApplies } from './knaufDefaultSpec';

/**
 * [knauf] KK20-257 — the decision that stops "New chat" from creating a spec-less
 * conversation. See the helper's docblock for the full trace; in short, `useNewConvo`'s
 * `shouldApplyModelSpec` never covers a hard `default: true` spec, so the button path
 * nulled the ephemeral agent and dropped `execute_code` / `artifacts` / `skills` /
 * `web_search` until a page refresh re-applied the spec via `ChatRoute`.
 */
const hardDefaultSpec = { name: 'karl', default: true } as unknown as TModelSpec;

describe('[knauf] knaufHardDefaultSpecApplies', () => {
  it('applies to a fresh chat: no preset, empty template', () => {
    expect(knaufHardDefaultSpecApplies({ hardDefaultSpec, template: {} })).toBe(true);
  });

  it('applies when the template carries only non-selection fields', () => {
    // What the "New chat" button and a project-scoped new chat actually pass.
    const template = { chatProjectId: 'proj-1' } as unknown as Partial<TConversation>;
    expect(knaufHardDefaultSpecApplies({ hardDefaultSpec, template })).toBe(true);
  });

  it('does not apply when the deployment has no hard default spec', () => {
    // softDefault / last-spec deployments keep upstream's behaviour untouched.
    expect(knaufHardDefaultSpecApplies({ hardDefaultSpec: null, template: {} })).toBe(false);
    expect(knaufHardDefaultSpecApplies({ template: {} })).toBe(false);
  });

  it('does not apply when the caller already resolved a preset', () => {
    const preset = { spec: 'karl-web' } as unknown as Partial<TPreset>;
    expect(knaufHardDefaultSpecApplies({ hardDefaultSpec, preset, template: {} })).toBe(false);
  });

  it.each([
    ['spec', { spec: 'karl-writer' }],
    ['agent_id', { agent_id: 'agent_abc' }],
    ['assistant_id', { assistant_id: 'asst_abc' }],
    ['model', { model: 'gpt-4o' }],
    ['endpoint', { endpoint: 'azureOpenAI' }],
  ])('does not override a deliberate %s selection in the template', (_field, template) => {
    // `modelSpecs.enforce: false` lets a user pick something other than the default;
    // inheriting the default spec's capabilities over that choice would be the opposite
    // bug — quietly switching tools on for a conversation the user configured by hand.
    expect(
      knaufHardDefaultSpecApplies({
        hardDefaultSpec,
        template: template as unknown as Partial<TConversation>,
      }),
    ).toBe(false);
  });

  it('treats an absent template as fresh', () => {
    expect(knaufHardDefaultSpecApplies({ hardDefaultSpec })).toBe(true);
  });
});

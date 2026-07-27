/**
 * [knauf] KK20-243 — guard the capability registry's form contract.
 *
 * `KnaufAgentConfig` filters this registry by `isEnabled(enabledCapabilities)`
 * and auto-renders a row per survivor, so a wrong `isEnabled` gate silently
 * hides a capability and a wrong `applyToForm` silently writes a field the
 * server ignores. Neither shows up as a failing render.
 *
 * The specific trap: `artifacts` persists as a STRING (`ArtifactModes`), while
 * every other capability here is a boolean. Writing `true` would round-trip
 * through the form and then be dropped, because the agent schema types it as a
 * string.
 */
import { AgentCapabilities, ArtifactModes } from 'librechat-data-provider';
import { KNAUF_CAPABILITIES } from './capabilities';

function capabilityById(id: string) {
  const capability = KNAUF_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) {
    throw new Error(`No capability registered with id "${id}"`);
  }
  return capability;
}

/** Minimal react-hook-form doubles: record what applyToForm writes. */
function makeHelpers(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    helpers: {
      getValues: ((name?: string) => (name == null ? values : values[name])) as never,
      setValue: ((name: string, value: unknown) => {
        values[name] = value;
      }) as never,
    },
  };
}

describe('[knauf] KNAUF_CAPABILITIES registry', () => {
  it('registers unique ids', () => {
    const ids = KNAUF_CAPABILITIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes artifacts and skills alongside web search', () => {
    expect(KNAUF_CAPABILITIES.map((entry) => entry.id)).toEqual(['web', 'artifacts', 'skills']);
  });

  describe('gating on endpoints.agents.capabilities', () => {
    it('hides artifacts and skills when the endpoint does not enable them', () => {
      const enabled = [AgentCapabilities.file_search, AgentCapabilities.tools];
      const visible = KNAUF_CAPABILITIES.filter((entry) => entry.isEnabled(enabled)).map(
        (entry) => entry.id,
      );
      // web_search is model-level and deliberately always shown (KK20-194).
      expect(visible).toEqual(['web']);
    });

    it('shows artifacts and skills once the endpoint enables them', () => {
      const enabled = [
        AgentCapabilities.file_search,
        AgentCapabilities.tools,
        AgentCapabilities.artifacts,
        AgentCapabilities.skills,
      ];
      const visible = KNAUF_CAPABILITIES.filter((entry) => entry.isEnabled(enabled)).map(
        (entry) => entry.id,
      );
      expect(visible).toEqual(['web', 'artifacts', 'skills']);
    });
  });

  describe('artifacts writes a mode string, never a boolean', () => {
    const artifacts = capabilityById('artifacts');

    it('writes ArtifactModes.DEFAULT when switched on', () => {
      const { values, helpers } = makeHelpers();
      artifacts.applyToForm(true, helpers);
      expect(values[AgentCapabilities.artifacts]).toBe(ArtifactModes.DEFAULT);
      expect(typeof values[AgentCapabilities.artifacts]).toBe('string');
    });

    it('does not write shadcnui — it stacks a second prompt on every turn', () => {
      const { values, helpers } = makeHelpers();
      artifacts.applyToForm(true, helpers);
      expect(values[AgentCapabilities.artifacts]).not.toBe(ArtifactModes.SHADCNUI);
    });

    it('clears to the empty string when switched off', () => {
      const { values, helpers } = makeHelpers({ [AgentCapabilities.artifacts]: 'default' });
      artifacts.applyToForm(false, helpers);
      expect(values[AgentCapabilities.artifacts]).toBe('');
    });

    it('reads any non-empty mode as on, and empty as off', () => {
      expect(
        artifacts.readFromForm(makeHelpers({ [AgentCapabilities.artifacts]: 'default' }).helpers),
      ).toBe(true);
      expect(
        artifacts.readFromForm(makeHelpers({ [AgentCapabilities.artifacts]: '' }).helpers),
      ).toBe(false);
      expect(artifacts.readFromForm(makeHelpers().helpers)).toBe(false);
    });
  });

  describe('skills writes the strict-opt-in master toggle', () => {
    const skills = capabilityById('skills');

    it('writes skills_enabled exactly true, since the server compares identity', () => {
      const { values, helpers } = makeHelpers();
      skills.applyToForm(true, helpers);
      expect(values.skills_enabled).toBe(true);
    });

    it('leaves the optional skills allowlist untouched so the full catalog applies', () => {
      const { values, helpers } = makeHelpers();
      skills.applyToForm(true, helpers);
      expect(values.skills).toBeUndefined();
    });

    it('writes false when switched off', () => {
      const { values, helpers } = makeHelpers({ skills_enabled: true });
      skills.applyToForm(false, helpers);
      expect(values.skills_enabled).toBe(false);
    });

    it('round-trips through readFromForm', () => {
      expect(skills.readFromForm(makeHelpers({ skills_enabled: true }).helpers)).toBe(true);
      expect(skills.readFromForm(makeHelpers({ skills_enabled: false }).helpers)).toBe(false);
      expect(skills.readFromForm(makeHelpers().helpers)).toBe(false);
    });
  });

  it('gives every entry a label and a description for the switch row', () => {
    for (const entry of KNAUF_CAPABILITIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.icon).toBeDefined();
    }
  });
});

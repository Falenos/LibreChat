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
import deTranslation from '~/locales/de/translation.json';
import enTranslation from '~/locales/en/translation.json';
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

  it('exposes artifacts, code and skills alongside web search', () => {
    // Order is render order in the V6 panel. `code` sits with the other
    // output-producing capabilities, before the skills toggle. KK20-257.
    expect(KNAUF_CAPABILITIES.map((entry) => entry.id)).toEqual([
      'web',
      'artifacts',
      'code',
      'skills',
    ]);
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

  // KK20-257. Unlike artifacts (a mode string), execute_code is a plain boolean, and
  // it is the field the chat side reads as `codeAllowedByAgent` — which decides both
  // whether the sandbox row appears in the paperclip menu and whether a tabular
  // attachment may be routed to /mnt/data. A wrong shape here silently disables that.
  describe('code writes the plain execute_code boolean', () => {
    const code = capabilityById('code');

    it('writes execute_code true, not a mode string', () => {
      const { values, helpers } = makeHelpers();
      code.applyToForm(true, helpers);
      expect(values[AgentCapabilities.execute_code]).toBe(true);
    });

    it('writes false when switched off', () => {
      const { values, helpers } = makeHelpers({ [AgentCapabilities.execute_code]: true });
      code.applyToForm(false, helpers);
      expect(values[AgentCapabilities.execute_code]).toBe(false);
    });

    it('round-trips through readFromForm', () => {
      expect(
        code.readFromForm(makeHelpers({ [AgentCapabilities.execute_code]: true }).helpers),
      ).toBe(true);
      expect(
        code.readFromForm(makeHelpers({ [AgentCapabilities.execute_code]: false }).helpers),
      ).toBe(false);
      expect(code.readFromForm(makeHelpers().helpers)).toBe(false);
    });

    it('is hidden unless the endpoint enables execute_code, so a dead tool cannot be armed', () => {
      // The fail-closed guard strips execute_code from the served capability list when
      // LIBRECHAT_CODE_BASEURL is unset, so this gate is also what hides the row on a
      // deployment with no reachable sandbox.
      expect(code.isEnabled([AgentCapabilities.artifacts, AgentCapabilities.skills])).toBe(false);
      expect(code.isEnabled([AgentCapabilities.execute_code])).toBe(true);
    });

    it('watches the field it writes, or the switch renders stale', () => {
      expect(code.watchFields).toContain(AgentCapabilities.execute_code);
    });
  });

  it('gives every entry a label and a description for the switch row', () => {
    for (const entry of KNAUF_CAPABILITIES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      // A name that does not exist in the pinned lucide-react version imports as
      // `undefined` and the row renders iconless — this caught exactly that. KK20-257.
      expect(entry.icon).toBeDefined();
    }
  });

  describe('localization', () => {
    // KnaufAgentConfig renders localize(labelKey) when the key is present. A key
    // that is missing from a locale file renders as the raw key string, which is
    // why both files are asserted rather than just en.
    const locales: Record<string, Record<string, string>> = {
      en: enTranslation as Record<string, string>,
      de: deTranslation as Record<string, string>,
    };

    it('resolves every declared i18n key in both shipped locales', () => {
      const missing: string[] = [];
      for (const entry of KNAUF_CAPABILITIES) {
        for (const key of [entry.labelKey, entry.descriptionKey]) {
          if (key == null) {
            continue;
          }
          for (const [locale, table] of Object.entries(locales)) {
            if (!table[key]) {
              missing.push(`${locale}: ${key}`);
            }
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('namespaces every declared key under com_knauf_', () => {
      for (const entry of KNAUF_CAPABILITIES) {
        for (const key of [entry.labelKey, entry.descriptionKey]) {
          if (key != null) {
            expect(key).toMatch(/^com_knauf_/);
          }
        }
      }
    });

    it('localizes the KK20-243 rows, so German users do not see English', () => {
      for (const id of ['artifacts', 'skills']) {
        const entry = capabilityById(id);
        expect(entry.labelKey).toBeDefined();
        expect(entry.descriptionKey).toBeDefined();
        expect(locales.de[entry.labelKey!]).not.toBe(locales.en[entry.labelKey!]);
      }
    });
  });
});

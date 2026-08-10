/**
 * Knauf capability registry.
 *
 * Each entry is a self-describing capability — UI label, icon, behaviour
 * when toggled, and a gate function that decides whether to show the row
 * given the agent endpoint's enabled-capabilities list (read from
 * `librechat.yaml endpoints.agents.capabilities`). Adding a new V6
 * capability is one entry here + (if needed) a YAML capability flip; the
 * panel auto-renders the row.
 *
 * The registry is consumed by KnaufAgentConfig.tsx — it filters by
 * isEnabled, then renders one CapabilitySwitch per entry, wiring the
 * applyToForm/readFromForm helpers into the form.
 */
// `ChartSpline`/`ChartLine` do not exist in lucide-react 0.394.0 — importing one
// yields `undefined` and the row renders with no icon. KK20-257.
import { Globe, LayoutTemplate, LineChart, ScrollText } from 'lucide-react';
import {
  AgentCapabilities,
  ArtifactModes,
  type AgentCapabilities as AgentCapabilitiesEnum,
} from 'librechat-data-provider';
import type { UseFormGetValues, UseFormSetValue } from 'react-hook-form';
import type { LucideProps } from 'lucide-react';
import type { ComponentType } from 'react';
import type { AgentForm } from '~/common';

interface FormHelpers {
  getValues: UseFormGetValues<AgentForm>;
  setValue: UseFormSetValue<AgentForm>;
}

export interface KnaufCapability {
  /** Stable id for keyed render + state lookups. */
  id: string;
  /**
   * User-facing label shown in the row header. Prefer `labelKey` — this is the
   * untranslated fallback, kept because `browseInternet` predates localization
   * here. Migrate it to a key next time that row is touched.
   */
  label: string;
  /** Short description shown under the label. Prefer `descriptionKey`. */
  description: string;
  /** `com_knauf_*` i18n key for the label. Wins over `label` when set. */
  labelKey?: string;
  /** `com_knauf_*` i18n key for the description. Wins over `description` when set. */
  descriptionKey?: string;
  /** Lucide icon component. */
  icon: ComponentType<LucideProps>;
  /**
   * Form fields `readFromForm` inspects, declared so `CapabilityRow` can
   * subscribe to exactly them.
   *
   * This is load-bearing, not metadata. `CapabilitySwitch` is a *controlled*
   * component: it renders the `checked` prop, and `checked` is recomputed only
   * when the row re-renders. `setValue` does not re-render a subscriber on its
   * own, so a row that writes a field it does not watch updates the form and
   * then displays the stale value — clicking it appears to do nothing, and every
   * later click re-requests the same transition.
   *
   * `browseInternet` escaped this only by accident: it also writes
   * `model_parameters`, which happened to be the one field the row watched.
   * The two KK20-243 rows write a single top-level field each and had no such
   * accident, so they were dead on arrival until this existed.
   *
   * Must stay a stable module-level array — `useWatch` receives it directly, and
   * a fresh literal per render would churn the subscription.
   */
  watchFields: readonly string[];
  /**
   * Returns true when the capability should appear, given the agent
   * endpoint's enabled-capabilities list from librechat.yaml. Capabilities
   * that are model-level (not gated by `endpoints.agents.capabilities`)
   * return true unconditionally.
   */
  isEnabled: (enabled: ReadonlyArray<AgentCapabilitiesEnum | string>) => boolean;
  /** Read whether this capability is on, given the form's current values. */
  readFromForm: (helpers: FormHelpers) => boolean;
  /** Toggle this capability — write the necessary form fields. */
  applyToForm: (next: boolean, helpers: FormHelpers) => void;
}

/**
 * "Browse the internet" — KK20-194. Native model-level web_search handles
 * discovery; open_url is request-scoped to exact links supplied by the user.
 * NOT gated by `endpoints.agents.capabilities`: we deliberately keep
 * `web_search` out of that list so the provider-less LangChain web_search
 * tool stays stripped/unsurfaced. The switch writes the persisted browse intent
 * and `model_parameters.web_search`; the server translates them into the hosted
 * tool. ToolService uses the same persisted intent to expose open_url only when
 * the current message contains a link. Default-ON for KARL and new agents.
 */
const browseInternet: KnaufCapability = {
  id: 'web',
  label: 'Browse the internet',
  description: 'Search the web and read pages for fresh information.',
  icon: Globe,
  // Reads `web_search`; also writes `model_parameters`. Both are listed because
  // watching only `model_parameters` (the historical behaviour) was accidental —
  // it worked solely because `applyToForm` happens to write it too.
  watchFields: [AgentCapabilities.web_search, 'model_parameters'],
  isEnabled: () => true,
  readFromForm: ({ getValues }) => !!getValues(AgentCapabilities.web_search as keyof AgentForm),
  applyToForm: (next, { getValues, setValue }) => {
    setValue(AgentCapabilities.web_search as keyof AgentForm, next as never, {
      shouldDirty: true,
    });
    const params = (getValues('model_parameters') ?? {}) as Record<string, unknown>;
    if (next) {
      setValue(
        'model_parameters',
        {
          ...params,
          web_search: true,
          useResponsesApi: true,
        } as unknown as AgentForm['model_parameters'],
        { shouldDirty: true },
      );
    } else {
      const cleaned = { ...params };
      delete cleaned.web_search;
      // Intentionally do NOT strip `useResponsesApi` here. It's the platform
      // default for Knauf agents (baked into each `karl-personality-*`
      // preset in librechat.yaml) because Azure OpenAI requires Responses
      // API to accept direct PDF/text upload — see the
      // `documentSupportedProviders` allow-list in
      // packages/data-provider/src/schemas.ts and the gate at
      // AttachFileMenu.tsx:158. Stripping it on web_search toggle-off would
      // silently downgrade the chat paperclip menu to "Upload Image" only.
      setValue('model_parameters', cleaned as unknown as AgentForm['model_parameters'], {
        shouldDirty: true,
      });
    }
  },
};

/**
 * "Build visuals & documents" — KK20-243. Artifacts render in the live preview
 * panel: React components, charts, dashboards, slide decks, branded reports,
 * Mermaid diagrams, SVG.
 *
 * Unlike the other capabilities here, the persisted field is a STRING, not a
 * boolean — `ArtifactModes.DEFAULT` / `SHADCNUI` / `CUSTOM`, or `''` for off
 * (see `packages/data-provider/src/artifacts.ts`). The server treats any
 * non-empty string as on and appends the artifacts prompt
 * (`packages/api/src/agents/initialize.ts`). We deliberately write only
 * `DEFAULT`: `SHADCNUI` stacks a second, larger prompt on every turn for a
 * component library the simplified builder does not otherwise surface.
 */
const buildVisuals: KnaufCapability = {
  id: 'artifacts',
  label: 'Build visuals & documents',
  description: 'Create charts, dashboards, slide decks and branded reports in a live preview.',
  labelKey: 'com_knauf_capability_artifacts_label',
  descriptionKey: 'com_knauf_capability_artifacts_description',
  icon: LayoutTemplate,
  watchFields: [AgentCapabilities.artifacts],
  isEnabled: (enabled) => enabled.includes(AgentCapabilities.artifacts),
  readFromForm: ({ getValues }) => !!getValues(AgentCapabilities.artifacts as keyof AgentForm),
  applyToForm: (next, { setValue }) => {
    setValue(
      AgentCapabilities.artifacts as keyof AgentForm,
      (next ? ArtifactModes.DEFAULT : '') as never,
      { shouldDirty: true },
    );
  },
};

/**
 * "Use Knauf skills" — KK20-243. Deployment skills are loaded read-only from
 * `skill/<name>/SKILL.md` at boot and carry the Knauf brand tokens plus the
 * artifact templates (`skill/karl-brand`, `skill/karl-artifacts`).
 *
 * `skills_enabled` is the master toggle and is strict opt-in server-side —
 * `isAgentSkillsEnabledForRun` (api/server/services/Endpoints/agents/
 * skillDeps.js) requires it to be exactly `true` on a persisted agent. The
 * sibling `skills` field is an optional id allowlist; we leave it undefined so
 * an enabled agent sees the full catalog, which is what the simplified builder
 * wants (there is no per-skill picker in this panel).
 */
const useKnaufSkills: KnaufCapability = {
  id: 'skills',
  label: 'Use Knauf skills',
  description: 'Apply Knauf brand guidance and ready-made templates when a task calls for them.',
  labelKey: 'com_knauf_capability_skills_label',
  descriptionKey: 'com_knauf_capability_skills_description',
  icon: ScrollText,
  watchFields: ['skills_enabled'],
  isEnabled: (enabled) => enabled.includes(AgentCapabilities.skills),
  readFromForm: ({ getValues }) => !!getValues('skills_enabled'),
  applyToForm: (next, { setValue }) => {
    setValue('skills_enabled', next, { shouldDirty: true });
  },
};

/**
 * "Analyse data" — KK20-257. Runs Python and Bash in an Azure Container Apps
 * dynamic session via the Knauf code-adapter: pandas, charts, spreadsheet
 * read/write, and files delivered back to the user as real downloads.
 *
 * Gated on `execute_code` being in `endpoints.agents.capabilities`, so the row
 * disappears wherever the sandbox is not available — including when the
 * fail-closed guard strips the capability because `LIBRECHAT_CODE_BASEURL` is
 * unset (packages/api/src/knauf/code/codeEnvGuard.ts). That is deliberate: an
 * agent author should never be able to switch on a tool that cannot run.
 *
 * A plain boolean form flag, unlike `artifacts` (a string mode). Turning it on
 * puts `execute_code` in the persisted agent's tools, which is what
 * `codeAllowedByAgent` reads on the chat side to decide whether a tabular
 * attachment may be routed to the sandbox.
 *
 * Note the asymmetry worth knowing when reviewing a shared agent: agent auto-run
 * is not gated by the RUN_CODE permission (KARL keeps that off to suppress the
 * composer chip and the manual Run button), so an agent with this enabled runs
 * code for whoever uses it.
 */
const analyseData: KnaufCapability = {
  id: 'code',
  label: 'Analyse data',
  description: 'Run calculations on spreadsheets and data files, and build charts from them.',
  labelKey: 'com_knauf_capability_code_label',
  descriptionKey: 'com_knauf_capability_code_description',
  icon: LineChart,
  watchFields: [AgentCapabilities.execute_code],
  isEnabled: (enabled) => enabled.includes(AgentCapabilities.execute_code),
  readFromForm: ({ getValues }) => !!getValues(AgentCapabilities.execute_code as keyof AgentForm),
  applyToForm: (next, { setValue }) => {
    setValue(AgentCapabilities.execute_code as keyof AgentForm, next as never, {
      shouldDirty: true,
    });
  },
};

/**
 * Registry. Order here is render order in the V6 panel. New capabilities
 * append to this list; if the new capability needs `endpoints.agents.
 * capabilities` to include a flag (e.g. `execute_code`), wire that into
 * `isEnabled` — see `analyseData` above, which is the worked example the
 * template comment here used to describe.
 */
export const KNAUF_CAPABILITIES: ReadonlyArray<KnaufCapability> = [
  browseInternet,
  buildVisuals,
  analyseData,
  useKnaufSkills,
];

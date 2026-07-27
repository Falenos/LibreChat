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
import { Globe, LayoutTemplate, ScrollText } from 'lucide-react';
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
  /** User-facing label shown in the row header. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /** Lucide icon component. */
  icon: ComponentType<LucideProps>;
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
  icon: LayoutTemplate,
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
  icon: ScrollText,
  isEnabled: (enabled) => enabled.includes(AgentCapabilities.skills),
  readFromForm: ({ getValues }) => !!getValues('skills_enabled'),
  applyToForm: (next, { setValue }) => {
    setValue('skills_enabled', next, { shouldDirty: true });
  },
};

/**
 * Registry. Order here is render order in the V6 panel. New capabilities
 * append to this list; if the new capability needs `endpoints.agents.
 * capabilities` to include a flag (e.g. `execute_code`), wire that into
 * `isEnabled`.
 *
 * Example for a future capability (not yet implemented — left here as a
 * template). Note the boolean shape: unlike `artifacts`, `execute_code` is a
 * plain boolean form flag.
 *
 *   const analyzeData: KnaufCapability = {
 *     id: 'analyze',
 *     label: 'Analyze data, charts & diagrams',
 *     description: 'Turn numbers and files into visuals and insights.',
 *     icon: Layers,
 *     isEnabled: (enabled) => enabled.includes(AgentCapabilities.execute_code),
 *     readFromForm: ({ getValues }) => !!getValues(AgentCapabilities.execute_code),
 *     applyToForm: (next, { setValue }) =>
 *       setValue(AgentCapabilities.execute_code, next),
 *   };
 */
export const KNAUF_CAPABILITIES: ReadonlyArray<KnaufCapability> = [
  browseInternet,
  buildVisuals,
  useKnaufSkills,
];

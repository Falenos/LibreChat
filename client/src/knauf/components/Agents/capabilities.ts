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
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { Globe } from 'lucide-react';
import {
  AgentCapabilities,
  type AgentCapabilities as AgentCapabilitiesEnum,
} from 'librechat-data-provider';
import type { UseFormGetValues, UseFormSetValue } from 'react-hook-form';
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
 * "Browse the internet" — KK20-194. One switch, two complementary engines,
 * no third-party search provider (GDPR):
 *   1. Azure-native, model-level web_search — activated at chat time via the
 *      Responses API by setting `model_parameters.web_search` (open-ended
 *      discovery + the fallback when open_url fails).
 *   2. `open_url` — our authoritative reader for a user-named/pasted page,
 *      surfaced server-side (ToolService.js) whenever this switch puts
 *      `Tools.web_search` into the agent's tools (the "raw browse intent").
 * NOT gated by `endpoints.agents.capabilities`: we deliberately keep
 * `web_search` out of that list so the provider-less LangChain web_search
 * tool stays stripped/unsurfaced. The switch therefore writes BOTH the
 * `web_search` form flag (→ raw browse intent → open_url) AND
 * `model_parameters.web_search` (→ Azure-native search). Default-ON for KARL
 * (librechat.yaml modelSpecs) and new agents (getDefaultAgentFormValues).
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
 * Registry. Order here is render order in the V6 panel. New capabilities
 * append to this list; if the new capability needs `endpoints.agents.
 * capabilities` to include a flag (e.g. `execute_code`), wire that into
 * `isEnabled`.
 *
 * Examples for future capabilities (not yet implemented — left here as
 * templates):
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
export const KNAUF_CAPABILITIES: ReadonlyArray<KnaufCapability> = [browseInternet];

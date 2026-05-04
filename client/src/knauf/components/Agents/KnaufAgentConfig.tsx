/**
 * Knauf V6 agent-builder body. Replaces upstream's `AgentConfig` via a
 * single `[knauf]` import-line swap in
 * client/src/components/SidePanel/Agents/AgentPanel.tsx.
 *
 * Renders inside upstream's `<FormProvider>` and `<form>` shell — so:
 *   • AgentSelect (top of upstream's AgentPanel) loads/switches agents
 *   • AgentFooter (bottom) handles Save / Delete / Cancel
 *   • VersionPanel mounts via AgentPanelSwitch
 *   • AgentAvatar (upstream) handles real avatar upload
 *   • KnaufFileSearch (Tier 5 fork of upstream FileSearch) handles
 *     knowledge file upload + listing inside the Data Knowledge section
 *
 * Knauf overlay renders the V6-shaped middle of the form, in order:
 *   avatar, name, description, Category (upstream selector), Personality
 *   pills, "What it can do" capability rows (registry), Data Knowledge
 *   (KnaufFileSearch — file presence drives `file_search` automatically),
 *   MCP servers (when configured), Tools, Instructions (with Variables
 *   popover + ✦ Autogenerate).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToastContext } from '@librechat/client';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { EModelEndpoint } from 'librechat-data-provider';
import { isEphemeralAgent, type AgentForm } from '~/common';
import { useAgentPanelContext, useFileMapContext } from '~/Providers';
import {
  cn,
  defaultTextProps,
  processAgentOption,
  removeFocusOutlines,
} from '~/utils';
import AgentAvatar from '~/components/SidePanel/Agents/AgentAvatar';
import AgentCategorySelector from '~/components/SidePanel/Agents/AgentCategorySelector';
import AgentTool from '~/components/SidePanel/Agents/AgentTool';
import MCPTools from '~/components/SidePanel/Agents/MCPTools';
import { ToolSelectDialog, MCPToolSelectDialog } from '~/components/Tools';
import { useGetAgentFiles } from '~/data-provider';
import { useAgentCategories, useLocalize, useVisibleTools } from '~/hooks';
import AutoGenerateButton from './AutoGenerateButton';
import CapabilitySwitch from './CapabilitySwitch';
import KnaufFileSearch from './KnaufFileSearch';
import KnaufInfoBadge from './KnaufInfoBadge';
import KnaufSection from './KnaufSection';
import PersonalityPills from './PersonalityPills';
import VariablesPopover from './VariablesPopover';
import { KNAUF_CAPABILITIES } from './capabilities';
import { KARL_DEFAULT_PERSONALITY_NAME } from '~/knauf/common/constants';
import { useAutogeneratePrompt } from '~/knauf/data-provider/Agents/useAutogeneratePrompt';
import {
  usePersonalities,
  type KnaufPersonality,
} from '~/knauf/data-provider/Agents/usePersonalities';

const labelClass = 'mb-2 text-token-text-primary block text-sm font-medium';
const inputClass = cn(
  defaultTextProps,
  'flex w-full px-3 py-2 border-border-light bg-surface-secondary focus-visible:ring-2 focus-visible:ring-ring-primary',
  removeFocusOutlines,
);

const NON_PARAMETER_PRESET_KEYS = new Set([
  'endpoint',
  'model',
  'promptPrefix',
  'additional_instructions',
  'greeting',
  'iconURL',
]);

/**
 * Translate a Knauf personality preset into the AgentForm-shape values
 * the rest of the app expects:
 *   - top-level `model`
 *   - `model_parameters` (everything else from preset, minus the keys
 *     above)
 * Returns the values for setValue calls.
 */
function presetToFormValues(personality: KnaufPersonality | undefined) {
  if (!personality) return null;
  const { preset } = personality;
  const model = typeof preset.model === 'string' ? preset.model : null;
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(preset)) {
    if (!NON_PARAMETER_PRESET_KEYS.has(k) && v !== undefined) {
      params[k] = v;
    }
  }
  return { model, params };
}

export default function KnaufAgentConfig() {
  const localize = useLocalize();
  const fileMap = useFileMapContext();
  const { showToast } = useToastContext();
  const personalities = usePersonalities();
  const { categories } = useAgentCategories();
  const autogenerate = useAutogeneratePrompt();
  // YAML-gated capabilities — `endpoints.agents.capabilities` from
  // librechat.yaml. Each capability in the registry decides via its
  // `isEnabled` whether to render given this list.
  const {
    agentsConfig,
    regularTools,
    availableMCPServers,
    mcpServersMap,
  } = useAgentPanelContext();
  const enabledCapabilities = useMemo(
    () => (agentsConfig?.capabilities ?? []) as ReadonlyArray<string>,
    [agentsConfig?.capabilities],
  );
  const toolsEnabled = enabledCapabilities.includes('tools');
  const [showToolDialog, setShowToolDialog] = useState(false);
  const [showMCPToolDialog, setShowMCPToolDialog] = useState(false);
  const visibleCapabilities = useMemo(
    () => KNAUF_CAPABILITIES.filter((cap) => cap.isEnabled(enabledCapabilities)),
    [enabledCapabilities],
  );
  // Mutable ref so we can both forward to react-hook-form AND read in the
  // variable-popover insert handler. Plain `useRef<HTMLTextAreaElement>(null)`
  // would be a readonly RefObject — pinning the union explicitly gives us a
  // writable MutableRefObject.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { control, setValue, getValues } = useFormContext<AgentForm>();
  const agent = useWatch({ control, name: 'agent' });
  const agent_id = useWatch({ control, name: 'id' });
  const model = useWatch({ control, name: 'model' });
  const instructions = useWatch({ control, name: 'instructions' });
  const tools = useWatch({ control, name: 'tools' });
  const { toolIds, mcpServerNames } = useVisibleTools(
    tools,
    regularTools,
    mcpServersMap,
  );

  const { data: agentFiles = [] } = useGetAgentFiles(agent_id);

  const mergedFileMap = useMemo(() => {
    const next = { ...fileMap };
    for (const f of agentFiles) {
      if (f.file_id) next[f.file_id] = f;
    }
    return next;
  }, [fileMap, agentFiles]);

  const knowledge_files = useMemo(() => {
    if (typeof agent === 'string' || agent?.id !== agent_id) return [];
    if (agent?.knowledge_files) return agent.knowledge_files;
    const processed = agent
      ? processAgentOption({ agent, fileMap: mergedFileMap })
      : null;
    return processed?.knowledge_files ?? [];
  }, [agent, agent_id, mergedFileMap]);

  // Continuously mirror `file_search` to whether the agent has any
  // knowledge files attached. No user-facing toggle — file presence is the
  // signal. Adding the first file flips file_search on; removing the last
  // file flips it off, keeping the saved tools array honest.
  //
  // shouldDirty: false intentionally. The Save button isn't gated on form
  // dirty state (AgentFooter.tsx submits unconditionally on click), so we
  // don't need to fake-dirty the form to make Save work — and we
  // specifically *don't* want to: opening a legacy agent that needs the
  // fix-up would otherwise show the form as having unsaved changes the
  // user never made.
  useEffect(() => {
    if (!agent_id || isEphemeralAgent(agent_id)) return;
    const shouldEnable = knowledge_files.length > 0;
    if (getValues('file_search') === shouldEnable) return;
    setValue('file_search', shouldEnable as never, { shouldDirty: false });
  }, [agent_id, knowledge_files.length, getValues, setValue]);

  // ── Personality (UI-only field; derived/applied to model + parameters) ────
  // Default selection: the conventional balanced personality if available,
  // else the first.
  const defaultPersonalityName = useMemo(() => {
    if (personalities.length === 0) return '';
    return (
      personalities.find((p) => p.name === KARL_DEFAULT_PERSONALITY_NAME)?.name ??
      personalities[0].name
    );
  }, [personalities]);

  // Try to derive the selected personality from the form's current model
  // — only on first load with a non-empty model. Otherwise default.
  const initialPersonality = useMemo(() => {
    if (personalities.length === 0) return '';
    if (!model) return defaultPersonalityName;
    const match = personalities.find(
      (p) => typeof p.preset.model === 'string' && p.preset.model === model,
    );
    return (match ?? personalities[0]).name;
  }, [personalities, model, defaultPersonalityName]);

  const [personality, setPersonality] = useState<string>('');

  // First-time hydration: once personalities resolve, pick a sensible default.
  useEffect(() => {
    if (!personality && initialPersonality) {
      setPersonality(initialPersonality);
    }
  }, [personality, initialPersonality]);

  // Apply the selected personality's preset to the form (model + parameters).
  useEffect(() => {
    if (!personality) return;
    const picked = personalities.find((p) => p.name === personality);
    const next = presetToFormValues(picked);
    if (!next) return;

    if (next.model && next.model !== getValues('model')) {
      setValue('model', next.model, { shouldDirty: true });
      setValue('provider', 'azureOpenAI', { shouldDirty: true });
    }

    // Merge personality params into existing model_parameters, preserving
    // any web_search / useResponsesApi the user toggled separately. Cast
    // through unknown — AgentModelParameters' TS shape doesn't list every
    // model-level key Azure accepts (e.g. reasoning_effort, web_search),
    // but the runtime field is permissive.
    const current = (getValues('model_parameters') ?? {}) as Record<
      string,
      unknown
    >;
    const merged = { ...current, ...next.params };
    setValue(
      'model_parameters',
      merged as unknown as AgentForm['model_parameters'],
      { shouldDirty: true },
    );
  }, [personality, personalities, setValue, getValues]);

  // ── Instructions: Variables popover + ✦ Autogenerate ──────────────────────
  const insertVariable = (token: string) => {
    const ta = textareaRef.current;
    const current = getValues('instructions') ?? '';
    if (!ta) {
      setValue('instructions', current + token, { shouldDirty: true });
      return;
    }
    const start = ta.selectionStart ?? current.length;
    const end = ta.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    setValue('instructions', next, { shouldDirty: true });
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const onAutogenerate = () => {
    const picked = personalities.find((p) => p.name === personality);
    // Build capability labels from the visible registry entries that are
    // currently on. Knowledge isn't part of the registry (it lives in
    // upstream FileSearch), so it's appended below.
    const capabilityLabels: string[] = visibleCapabilities
      .filter((cap) => cap.readFromForm({ getValues, setValue }))
      .map((cap) => cap.label);
    if (knowledge_files.length > 0) {
      capabilityLabels.push(
        `Knowledge base (${knowledge_files.length} attached document${knowledge_files.length === 1 ? '' : 's'})`,
      );
    }
    // Tool display names — `regularTools[].name` is human-readable; fall
    // back to `pluginKey` if name is missing. (`id` is always non-empty,
    // so the result is always populated when `toolIds` is.)
    const toolNames = toolIds.map((id) => {
      const t = regularTools?.find((rt) => rt.pluginKey === id);
      return t?.name ?? id;
    });
    const categoryValue = getValues('category') ?? '';
    const categoryLabel =
      categories.find((c) => c.value === categoryValue)?.label ?? categoryValue;
    autogenerate.mutate(
      {
        agent: {
          name: getValues('name') ?? '',
          description: getValues('description') ?? '',
          category: categoryLabel,
          personality: {
            label: picked?.label ?? '',
            description: picked?.description ?? '',
          },
          capabilities: capabilityLabels,
          knowledgeFileCount: knowledge_files.length,
          tools: toolNames,
          mcpServers: mcpServerNames ?? [],
        },
        currentDraft: getValues('instructions') ?? '',
      },
      {
        onSuccess: ({ text }) =>
          setValue('instructions', text, { shouldDirty: true }),
        onError: (err) =>
          showToast({
            status: 'error',
            message: err?.message ?? 'Couldn’t draft instructions.',
          }),
      },
    );
  };

  // Default category to 'general' on first mount when unset. The
  // `<AgentCategorySelector />` then lets the user change it. We previously
  // hard-pinned to 'general' because the marketplace was hidden — the
  // selector was wired back in, so this just provides a sensible default
  // for new agents and stays out of the way otherwise.
  useEffect(() => {
    if (!getValues('category')) {
      setValue('category', 'general', { shouldDirty: false });
    }
  }, [getValues, setValue]);

  return (
    <>
    <div className="h-auto pt-1">
      {/* Avatar (upstream — handles real upload) */}
      <div className="mb-6">
        <AgentAvatar avatar={typeof agent === 'string' ? null : agent?.avatar ?? null} />
        <label className={labelClass} htmlFor="knauf-agent-name">
          {localize('com_ui_name')}
          <span className="text-red-500"> *</span>
        </label>
        <Controller
          name="name"
          control={control}
          rules={{ required: localize('com_ui_agent_name_is_required') }}
          render={({ field, fieldState: { error } }) => (
            <>
              <input
                {...field}
                value={field.value ?? ''}
                maxLength={256}
                className={inputClass}
                id="knauf-agent-name"
                type="text"
                placeholder={localize('com_agents_name_placeholder')}
                aria-label="Agent name"
              />
              {error ? (
                <div className="mt-1 text-sm text-red-500" role="alert">
                  {error.message}
                </div>
              ) : null}
            </>
          )}
        />
      </div>

      {/* Description */}
      <div className="mb-6">
        <label className={labelClass} htmlFor="knauf-agent-desc">
          {localize('com_ui_description')}
        </label>
        <Controller
          name="description"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              value={field.value ?? ''}
              maxLength={512}
              className={inputClass}
              id="knauf-agent-desc"
              type="text"
              placeholder={localize('com_agents_description_placeholder')}
              aria-label="Agent description"
            />
          )}
        />
      </div>

      {/* Category — same upstream component as the native builder, drives
          the agent's `category` field. Marketplace stays hidden, but
          categorisation is still useful for sorting / filtering in the
          agent list once that comes online. */}
      <KnaufSection
        title={localize('com_ui_category')}
        info="Helps you find this agent later by topic. Pick the bucket that fits best, or leave it on General."
      >
        <AgentCategorySelector />
      </KnaufSection>

      {/* Personality */}
      <KnaufSection
        title="Personality"
        info="Sets the agent's tone. Precise sticks to the facts, Balanced is the everyday default, Creative is more open-ended."
      >
        <PersonalityPills
          personalities={personalities}
          value={personality}
          onChange={setPersonality}
        />
      </KnaufSection>

      {/* What it can do — capability rows are sourced from the registry
          (capabilities.ts) and filtered by `endpoints.agents.capabilities`
          in librechat.yaml. Adding a row is one entry in capabilities.ts. */}
      {visibleCapabilities.length > 0 ? (
        <KnaufSection
          title="What it can do"
          info="Extra abilities the agent can use while replying, like searching the web for fresh information. Toggle each one on or off."
        >
          <div className="flex flex-col gap-2">
            {visibleCapabilities.map((cap) => (
              <CapabilityRow key={cap.id} capability={cap} />
            ))}
          </div>
        </KnaufSection>
      ) : null}

      {/* Data Knowledge — file presence drives `file_search` automatically
          (see the sync effect above). KnaufFileSearch is a Tier 5 fork of
          upstream FileSearch that omits the inner heading + checkbox. */}
      <KnaufSection
        title="Data Knowledge"
        info="Documents the agent can read to answer questions. Upload files here. Search turns on automatically once you add the first one, and off again when you remove the last."
      >
        <KnaufFileSearch agent_id={agent_id} files={knowledge_files} />
      </KnaufSection>

      {/* MCP servers — only renders when at least one MCP server is
          configured in librechat.yaml. Reuses upstream MCPTools list +
          MCPToolSelectDialog so we inherit any future MCP UX changes. */}
      {availableMCPServers != null && availableMCPServers.length > 0 ? (
        <KnaufSection
          title="MCP servers"
          info="Connect this agent to extra services that give it access to tools or data outside the chat. Pick the ones you want it to use."
        >
          <MCPTools
            agentId={agent_id}
            mcpServerNames={mcpServerNames}
            setShowMCPToolDialog={setShowMCPToolDialog}
          />
          <button
            type="button"
            onClick={() => setShowMCPToolDialog(true)}
            className="btn btn-neutral border-token-border-light relative h-9 w-full rounded-lg font-medium"
            aria-haspopup="dialog"
          >
            <div className="flex w-full items-center justify-center gap-2">
              {localize('com_ui_add_mcp_server')}
            </div>
          </button>
        </KnaufSection>
      ) : null}

      {/* Tools — picks from the curated tools registered for the agents
          endpoint. Gated by `endpoints.agents.capabilities` containing
          `tools` in librechat.yaml. Actions are intentionally not
          surfaced here (see the comment in librechat.yaml). */}
      {toolsEnabled ? (
        <KnaufSection
          title="Tools"
          info="Things the agent can do while replying, like creating an image or running a calculation. Pick the ones you want it to be able to use."
        >
          {regularTools === undefined ? (
            <div className="text-xs text-text-secondary">Loading tools…</div>
          ) : (
            <>
              <div className="mb-1">
                {toolIds.map((toolId, i) => {
                  const tool = regularTools.find((t) => t.pluginKey === toolId);
                  if (!tool) return null;
                  return (
                    <AgentTool
                      key={`${toolId}-${i}-${agent_id}`}
                      tool={toolId}
                      regularTools={regularTools}
                      agent_id={agent_id}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setShowToolDialog(true)}
                className="btn btn-neutral border-token-border-light relative h-9 w-full rounded-lg font-medium"
                aria-haspopup="dialog"
              >
                <div className="flex w-full items-center justify-center gap-2">
                  {localize('com_assistants_add_tools')}
                </div>
              </button>
            </>
          )}
        </KnaufSection>
      ) : null}

      {/* Instructions */}
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <label
            htmlFor="knauf-agent-instructions"
            className={cn(labelClass, 'mb-0 inline-flex min-w-0 flex-grow items-center gap-1.5')}
          >
            <span className="truncate">{localize('com_ui_instructions')}</span>
            <KnaufInfoBadge tip="Tell the agent what to do, who it is, and how to behave. You can write this yourself, or click Generate to have AI draft it. Once you have something written the button changes to Polish, so AI can tighten it up." />
          </label>
          <AutoGenerateButton
            hasDraft={(instructions ?? '').trim().length > 0}
            drafting={autogenerate.isLoading}
            onClick={onAutogenerate}
          />
          <VariablesPopover onPick={insertVariable} />
        </div>
        <Controller
          name="instructions"
          control={control}
          render={({ field }) => (
            <textarea
              {...field}
              value={field.value ?? ''}
              ref={(el) => {
                field.ref(el);
                textareaRef.current = el;
              }}
              rows={6}
              placeholder="What should this agent do? Describe its role, voice, and any guardrails."
              className={cn(inputClass, 'min-h-[140px] resize-y leading-relaxed')}
              aria-label="Agent instructions"
            />
          )}
        />
        <div className="mt-1 flex items-center justify-end text-xs text-text-tertiary">
          <span>{(instructions ?? '').length} characters</span>
        </div>
      </div>

      {/* Model parameters are managed by personality + capability toggles.
          We never render the model picker; values flow into the form via
          setValue calls above. */}
    </div>
    {toolsEnabled && (
      <ToolSelectDialog
        isOpen={showToolDialog}
        setIsOpen={setShowToolDialog}
        endpoint={EModelEndpoint.agents}
      />
    )}
    {availableMCPServers != null && availableMCPServers.length > 0 && (
      <MCPToolSelectDialog
        agentId={agent_id}
        isOpen={showMCPToolDialog}
        mcpServerNames={mcpServerNames}
        setIsOpen={setShowMCPToolDialog}
        endpoint={EModelEndpoint.agents}
      />
    )}
    </>
  );
}

/**
 * One row from the capability registry. Reads the capability's on/off
 * state from the form and re-renders when it changes (via useWatch on
 * model_parameters — the canonical hook into form reactivity for our
 * capability writes).
 */
function CapabilityRow({
  capability,
}: Readonly<{
  capability: (typeof KNAUF_CAPABILITIES)[number];
}>) {
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  // Subscribe to the form fields the registry might inspect, so this row
  // re-renders when the underlying state changes.
  useWatch({ control, name: 'model_parameters' });
  const checked = capability.readFromForm({ getValues, setValue });

  return (
    <CapabilitySwitch
      icon={capability.icon}
      label={capability.label}
      description={capability.description}
      checked={checked}
      onChange={(next) => capability.applyToForm(next, { getValues, setValue })}
    />
  );
}

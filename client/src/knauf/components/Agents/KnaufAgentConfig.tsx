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
 *   • KnaufFileSearch (fork of upstream FileSearch) handles
 *     knowledge file upload + listing inside the Data Knowledge section
 *
 * Knauf overlay renders the V6-shaped middle of the form, in order:
 *   avatar, name, description, Category (upstream selector), Personality
 *   pills, "What it can do" capability rows (registry), Data Knowledge
 *   (KnaufFileSearch — file presence drives `file_search` automatically),
 *   MCP servers (when configured), Tools, Instructions (with Variables
 *   popover + ✦ Autogenerate).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { EModelEndpoint } from 'librechat-data-provider';
import { isEphemeralAgent, type AgentForm } from '~/common';
import { useAgentPanelContext, useFileMapContext } from '~/Providers';
import { cn, defaultTextProps, processAgentOption, removeFocusOutlines } from '~/utils';
import AgentAvatar from '~/components/SidePanel/Agents/AgentAvatar';
import AgentCategorySelector from '~/components/SidePanel/Agents/AgentCategorySelector';
import AgentTool from '~/components/SidePanel/Agents/AgentTool';
import { ToolSelectDialog, MCPToolSelectDialog } from '~/components/Tools';
import KnaufMCPTools from './KnaufMCPTools';
import { useGetAgentFiles } from '~/data-provider';
import { useAgentCategories, useLocalize, useVisibleTools } from '~/hooks';
import * as HoverCard from '@radix-ui/react-hover-card';
import { Switch } from '@librechat/client';
import { Brain, Check, Copy, Zap } from 'lucide-react';
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
  const { agentsConfig, regularTools, availableMCPServers, mcpServersMap } = useAgentPanelContext();
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
  const instructions = useWatch({ control, name: 'instructions' });
  const tools = useWatch({ control, name: 'tools' });
  const { toolIds, mcpServerNames } = useVisibleTools(tools, regularTools, mcpServersMap);

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
    const processed = agent ? processAgentOption({ agent, fileMap: mergedFileMap }) : null;
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

  // ── Personality ───────────────────────────────────────────────────────────
  // Single source of truth: the form's `spec` field (hydrated by
  // AgentSelect.resetAgentForm from `agent.spec`, persisted on save via
  // composeAgentUpdatePayload).
  //
  // We do NOT derive personality from `model` — all three Karl personalities
  // share the same Azure deployment (gpt-5.4 in librechat.yaml), so a
  // model-based lookup always returns the first match (Precise). For any
  // agent without an explicit stored spec, fall back to Balanced visually
  // and only commit when the user actually clicks a pill.
  const defaultPersonalityName = useMemo(() => {
    if (personalities.length === 0) return '';
    return (
      personalities.find((p) => p.name === KARL_DEFAULT_PERSONALITY_NAME)?.name ??
      personalities[0].name
    );
  }, [personalities]);

  const storedPersonality = useWatch({ control, name: 'spec' }) ?? '';

  const personality =
    storedPersonality && personalities.some((p) => p.name === storedPersonality)
      ? storedPersonality
      : defaultPersonalityName;

  const applyPersonality = useCallback(
    (name: string, opts: { shouldDirty: boolean }) => {
      const picked = personalities.find((p) => p.name === name);
      const next = presetToFormValues(picked);
      if (!next) return;
      setValue('spec', name, { shouldDirty: opts.shouldDirty });
      if (next.model && next.model !== getValues('model')) {
        setValue('model', next.model, { shouldDirty: opts.shouldDirty });
        setValue('provider', 'azureOpenAI', { shouldDirty: opts.shouldDirty });
      }
      // Merge personality params into existing model_parameters, preserving
      // any web_search / useResponsesApi the user toggled separately. Cast
      // through unknown — AgentModelParameters' TS shape doesn't list every
      // model-level key Azure accepts (e.g. reasoning_effort, web_search),
      // but the runtime field is permissive.
      const current = (getValues('model_parameters') ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...next.params };
      setValue('model_parameters', merged as unknown as AgentForm['model_parameters'], {
        shouldDirty: opts.shouldDirty,
      });
    },
    [personalities, setValue, getValues],
  );

  // Auto-apply the default personality's preset (model + params) ONLY for
  // ephemeral drafts (new agents not yet saved). This guarantees a newly
  // created agent gets a system prompt + reasoning settings without forcing
  // the user to click a pill. We deliberately skip this for saved agents
  // without a stored spec — applying the preset there would clobber any
  // custom `promptPrefix` the user had set on the agent. Self-throttles via
  // storedPersonality: once spec is populated, the effect short-circuits.
  useEffect(() => {
    if (!isEphemeralAgent(agent_id)) return;
    if (storedPersonality) return;
    if (!defaultPersonalityName) return;
    applyPersonality(defaultPersonalityName, { shouldDirty: false });
  }, [agent_id, storedPersonality, defaultPersonalityName, applyPersonality]);

  const handlePersonalityChange = (name: string) => {
    // Always re-apply the preset, even if `spec` already matches — this
    // ensures legacy agents (where spec was never persisted) and freshly
    // hydrated drafts both end up with the correct model_parameters when
    // the user explicitly picks a pill. Mark dirty so the save round-trips.
    applyPersonality(name, { shouldDirty: true });
  };

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
    const categoryLabel = categories.find((c) => c.value === categoryValue)?.label ?? categoryValue;
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
        onSuccess: ({ text }) => setValue('instructions', text, { shouldDirty: true }),
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
          <AgentAvatar avatar={typeof agent === 'string' ? null : (agent?.avatar ?? null)} />
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
          {agent_id && !isEphemeralAgent(agent_id) ? <KnaufAgentIdRow agentId={agent_id} /> : null}
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

        {/* Personality — pills control tone + implicit reasoning depth
          (Precise=high, Balanced=medium, Creative=low). Fast Mode is the
          slim toggle in the section header that skips reasoning entirely
          (the cost-ceiling fourth option). Both write into model_parameters;
          the server reads them in packages/api/src/agents/run.ts. (KK20-128) */}
        <KnaufSection
          title="Personality"
          info="Sets tone and reasoning depth. Precise/Balanced/Creative control how the agent writes; the Fast Mode toggle on the right skips reasoning entirely for quicker, cheaper answers."
          action={<PersonalityHeaderToggles />}
        >
          <PersonalityPills
            personalities={personalities}
            value={personality}
            onChange={handlePersonalityChange}
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
          (see the sync effect above). KnaufFileSearch is a fork of
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
            <KnaufMCPTools agentId={agent_id} mcpServerNames={mcpServerNames} />
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
              <div className="text-xs text-text-secondary">{localize('com_ui_loading')}</div>
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
            <span>
              {(instructions ?? '').length}
              {' characters'}
            </span>
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

/**
 * Slim header toggle for a `model_parameters` boolean flag. Lives in the
 * KnaufSection `action` slot: no row, no border, no visible label — just an
 * icon + Switch with a HoverCard tooltip carrying the label + description.
 * Both Fast Mode and Show reasoning render through this. (KK20-128)
 */
function ReasoningHeaderToggle({
  flag,
  icon: Icon,
  label,
  description,
  disabled,
}: Readonly<{
  flag: 'knauf_fast_mode' | 'knauf_show_reasoning';
  icon: ComponentType<LucideProps>;
  label: string;
  description: string;
  disabled?: boolean;
}>) {
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const params = useWatch({ control, name: 'model_parameters' }) as
    | Record<string, unknown>
    | undefined;
  const checked = params?.[flag] === true;
  return (
    <HoverCard.Root openDelay={120} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <span
          className={cn('inline-flex items-center gap-1.5', disabled ? 'opacity-60' : undefined)}
        >
          <Icon
            size={14}
            className={cn(
              'transition-colors',
              checked ? 'text-text-primary' : 'text-text-secondary',
            )}
            aria-hidden
          />
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={(next) => {
              const current = (getValues('model_parameters') ?? {}) as Record<string, unknown>;
              setValue(
                'model_parameters',
                { ...current, [flag]: !!next } as unknown as AgentForm['model_parameters'],
                { shouldDirty: true },
              );
            }}
            aria-label={label}
          />
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          sideOffset={6}
          align="end"
          collisionPadding={8}
          className="z-[1100] max-w-[260px] rounded-md border border-border-light bg-surface-primary px-3 py-2 text-xs leading-snug text-text-secondary shadow-lg"
        >
          <div className="mb-0.5 text-sm font-medium text-text-primary">{label}</div>
          {description}
          <HoverCard.Arrow className="fill-border-light" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/**
 * Two slim header toggles for the Personality section: Fast Mode (⚡) and
 * Show reasoning steps (🧠). Show reasoning is disabled whenever Fast Mode
 * is on, since Fast Mode strips reasoning server-side regardless.
 */
function PersonalityHeaderToggles() {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const params = useWatch({ control, name: 'model_parameters' }) as
    | Record<string, unknown>
    | undefined;
  const fastMode = params?.knauf_fast_mode === true;
  return (
    <>
      <ReasoningHeaderToggle
        flag="knauf_fast_mode"
        icon={Zap}
        label={localize('com_knauf_fast_mode_label')}
        description={localize('com_knauf_fast_mode_description')}
      />
      <ReasoningHeaderToggle
        flag="knauf_show_reasoning"
        icon={Brain}
        label={localize('com_knauf_show_reasoning_label')}
        description={localize('com_knauf_show_reasoning_description')}
        disabled={fastMode}
      />
    </>
  );
}

/**
 * Small read-only display of the agent's id beneath the Name field, with a
 * click-to-copy button. Lets admins copy the id into librechat.yaml's
 * `interface.knauf.defaultAgentId`. Only renders for saved (non-ephemeral)
 * agents. (KK20-128)
 */
function KnaufAgentIdRow({ agentId }: Readonly<{ agentId: string }>) {
  const localize = useLocalize();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current != null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  const onCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(agentId).then(
      () => {
        if (timeoutRef.current != null) {
          clearTimeout(timeoutRef.current);
        }
        setCopied(true);
        timeoutRef.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, [agentId]);
  const buttonTitle = copied ? localize('com_ui_copied') : localize('com_knauf_copy_agent_id');
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
      <span className="font-medium">{localize('com_knauf_agent_id')}:</span>
      <code className="truncate font-mono text-[11px]">{agentId}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={buttonTitle}
        title={buttonTitle}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition hover:bg-surface-tertiary hover:text-text-primary"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

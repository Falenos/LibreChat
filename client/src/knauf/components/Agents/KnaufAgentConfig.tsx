/**
 * Knauf V6 agent-builder body. Replaces upstream's `AgentConfig` via a
 * `[knauf]` import swap in AgentPanel.tsx. Renders inside upstream's
 * FormProvider/form shell alongside AgentSelect, AgentFooter, and VersionPanel.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Brain, Zap } from 'lucide-react';
import * as HoverCard from '@radix-ui/react-hover-card';
import { EModelEndpoint } from 'librechat-data-provider';
import { Switch, useToastContext } from '@librechat/client';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import type { LucideProps } from 'lucide-react';
import type { PromptTemplate } from '~/knauf/data-provider/data-service';
import {
  knaufPendingAgentFilesAtom,
  knaufPendingForAgentIdAtom,
} from '~/knauf/store/pendingAgentFiles';
import {
  usePersonalities,
  type KnaufPersonality,
} from '~/knauf/data-provider/Agents/usePersonalities';
import { useAutogeneratePrompt } from '~/knauf/data-provider/Agents/useAutogeneratePrompt';
import { cn, defaultTextProps, processAgentOption, removeFocusOutlines } from '~/utils';
import AgentCategorySelector from '~/components/SidePanel/Agents/AgentCategorySelector';
import { usePromptTemplates } from '~/knauf/data-provider/Agents/usePromptTemplates';
import { ToolSelectDialog, MCPToolSelectDialog } from '~/components/Tools';
import { useAgentCategories, useLocalize, useVisibleTools } from '~/hooks';
import { KARL_DEFAULT_PERSONALITY_NAME } from '~/knauf/common/constants';
// KK20-195 review R10 — indexing overlay (both branches) + live polling.
import { overlayKnowledgeIndexing, agentFilesRefetchInterval } from '~/knauf/common/fileIndexing';
import { KNAUF_INDEX_POLL_MS } from '~/knauf/hooks/Files/useKnaufIndexStatus';
import { useAgentPanelContext, useFileMapContext } from '~/Providers';
import AgentAvatar from '~/components/SidePanel/Agents/AgentAvatar';
import InstructionsEditorOverlay from './InstructionsEditorOverlay';
// [knauf] KK20-243 — extracted from this file so the row can be rendered in
// isolation; the stale-`checked` defect it fixes is only visible in a render.
import CapabilityRow from './CapabilityRow';
// End [knauf]
import AgentTool from '~/components/SidePanel/Agents/AgentTool';
import { isEphemeralAgent, type AgentForm } from '~/common';
import InstructionsField from './InstructionsField';
import { KNAUF_CAPABILITIES } from './capabilities';
import { useGetAgentFiles } from '~/data-provider';
import PersonalityPills from './PersonalityPills';
import KnaufFileSearch from './KnaufFileSearch';
import KnaufInfoBadge from './KnaufInfoBadge';
import TemplatePicker from './TemplatePicker';
import TemplateSelect from './TemplateSelect';
import KnaufMCPTools from './KnaufMCPTools';
import KnaufSection from './KnaufSection';

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
  const previewMutation = useAutogeneratePrompt('preview');
  // YAML-gated capabilities — `endpoints.agents.capabilities` from
  // librechat.yaml. Each capability in the registry decides via its
  // `isEnabled` whether to render given this list.
  const {
    agentsConfig,
    regularTools,
    availableMCPServers,
    mcpServersMap,
    agent_id: contextAgentId,
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
  // ── Instructions overlay + template context + undo ──────────────────────
  const [overlayOpen, setOverlayOpen] = useState(false);
  const UNDO_STACK_MAX = 10;
  const undoStackRef = useRef<string[]>([]);
  // Captures the user's draft BEFORE any template was applied.
  // Used as currentDraft for preview generation so switching templates
  // doesn't carry over sections from a previously applied template.
  const originalDraftRef = useRef<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  // Derive template content from activeTemplateId so re-renders propagate
  const { data: templatesData } = usePromptTemplates();
  const templateReferenceContent = useMemo(
    () => templatesData?.templates?.find((t) => t.id === activeTemplateId)?.content,
    [templatesData, activeTemplateId],
  );

  // Clear template context and undo when switching agents
  const prevAgentRef = useRef<string | undefined>(undefined);

  const { control, setValue, getValues, formState } = useFormContext<AgentForm>();
  const agent = useWatch({ control, name: 'agent' });
  const formAgentId = useWatch({ control, name: 'id' });
  /**
   * KK20-123 — prefer the AgentPanelContext's `agent_id` over the form's.
   * The upstream create-agent mutation in `AgentPanel.tsx` calls
   * `setCurrentAgentId(newId)` (which lands here as `contextAgentId`)
   * synchronously in `onSuccess`, but the form's `id` only updates later
   * via the agent-refetch + `resetAgentForm` chain in `AgentSelect.tsx`.
   * Using the form id as our agent_id source means the deferred-upload
   * drain in KnaufFileSearch never sees the ephemeral→real transition in
   * time and uploads never fire. Falling back to the form id covers the
   * "selected an existing agent from the dropdown" path where AgentSelect
   * updates the form before the context.
   */
  const agent_id =
    contextAgentId && !isEphemeralAgent(contextAgentId) ? contextAgentId : (formAgentId ?? '');
  const instructions = useWatch({ control, name: 'instructions' });
  const tools = useWatch({ control, name: 'tools' });

  // Reset template context and undo when switching to a different agent
  useEffect(() => {
    if (prevAgentRef.current !== undefined && prevAgentRef.current !== agent_id) {
      originalDraftRef.current = null;
      undoStackRef.current = [];
      setCanUndo(false);
      setActiveTemplateId(null);
    }
    prevAgentRef.current = agent_id;
  }, [agent_id]);

  // Clear undo after a successful save — the saved text becomes the
  // new baseline, undoing to a pre-save state would be confusing.
  const prevSubmitCount = useRef(formState.submitCount);
  useEffect(() => {
    if (formState.submitCount > prevSubmitCount.current && formState.isSubmitSuccessful) {
      undoStackRef.current = [];
      originalDraftRef.current = null;
      setCanUndo(false);
      setActiveTemplateId(null);
    }
    prevSubmitCount.current = formState.submitCount;
  }, [formState.submitCount, formState.isSubmitSuccessful]);

  /** Push a snapshot onto the undo stack (capped at UNDO_STACK_MAX). */
  const pushUndo = useCallback((text: string) => {
    const stack = undoStackRef.current;
    // Avoid duplicate consecutive entries
    if (stack.length > 0 && stack[stack.length - 1] === text) return;
    stack.push(text);
    if (stack.length > UNDO_STACK_MAX) stack.shift();
    setCanUndo(true);
  }, []);

  // KK20-123 — pending-files queue lives in a Knauf-namespaced Recoil
  // atom (see store/pendingAgentFiles.ts) so it survives the AgentPanel
  // remount cycle. KnaufAgentConfig owns the *clearing policy* on
  // navigation and reads pendingFiles for autogenerate payload metadata.
  const setPendingFiles = useSetRecoilState(knaufPendingAgentFilesAtom);
  const pendingFiles = useRecoilValue(knaufPendingAgentFilesAtom);
  const [pendingForAgentId, setPendingForAgentId] = useRecoilState(knaufPendingForAgentIdAtom);

  // KK20-123 — Scope the pending-files queue to a single agent so the
  // red retry cards don't leak between agents.
  //
  // Three clearing cases:
  //   A. We have a tracked owner (a real id) AND the user navigated to
  //      a *different* real agent. The error entries belong to the
  //      previous create flow — drop them.
  //   B. No tracked owner AND the user navigated to a real agent. They
  //      picked files in the ephemeral Create view but never clicked
  //      Create; navigating to an existing agent shouldn't drag those
  //      pending cards along.
  //   C. Fresh ephemeral mount with no tracked owner. Clears leftovers
  //      from a previous abandoned new-agent attempt.
  //
  // The DURING-SAVE remount is the case we deliberately DON'T clear in:
  // `useDrainPendingKnaufFiles` stamps `pendingForAgentId = newId`
  // before flipping `setCurrentAgentId`, so the post-transition mount
  // sees `pendingForAgentId === agent_id` and falls through.
  useEffect(() => {
    // Case A
    if (
      pendingForAgentId &&
      !isEphemeralAgent(pendingForAgentId) &&
      agent_id &&
      !isEphemeralAgent(agent_id) &&
      pendingForAgentId !== agent_id
    ) {
      setPendingFiles((prev) => (prev.size === 0 ? prev : new Map()));
      setPendingForAgentId(null);
      return;
    }
    // Case B
    if (!pendingForAgentId && agent_id && !isEphemeralAgent(agent_id)) {
      setPendingFiles((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    // Case C
    if ((!agent_id || isEphemeralAgent(agent_id)) && !pendingForAgentId) {
      setPendingFiles((prev) => (prev.size === 0 ? prev : new Map()));
    }
  }, [agent_id, pendingForAgentId, setPendingFiles, setPendingForAgentId]);
  const { toolIds, mcpServerNames } = useVisibleTools(tools, regularTools, mcpServersMap);

  // KK20-195 review R10 — poll the agent-files list at the standard cadence
  // while any row's server projection is pending, stop at rest. This is what
  // flips "Indexing…" → ready/failed without a reload or user action.
  const { data: agentFiles = [] } = useGetAgentFiles(agent_id, {
    refetchInterval: (data) => agentFilesRefetchInterval(data, KNAUF_INDEX_POLL_MS),
  });

  const mergedFileMap = useMemo(() => {
    const next = { ...fileMap };
    for (const f of agentFiles) {
      if (f.file_id) next[f.file_id] = f;
    }
    return next;
  }, [fileMap, agentFiles]);

  const knowledge_files = useMemo(() => {
    if (typeof agent === 'string' || agent?.id !== agent_id) return [];
    // KK20-195 WP5b / review R10 — the overlay runs on BOTH branches:
    // existing agents usually already carry agent.knowledge_files, and the
    // early return used to bypass the indexing overlay entirely, freezing
    // rows at "Indexing…" until reload. Base entries come from either
    // source; the server projection (WP3c agent-files list) is then always
    // applied on top — pending/failed knowledge stays live-accurate and
    // `embedded` follows the ledger.
    const base =
      agent?.knowledge_files ??
      (agent ? processAgentOption({ agent, fileMap: mergedFileMap })?.knowledge_files : null) ??
      [];
    return overlayKnowledgeIndexing(base, mergedFileMap);
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

  // Mirror useResponsesApi=true into model_parameters for any agent that
  // doesn't already have it. New agents inherit it from the personality
  // preset in librechat.yaml; this effect covers pre-existing agents so the
  // "Upload to Provider" item in the chat paperclip menu (gated by
  // useResponsesApi on Azure OpenAI — see AttachFileMenu.tsx:158) starts
  // appearing. shouldDirty: false intentionally: we don't fake-dirty the
  // form, so the flag only persists the next time the user saves the agent
  // for some other reason. Idempotent — once set, the early return fires.
  useEffect(() => {
    if (!agent_id) return;
    const params = (getValues('model_parameters') ?? {}) as Record<string, unknown>;
    if (params.useResponsesApi === true) return;
    setValue(
      'model_parameters',
      { ...params, useResponsesApi: true } as unknown as AgentForm['model_parameters'],
      { shouldDirty: false },
    );
  }, [agent_id, getValues, setValue]);

  // ── Personality ───────────────────────────────────────────────────────────
  // Single source of truth: the form's `spec` field (hydrated by
  // AgentSelect.resetAgentForm from `agent.spec`, persisted on save via
  // composeAgentUpdatePayload).
  //
  // We do NOT derive personality from `model` — all three Karl personalities
  // share the same Azure deployment (gpt-5.5 in librechat.yaml), so a
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

  // ── Instructions: undo + ✦ Autogenerate ─────────────────────────────────
  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack.pop()!;
    setValue('instructions', prev, { shouldDirty: true });
    setCanUndo(stack.length > 0);
  }, [setValue]);

  /** Builds the autogenerate payload from current form state.
   *  Polish calls with no args (no template context).
   *  Preview calls with the template content to merge. */
  const buildAutogeneratePayload = useCallback(
    (sourceTemplate?: string) => {
      const picked = personalities.find((p) => p.name === personality);
      const capabilityLabels: string[] = visibleCapabilities
        .filter((cap) => cap.readFromForm({ getValues, setValue }))
        .map((cap) => cap.label);
      // Build knowledge file metadata from edit-flow (saved files) and
      // create-flow (pending uploads not yet persisted).
      const knowledgeFiles: Array<{ name: string; type: string }> = [];
      for (const [, ext] of knowledge_files) {
        if (ext.filename) knowledgeFiles.push({ name: ext.filename, type: ext.type ?? '' });
      }
      for (const [, entry] of pendingFiles) {
        if (entry.file?.name)
          knowledgeFiles.push({ name: entry.file.name, type: entry.file.type ?? '' });
      }
      if (knowledgeFiles.length > 0) {
        capabilityLabels.push(
          `Knowledge base (${knowledgeFiles.length} attached document${knowledgeFiles.length === 1 ? '' : 's'})`,
        );
      }
      const toolNames = toolIds.map((id) => {
        const t = regularTools?.find((rt) => rt.pluginKey === id);
        return t?.name ?? id;
      });
      const categoryValue = getValues('category') ?? '';
      const categoryLabel =
        categories.find((c) => c.value === categoryValue)?.label ?? categoryValue;
      return {
        agent: {
          name: getValues('name') ?? '',
          description: getValues('description') ?? '',
          category: categoryLabel,
          personality: {
            label: picked?.label ?? '',
            description: picked?.description ?? '',
          },
          capabilities: capabilityLabels,
          knowledgeFiles,
          tools: toolNames,
          mcpServers: mcpServerNames ?? [],
        },
        currentDraft: getValues('instructions') ?? '',
        sourceTemplate,
      };
    },
    [
      personalities,
      personality,
      visibleCapabilities,
      knowledge_files,
      pendingFiles,
      toolIds,
      regularTools,
      categories,
      mcpServerNames,
      getValues,
      setValue,
    ],
  );

  const onAutogenerate = () => {
    const current = getValues('instructions') ?? '';
    autogenerate.mutate(buildAutogeneratePayload(), {
      onSuccess: ({ text }) => {
        pushUndo(current);
        setValue('instructions', text, { shouldDirty: true });
      },
      onError: (err) =>
        showToast({
          status: 'error',
          message: err?.message ?? localize('com_knauf_prompt_draft_failed'),
        }),
    });
  };

  /** Generate a preview of the user's draft merged into a template.
   *  Uses a separate mutation (distinct mutationKey) so it doesn't
   *  conflict with Polish. Returns a promise for the overlay's state.
   *  Always uses the current editor text so manual edits are never lost. */
  const generatePreview = useCallback(
    async (templateContent: string): Promise<string> => {
      const { text } = await previewMutation.mutateAsync(buildAutogeneratePayload(templateContent));
      return text;
    },
    [previewMutation, buildAutogeneratePayload],
  );

  /** Called when a template is selected in the expanded overlay.
   *  Does NOT touch the editor content — the user's draft stays as-is.
   *  Sets the template as a read-only reference panel and saves the
   *  current draft so Apply can provide undo back to it. */
  const handleTemplateSelectOverlay = useCallback(
    (template: PromptTemplate) => {
      originalDraftRef.current = getValues('instructions') ?? '';
      setActiveTemplateId(template.id);
    },
    [getValues],
  );

  /** Called when a template is selected in the sidebar (non-overlay).
   *  If the user already has a draft, auto-merges it with the template
   *  via the preview mutation (same as "Preview with template" in the
   *  overlay). Falls back to raw template insertion on error or when
   *  there's no existing draft. */
  const [sidebarTemplateMerging, setSidebarTemplateMerging] = useState(false);
  const handleTemplateSelectSidebar = useCallback(
    (template: PromptTemplate) => {
      const currentDraft = getValues('instructions') ?? '';
      // No existing draft — just insert the template content directly
      if (!currentDraft.trim()) {
        pushUndo(currentDraft);
        setValue('instructions', template.content, { shouldDirty: true });
        return;
      }
      // Existing draft — merge via the preview mutation
      setSidebarTemplateMerging(true);
      previewMutation
        .mutateAsync(buildAutogeneratePayload(template.content))
        .then(({ text }) => {
          pushUndo(currentDraft);
          setValue('instructions', text, { shouldDirty: true });
        })
        .catch(() => {
          // Fallback: insert raw template content
          pushUndo(currentDraft);
          setValue('instructions', template.content, { shouldDirty: true });
          showToast({
            status: 'warning',
            message: localize('com_knauf_prompt_merge_failed'),
          });
        })
        .finally(() => setSidebarTemplateMerging(false));
    },
    [getValues, setValue, pushUndo, buildAutogeneratePayload, previewMutation, showToast, localize],
  );

  /** Called when the template panel is closed. Clears the reference
   *  panel since the user is done browsing templates. */
  const handleTemplatePanelClose = useCallback(() => {
    setActiveTemplateId(null);
    originalDraftRef.current = null;
  }, []);

  /** Called when the user clicks "Apply" on a template preview.
   *  Commits the AI-generated merged text to the editor with undo support. */
  const handleApplyPreview = useCallback(
    (text: string) => {
      pushUndo(getValues('instructions') ?? '');
      setValue('instructions', text, { shouldDirty: true });
    },
    [getValues, setValue, pushUndo],
  );

  const templatePickerNode: ReactNode = (
    <TemplateSelect onSelect={handleTemplateSelectSidebar} loading={sidebarTemplateMerging} />
  );

  const templatePickerCompactNode: ReactNode = (
    <TemplatePicker
      onSelect={handleTemplateSelectOverlay}
      compact
      activeTemplateId={activeTemplateId}
    />
  );

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
            {/* Render tool rows unconditionally — matches upstream AgentConfig.
                A loading gate here would hide a just-added tool until the
                `regularTools` query resolves, leaving the user staring at a
                loading message that only clears when they navigate away and
                back. Rows for IDs not yet in `regularTools` are skipped and
                fill in once the query settles. */}
            <div className="mb-1">
              {toolIds.map((toolId, i) => {
                const tool = regularTools?.find((t) => t.pluginKey === toolId);
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
          </KnaufSection>
        ) : null}

        {/* Instructions — smart dual-mode field (KK20-179) */}
        <InstructionsField
          drafting={autogenerate.isLoading}
          onAutogenerate={onAutogenerate}
          onExpandClick={() => setOverlayOpen(true)}
          canUndo={canUndo}
          onUndo={handleUndo}
          templatePicker={templatePickerNode}
        />

        {/* Fullscreen editor overlay */}
        <InstructionsEditorOverlay
          open={overlayOpen}
          onOpenChange={setOverlayOpen}
          drafting={autogenerate.isLoading}
          onAutogenerate={onAutogenerate}
          canUndo={canUndo}
          onUndo={handleUndo}
          templatePicker={templatePickerCompactNode}
          onTemplatePanelClose={handleTemplatePanelClose}
          templateReferenceContent={templateReferenceContent}
          onGeneratePreview={generatePreview}
          onApplyPreview={handleApplyPreview}
        />

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

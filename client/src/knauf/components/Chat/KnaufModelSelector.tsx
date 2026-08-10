/**
 * Knauf chat-header model picker (KK20-128). Replaces upstream `ModelSelector`
 * via a one-line `[knauf]` import swap in client/src/components/Chat/Header.tsx.
 *
 * Differences from upstream:
 *   - Agents only — modelSpecs (KARL/Precise/Balanced/Creative), non-agents
 *     endpoints (Azure OpenAI) and custom groups are deliberately hidden.
 *     Personality lives inside the agent builder now (KK20-128 phase 1).
 *   - "Pinned" section at the top, mirroring the sidebar Favorites store
 *     (same `useFavorites()` hook, so pinning here also shows in the sidebar).
 *   - Pin/unpin icon on hover-right of every agent row.
 *
 * The default conversation on a fresh chat is whichever modelSpec is marked
 * `default: true` in librechat.yaml (today: `karl`) — that's upstream's
 * mechanism; this picker doesn't override it.
 *
 * Reuses upstream `ModelSelectorChatProvider` + `ModelSelectorProvider` for
 * the agent map, selection handler, search debounce, and Ariakit
 * Menu/Combobox primitives.
 */
import { memo, useMemo, useCallback, useEffect, useRef, type MouseEvent } from 'react';
import * as Ariakit from '@ariakit/react';
import { useRecoilValue } from 'recoil';
import type { Agent, TModelSpec } from 'librechat-data-provider';
import { Constants, EModelEndpoint, getConfigDefaults } from 'librechat-data-provider';
import { TooltipAnchor } from '@librechat/client';
import { MessageSquare, Pin, PinOff } from 'lucide-react';
import type { ModelSelectorProps, SelectedValues } from '~/common';
import { useFavorites, useLocalize } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';
import { cn, renderAgentAvatar } from '~/utils';
import {
  ModelSelectorProvider,
  useModelSelectorContext,
} from '~/components/Chat/Menus/Endpoints/ModelSelectorContext';
import { ModelSelectorChatProvider } from '~/components/Chat/Menus/Endpoints/ModelSelectorChatContext';
import {
  CustomMenu,
  CustomMenuItem,
  CustomMenuSeparator,
} from '~/components/Chat/Menus/Endpoints/CustomMenu';
import DialogManager from '~/components/Chat/Menus/Endpoints/DialogManager';

const defaultInterface = getConfigDefaults().interface;

/** Pinned alphabetical sort locale — pinned so cross-user/cross-tenant ordering is stable. */
const SORT_LOCALE = 'en';

export function hasKnaufPickerSelection({
  endpoint,
  model,
  modelSpec,
}: Pick<SelectedValues, 'endpoint' | 'model' | 'modelSpec'>) {
  return Boolean(modelSpec || (endpoint === EModelEndpoint.agents && model));
}

export default function KnaufModelSelector({ startupConfig }: Readonly<ModelSelectorProps>) {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  /**
   * Diverges intentionally from upstream `ModelSelector`, which keeps the
   * picker visible when `modelSelect: false` *and* there are model specs.
   * In the Knauf flow model specs are hidden from the picker by design, so
   * `modelSelect: false` means "no picker", full stop.
   */
  if (interfaceConfig.modelSelect === false) {
    return null;
  }
  return (
    <ModelSelectorChatProvider>
      <ModelSelectorProvider startupConfig={startupConfig}>
        <KnaufModelSelectorContent />
      </ModelSelectorProvider>
    </ModelSelectorChatProvider>
  );
}

function KnaufModelSelectorContent() {
  const localize = useLocalize();
  const {
    agentsMap,
    mappedEndpoints,
    endpointsConfig,
    searchValue,
    selectedValues,
    setSearchValue,
    handleSelectModel,
    handleSelectSpec,
    keyDialogOpen,
    onOpenChange,
    keyDialogEndpoint,
  } = useModelSelectorContext();
  const { data: startupConfig } = useGetStartupConfig();
  /**
   * Own the Ariakit menu store at this layer (instead of letting CustomMenu
   * own it) so we can call `.hide()` on sidebar toggles. Ariakit's
   * autoUpdate only observes resize+scroll on the trigger; sibling-driven
   * CSS transitions that slide the chat header horizontally are invisible
   * to it, so an open popover keeps a stale transform and clips off the
   * left edge. Closing the menu on sidebar toggle forces a fresh re-measure
   * on the next click.
   */
  const menuStore = Ariakit.useMenuStore({
    showTimeout: 100,
    placement: 'bottom-start',
  });
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  useEffect(() => {
    menuStore.hide();
  }, [sidebarExpanded, menuStore]);
  /**
   * Lift `useFavorites()` to the parent so each `KnaufAgentRow` doesn't
   * create its own atom subscription, query, and toast context (was N+1 hook
   * instances for N agents). Rows receive only the `pinned: boolean` they
   * care about and a stable `onTogglePin` callback.
   */
  const { favorites, addFavoriteAgent, removeFavoriteAgent } = useFavorites();

  /**
   * Stable refs around `addFavoriteAgent` / `removeFavoriteAgent` — those
   * closures are recreated by `useFavorites` on every render, so any
   * `useCallback` capturing them directly would also be unstable, defeating
   * `memo()` on the rows.
   */
  const addFavoriteRef = useRef(addFavoriteAgent);
  const removeFavoriteRef = useRef(removeFavoriteAgent);
  useEffect(() => {
    addFavoriteRef.current = addFavoriteAgent;
    removeFavoriteRef.current = removeFavoriteAgent;
  });

  /** The agents endpoint object — carries `agentNames` / `modelIcons`. */
  const agentsEndpoint = useMemo(
    () => (mappedEndpoints ?? []).find((e) => e.value === EModelEndpoint.agents),
    [mappedEndpoints],
  );

  /** All accessible agents the user can see (permission-filtered upstream). */
  const allAgents = useMemo<Agent[]>(
    () =>
      Object.values(agentsMap ?? {}).filter(
        (a): a is Agent => a != null && typeof a.id === 'string',
      ),
    [agentsMap],
  );

  /** User-favorited agent IDs, in the order they appear in `user.favorites`. */
  const favoritedAgentIds = useMemo(
    () =>
      favorites
        .map((f) => f.agentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    [favorites],
  );

  /**
   * Pinned agents = favorites that exist in the agentsMap. Orphan favorites
   * (deleted agents) are filtered out.
   */
  const pinnedAgents = useMemo<Agent[]>(() => {
    const list: Agent[] = [];
    for (const id of favoritedAgentIds) {
      const agent = agentsMap?.[id];
      if (!agent) continue;
      list.push(agent);
    }
    return list;
  }, [favoritedAgentIds, agentsMap]);

  /** Set of pinned agent IDs — recomputed only when the favorites array changes. */
  const pinnedAgentIdSet = useMemo(() => new Set(favoritedAgentIds), [favoritedAgentIds]);

  /** Remaining accessible agents (not already pinned), filtered by search. */
  const unpinnedAgents = useMemo<Agent[]>(() => {
    const pinnedIds = new Set(pinnedAgents.map((a) => a.id));
    const query = searchValue.trim().toLowerCase();
    return allAgents
      .filter((a) => !pinnedIds.has(a.id))
      .filter((a) => {
        if (!query) return true;
        return (a.name ?? '').toLowerCase().includes(query);
      })
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', SORT_LOCALE));
  }, [allAgents, pinnedAgents, searchValue]);

  /** Currently-selected agent (for trigger label). */
  const selectedAgent = useMemo<Agent | null>(() => {
    if (selectedValues.model && agentsMap?.[selectedValues.model]) {
      return agentsMap[selectedValues.model] ?? null;
    }
    return null;
  }, [selectedValues.model, agentsMap]);

  /**
   * The "Chat" entry — driven by whichever modelSpec carries `default: true`
   * in librechat.yaml (today: `karl`). Surfaced as a first-class row at the
   * top of the picker so users can switch back to the default-spec chat
   * after selecting an agent. Also auto-bound on a fresh app open so the
   * picker shows the modelSpec's label as the selection (instead of an
   * empty "Select Agent" placeholder).
   */
  const defaultModelSpec = useMemo<TModelSpec | null>(() => {
    const list = startupConfig?.modelSpecs?.list ?? [];
    return list.find((s) => s.default === true) ?? null;
  }, [startupConfig?.modelSpecs?.list]);

  const isDefaultSpecSelected =
    !!defaultModelSpec && selectedValues.modelSpec === defaultModelSpec.name;

  const onSelectDefaultSpec = useCallback(() => {
    if (defaultModelSpec) handleSelectSpec(defaultModelSpec);
  }, [defaultModelSpec, handleSelectSpec]);

  /**
   * Stable handlers passed to each row. They read latest favorite-mutator
   * functions through refs (the hook's closures are unstable), so the row
   * receives the same callback identity across re-renders.
   */
  const onAgentSelect = useCallback(
    (agentId: string) => {
      if (!agentsEndpoint) return;
      handleSelectModel(agentsEndpoint, agentId);
    },
    [agentsEndpoint, handleSelectModel],
  );
  const onTogglePin = useCallback((agentId: string, currentlyPinned: boolean) => {
    if (currentlyPinned) {
      removeFavoriteRef.current(agentId);
    } else {
      addFavoriteRef.current(agentId);
    }
  }, []);

  /**
   * Auto-bind the default modelSpec ("Chat") on a fresh conversation that has
   * no supported Knauf selection yet. Sister behaviour to upstream's
   * `modelSpecs.list[].default: true` mechanism — the spec gets selected on app
   * entry so the trigger shows its label (e.g. "KARL") instead of an empty
   * "Select Agent" placeholder.
   *
   * Gated on the state, not a one-shot ref. A modelSpec or custom agent is an
   * intentional selection and wins. A raw endpoint/model is not selectable in
   * this Knauf picker, so on a fresh chat it is only startup fallback state and
   * must not block KARL from binding. This also repairs the first-login race
   * where Azure OpenAI initializes before the default spec. Because the effect
   * re-evaluates on every fresh-state transition, New Chat correctly re-binds
   * the default without overriding a custom agent.
   */
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const isFreshChat = !conversationId || conversationId === Constants.NEW_CONVO;
  useEffect(() => {
    if (!defaultModelSpec || !isFreshChat) return;
    if (hasKnaufPickerSelection(selectedValues)) return;
    handleSelectSpec(defaultModelSpec);
  }, [
    defaultModelSpec,
    isFreshChat,
    selectedValues.endpoint,
    selectedValues.model,
    selectedValues.modelSpec,
    handleSelectSpec,
  ]);

  const triggerLabel =
    selectedAgent?.name ??
    (isDefaultSpecSelected ? defaultModelSpec?.label : undefined) ??
    localize('com_ui_select_agent');
  const triggerIcon = selectedAgent ? renderAgentAvatar(selectedAgent, { size: 'icon' }) : null;

  const trigger = (
    <TooltipAnchor
      aria-label={localize('com_ui_select_agent')}
      description={localize('com_ui_select_agent')}
      render={
        <button
          type="button"
          className="my-1 flex h-9 w-full max-w-[70vw] items-center justify-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt"
          aria-label={localize('com_ui_select_agent')}
        >
          {triggerIcon ? (
            <div className="flex flex-shrink-0 items-center justify-center overflow-hidden">
              {triggerIcon}
            </div>
          ) : null}
          <span className="flex-grow truncate text-left">{triggerLabel}</span>
        </button>
      }
    />
  );

  return (
    <div className="relative flex w-full max-w-md flex-col items-center gap-2">
      <CustomMenu
        store={menuStore}
        onSearch={setSearchValue}
        combobox={<input id="agent-search" placeholder=" " />}
        comboboxLabel={localize('com_knauf_search_agents')}
        trigger={trigger}
      >
        {defaultModelSpec ? (
          <>
            <KnaufDefaultSpecRow
              label={defaultModelSpec.label ?? defaultModelSpec.name}
              isSelected={isDefaultSpecSelected}
              onSelect={onSelectDefaultSpec}
            />
            <CustomMenuSeparator />
          </>
        ) : null}

        {pinnedAgents.length > 0 ? (
          <>
            <SectionLabel>{localize('com_knauf_pinned')}</SectionLabel>
            {pinnedAgents.map((agent) => (
              <KnaufAgentRow
                key={agent.id}
                agent={agent}
                isSelected={selectedValues.model === agent.id}
                pinned={pinnedAgentIdSet.has(agent.id)}
                onSelect={onAgentSelect}
                onTogglePin={onTogglePin}
              />
            ))}
            <CustomMenuSeparator />
          </>
        ) : null}

        <SectionLabel>{localize('com_knauf_my_agents')}</SectionLabel>
        {unpinnedAgents.length === 0 ? (
          <div className="p-3 text-center text-xs text-text-secondary">
            {searchValue
              ? localize('com_knauf_no_agent_matches')
              : localize('com_knauf_no_agents_available')}
          </div>
        ) : (
          /* Cap at ~5 rows; internal scroll keeps the search input and Pinned
            section in view above. Row height (≈32px) × 5 ≈ 160px. */
          <div className="max-h-[180px] overflow-y-auto">
            {unpinnedAgents.map((agent) => (
              <KnaufAgentRow
                key={agent.id}
                agent={agent}
                isSelected={selectedValues.model === agent.id}
                pinned={pinnedAgentIdSet.has(agent.id)}
                onSelect={onAgentSelect}
                onTogglePin={onTogglePin}
              />
            ))}
          </div>
        )}
      </CustomMenu>
      <DialogManager
        keyDialogOpen={keyDialogOpen}
        onOpenChange={onOpenChange}
        endpointsConfig={endpointsConfig || {}}
        keyDialogEndpoint={keyDialogEndpoint || undefined}
      />
    </div>
  );
}

function SectionLabel({ children }: Readonly<{ children: string }>) {
  return (
    <Ariakit.MenuGroupLabel className="cursor-default p-2 text-xs font-medium opacity-60 sm:py-1">
      {children}
    </Ariakit.MenuGroupLabel>
  );
}

/**
 * Single agent row inside the dropdown. Renders avatar + name, the
 * selected-state background, and a pin/unpin button (always visible when
 * pinned; revealed on row hover/focus when unpinned). All favorite state
 * and mutators live on the parent — this component only receives the
 * booleans it needs, so `memo()` actually skips re-renders for unchanged
 * rows.
 */
const KnaufAgentRow = memo(function KnaufAgentRow({
  agent,
  isSelected,
  pinned,
  onSelect,
  onTogglePin,
}: Readonly<{
  agent: Agent;
  isSelected: boolean;
  pinned: boolean;
  onSelect: (agentId: string) => void;
  onTogglePin: (agentId: string, currentlyPinned: boolean) => void;
}>) {
  const localize = useLocalize();

  const handleSelect = useCallback(() => {
    onSelect(agent.id);
  }, [agent.id, onSelect]);

  const handlePinClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onTogglePin(agent.id, pinned);
    },
    [agent.id, pinned, onTogglePin],
  );

  const pinTitle = pinned ? localize('com_ui_unpin') : localize('com_ui_pin');

  return (
    <CustomMenuItem
      onClick={handleSelect}
      aria-label={agent.name ?? agent.id}
      className={cn('group', isSelected ? 'bg-surface-tertiary' : undefined)}
    >
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {renderAgentAvatar(agent, { size: 'icon' })}
      </div>
      <span className="min-w-0 flex-1 truncate">{agent.name ?? agent.id}</span>
      <button
        type="button"
        onClick={handlePinClick}
        aria-label={pinTitle}
        title={pinTitle}
        className={cn(
          'ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition hover:bg-surface-tertiary hover:text-text-primary',
          pinned
            ? 'opacity-100'
            : 'opacity-0 focus:opacity-100 group-hover:opacity-100 group-data-[active-item]:opacity-100',
        )}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </CustomMenuItem>
  );
});

/**
 * "Chat" row that selects the default modelSpec. Sits at the very top of
 * the picker (above Pinned). No pin/unpin affordance — it's not a user
 * favourite, it's the system default. KK20-168.
 */
const KnaufDefaultSpecRow = memo(function KnaufDefaultSpecRow({
  label,
  isSelected,
  onSelect,
}: Readonly<{
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}>) {
  return (
    <CustomMenuItem
      onClick={onSelect}
      aria-label={label}
      className={cn(isSelected ? 'bg-surface-tertiary' : undefined)}
    >
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        <MessageSquare size={16} aria-hidden="true" />
      </div>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </CustomMenuItem>
  );
});

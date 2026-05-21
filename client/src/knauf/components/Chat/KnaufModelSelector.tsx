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
 *   - The admin-configured `interface.defaultAgentId` always appears first
 *     in Pinned, with no unpin affordance.
 *   - Pin/unpin icon on hover-right of every agent row.
 *
 * Reuses upstream `ModelSelectorChatProvider` + `ModelSelectorProvider` for
 * the agent map, selection handler, search debounce, and Ariakit
 * Menu/Combobox primitives.
 */
import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import type { Agent, TStartupConfig } from 'librechat-data-provider';
import { EModelEndpoint, getConfigDefaults } from 'librechat-data-provider';
import { TooltipAnchor } from '@librechat/client';
import { Pin, PinOff } from 'lucide-react';
import { useFavorites, useLocalize } from '~/hooks';
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

const TRIGGER_PLACEHOLDER = 'Select an agent';
const PINNED_HEADER = 'Pinned';
const AGENTS_HEADER = 'My Agents';
const DEFAULT_BADGE = 'Default';
const PIN_LABEL = 'Pin agent';
const UNPIN_LABEL = 'Unpin agent';
const EMPTY_AGENTS = 'No agents available';
const SEARCH_AGENTS_LABEL = 'Search agents…';

export default function KnaufModelSelector({
  startupConfig,
}: Readonly<{ startupConfig?: TStartupConfig }>) {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  if (interfaceConfig.modelSelect === false) {
    return null;
  }
  return (
    <ModelSelectorChatProvider>
      <ModelSelectorProvider startupConfig={startupConfig}>
        <KnaufModelSelectorContent
          defaultAgentId={
            (interfaceConfig as { knauf?: { defaultAgentId?: string } }).knauf?.defaultAgentId ?? ''
          }
        />
      </ModelSelectorProvider>
    </ModelSelectorChatProvider>
  );
}

function KnaufModelSelectorContent({ defaultAgentId }: Readonly<{ defaultAgentId: string }>) {
  const localize = useLocalize();
  const {
    agentsMap,
    mappedEndpoints,
    endpointsConfig,
    searchValue,
    selectedValues,
    setSearchValue,
    handleSelectModel,
    keyDialogOpen,
    onOpenChange,
    keyDialogEndpoint,
  } = useModelSelectorContext();
  const { favorites } = useFavorites();

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

  /** The locked-default agent (if configured AND accessible). */
  const defaultAgent = useMemo(() => {
    if (!defaultAgentId) return null;
    return agentsMap?.[defaultAgentId] ?? null;
  }, [defaultAgentId, agentsMap]);

  /**
   * Pinned agents = default (if any) + favorites that are NOT the default
   * and that exist in the agentsMap. De-dupes accidental double-pin of
   * the default; orphan favorites (deleted agents) are filtered out.
   */
  const pinnedAgents = useMemo<Agent[]>(() => {
    const seen = new Set<string>();
    const list: Agent[] = [];
    if (defaultAgent) {
      list.push(defaultAgent);
      seen.add(defaultAgent.id);
    }
    for (const id of favoritedAgentIds) {
      if (seen.has(id)) continue;
      const agent = agentsMap?.[id];
      if (!agent) continue;
      list.push(agent);
      seen.add(id);
    }
    return list;
  }, [defaultAgent, favoritedAgentIds, agentsMap]);

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
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [allAgents, pinnedAgents, searchValue]);

  /** Currently-selected agent (for trigger label) — fall back to default. */
  const selectedAgent = useMemo<Agent | null>(() => {
    if (selectedValues.model && agentsMap?.[selectedValues.model]) {
      return agentsMap[selectedValues.model] ?? null;
    }
    return defaultAgent;
  }, [selectedValues.model, agentsMap, defaultAgent]);

  const handleAgentClick = useCallback(
    (agent: Agent) => {
      if (!agentsEndpoint) return;
      handleSelectModel(agentsEndpoint, agent.id);
    },
    [agentsEndpoint, handleSelectModel],
  );

  /**
   * Auto-bind the locked-default agent on a truly fresh chat (no endpoint and
   * no model yet). Fires at most once per mount so we never overwrite a user's
   * later choice. Without this, removing the `default: true` modelSpec leaves
   * new conversations with no default and chat submission would fail.
   */
  const autoSelectFiredRef = useRef(false);
  useEffect(() => {
    if (autoSelectFiredRef.current) return;
    if (!defaultAgent || !agentsEndpoint) return;
    if (selectedValues.endpoint || selectedValues.model) return;
    autoSelectFiredRef.current = true;
    handleSelectModel(agentsEndpoint, defaultAgent.id);
  }, [
    defaultAgent,
    agentsEndpoint,
    selectedValues.endpoint,
    selectedValues.model,
    handleSelectModel,
  ]);

  const triggerLabel = selectedAgent?.name ?? TRIGGER_PLACEHOLDER;
  const triggerIcon = selectedAgent ? renderAgentAvatar(selectedAgent, { size: 'icon' }) : null;

  const trigger = (
    <TooltipAnchor
      aria-label={localize('com_ui_select_model')}
      description={localize('com_ui_select_model')}
      render={
        <button
          type="button"
          className="my-1 flex h-9 w-full max-w-[70vw] items-center justify-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt"
          aria-label={localize('com_ui_select_model')}
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
        onSearch={(value) => setSearchValue(value)}
        combobox={<input id="agent-search" placeholder=" " />}
        comboboxLabel={SEARCH_AGENTS_LABEL}
        trigger={trigger}
      >
        {pinnedAgents.length > 0 ? (
          <>
            <SectionLabel>{PINNED_HEADER}</SectionLabel>
            {pinnedAgents.map((agent) => (
              <KnaufAgentRow
                key={agent.id}
                agent={agent}
                isSelected={selectedValues.model === agent.id}
                isDefault={agent.id === defaultAgent?.id}
                onSelect={() => handleAgentClick(agent)}
              />
            ))}
            <CustomMenuSeparator />
          </>
        ) : null}

        <SectionLabel>{AGENTS_HEADER}</SectionLabel>
        {unpinnedAgents.length === 0 ? (
          <div className="p-3 text-center text-xs text-text-secondary">{EMPTY_AGENTS}</div>
        ) : (
          /* Cap at ~5 rows; internal scroll keeps the search input and Pinned
            section in view above. Row height (≈32px) × 5 ≈ 160px. */
          <div className="max-h-[180px] overflow-y-auto">
            {unpinnedAgents.map((agent) => (
              <KnaufAgentRow
                key={agent.id}
                agent={agent}
                isSelected={selectedValues.model === agent.id}
                isDefault={false}
                onSelect={() => handleAgentClick(agent)}
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
 * Single agent row inside the dropdown. Renders avatar + name, an optional
 * "Default" badge, the active-state checkmark, and a hover-revealed
 * pin/unpin button. The default-locked agent has no pin button.
 */
const KnaufAgentRow = memo(function KnaufAgentRow({
  agent,
  isSelected,
  isDefault,
  onSelect,
}: Readonly<{
  agent: Agent;
  isSelected: boolean;
  isDefault: boolean;
  onSelect: () => void;
}>) {
  const { isFavoriteAgent, addFavoriteAgent, removeFavoriteAgent } = useFavorites();
  const pinned = isFavoriteAgent(agent.id);

  const handlePinClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (pinned) {
        removeFavoriteAgent(agent.id);
      } else {
        addFavoriteAgent(agent.id);
      }
    },
    [pinned, agent.id, addFavoriteAgent, removeFavoriteAgent],
  );

  return (
    <CustomMenuItem
      onClick={onSelect}
      aria-label={agent.name ?? agent.id}
      className={cn('group', isSelected ? 'bg-surface-tertiary' : undefined)}
    >
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {renderAgentAvatar(agent, { size: 'icon' })}
      </div>
      <span className="min-w-0 flex-1 truncate">{agent.name ?? agent.id}</span>
      {isDefault ? (
        <span className="ml-1 rounded-full bg-surface-tertiary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
          {DEFAULT_BADGE}
        </span>
      ) : null}
      {!isDefault ? (
        <button
          type="button"
          onClick={handlePinClick}
          aria-label={pinned ? UNPIN_LABEL : PIN_LABEL}
          title={pinned ? UNPIN_LABEL : PIN_LABEL}
          className={cn(
            'ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition hover:bg-surface-tertiary hover:text-text-primary',
            pinned
              ? 'opacity-100'
              : 'opacity-0 focus:opacity-100 group-hover:opacity-100 group-data-[active-item]:opacity-100',
          )}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      ) : null}
    </CustomMenuItem>
  );
});

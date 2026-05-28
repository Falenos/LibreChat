import { atom } from 'recoil';

export type PendingFileStatus = 'queued' | 'uploading' | 'error';
export type PendingFileEntry = { file: File; status: PendingFileStatus };
export type PendingFiles = Map<string, PendingFileEntry>;
export type SetPendingFiles = (next: PendingFiles | ((prev: PendingFiles) => PendingFiles)) => void;

/**
 * KK20-123 — Queue of File objects picked during the ephemeral
 * "Create Agent" flow. Held outside the React tree (Recoil atom) so it
 * survives the AgentPanel remount cycle that fires when
 * `setCurrentAgentId(newId)` flips `basicAgentQuery.isInitialLoading` to
 * true (see AgentPanel.tsx ~line 550: `!agentQuery.isInitialLoading`
 * guards the AgentConfig subtree). That guard unmounts KnaufAgentConfig
 * and destroys any useState living inside it — including, previously,
 * this queue. Moving the queue to Recoil makes it outlast the remount
 * so the drain effect in KnaufFileSearch can read the queued entries
 * after Edit-mode remount and upload them to the just-minted agent_id.
 */
export const knaufPendingAgentFilesAtom = atom<PendingFiles>({
  key: 'knaufPendingAgentFiles',
  default: new Map(),
});

/**
 * KK20-123 — agent_id that the pending-files queue belongs to.
 * Set to the just-minted real id at the START of
 * `useDrainPendingKnaufFiles` so the clear-on-foreign-agent effect in
 * `KnaufAgentConfig` can distinguish three cases:
 *
 *   - Queue belongs to the agent currently in view → preserve
 *   - Queue belongs to a different real agent (user navigated away) →
 *     clear, the entries don't apply here
 *   - Queue has no tracked owner AND the user navigated to a real
 *     agent (the user picked files in ephemeral state and then
 *     navigated away without clicking Create) → clear, the entries
 *     weren't intended for this agent
 *
 * `null` means "no active queue / no ownership recorded yet".
 */
export const knaufPendingForAgentIdAtom = atom<string | null>({
  key: 'knaufPendingForAgentId',
  default: null,
});

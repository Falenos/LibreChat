/**
 * KK20-123 — drain the Knauf pending-files queue with a known agent_id.
 *
 * This is the upload-then-transition gate: AgentPanel's create-mutation
 * `onSuccess` awaits this helper before calling `setCurrentAgentId`,
 * which is what visually flips the side panel from "Create" mode to
 * "Edit" mode (the flip is driven by the `!agentQuery.isInitialLoading`
 * guard at AgentPanel.tsx ~line 550 — see comments on
 * `knaufPendingAgentFilesAtom`).
 *
 * Behaviour:
 *   - Reads the latest `knaufPendingAgentFilesAtom` snapshot at call time
 *     (via `useRecoilCallback` — closure of a memoised `useCallback`
 *     would otherwise see a stale Map).
 *   - For every entry with status `'queued'`, marks it `'uploading'`,
 *     fires a `POST /api/files` with the new `agent_id` baked into the
 *     multipart payload (matches upstream's
 *     `client/src/hooks/Files/useFileHandling.ts` request shape so the
 *     server-side validator/ingest sees identical fields), and on
 *     success removes the entry, on failure marks it `'error'`.
 *   - Uses `Promise.allSettled` so one bad file doesn't block the
 *     transition — failed files persist in the atom as red retry cards
 *     after the panel transitions to Edit mode.
 *   - Resolves to `{ allOk }` so the caller can decide whether to
 *     surface a success or failure toast.
 */
import { useRecoilCallback } from 'recoil';
import { v4 as uuidv4 } from 'uuid';
import { dataService, EModelEndpoint, EToolResources } from 'librechat-data-provider';
import {
  knaufPendingAgentFilesAtom,
  knaufPendingForAgentIdAtom,
} from '~/knauf/store/pendingAgentFiles';

export type DrainResult = { allOk: boolean; uploaded: number; failed: number };

export function useDrainPendingKnaufFiles() {
  return useRecoilCallback(
    ({ snapshot, set }) =>
      async (agentId: string): Promise<DrainResult> => {
        if (!agentId) return { allOk: true, uploaded: 0, failed: 0 };

        const current = await snapshot.getPromise(knaufPendingAgentFilesAtom);
        const queuedEntries = Array.from(current.entries()).filter(
          ([, e]) => e.status === 'queued',
        );
        if (queuedEntries.length === 0) {
          return { allOk: true, uploaded: 0, failed: 0 };
        }

        // Stamp ownership BEFORE flipping statuses so the clear-on-foreign-agent
        // effect in KnaufAgentConfig knows the queue belongs to `agentId`. The
        // effect's case A guard (`pendingForAgentId && pendingForAgentId !== agent_id`)
        // skips clearing while the panel is still rendering the ephemeral
        // Create view (agent_id is empty) since `agent_id` isn't real yet.
        set(knaufPendingForAgentIdAtom, agentId);

        set(knaufPendingAgentFilesAtom, (prev) => {
          const next = new Map(prev);
          for (const [tempId] of queuedEntries) {
            const existing = next.get(tempId);
            if (existing) next.set(tempId, { ...existing, status: 'uploading' });
          }
          return next;
        });

        const results = await Promise.allSettled(
          queuedEntries.map(async ([tempId, entry]) => {
            const formData = new FormData();
            formData.append('endpoint', EModelEndpoint.agents);
            formData.append('endpointType', '');
            formData.append('file', entry.file, encodeURIComponent(entry.file.name));
            formData.append('file_id', uuidv4());
            formData.append('agent_id', agentId);
            formData.append('tool_resource', EToolResources.file_search);
            await dataService.uploadFile(formData);
            return tempId;
          }),
        );

        let uploaded = 0;
        let failed = 0;
        set(knaufPendingAgentFilesAtom, (prev) => {
          const next = new Map(prev);
          for (let i = 0; i < results.length; i += 1) {
            const [tempId] = queuedEntries[i];
            const r = results[i];
            if (r.status === 'fulfilled') {
              next.delete(tempId);
              uploaded += 1;
            } else {
              const existing = next.get(tempId);
              if (existing) next.set(tempId, { ...existing, status: 'error' });
              failed += 1;
            }
          }
          return next;
        });

        return { allOk: failed === 0, uploaded, failed };
      },
    [],
  );
}

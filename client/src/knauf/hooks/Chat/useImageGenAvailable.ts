/**
 * [knauf] Visibility predicate for the per-conversation image-generation
 * chip rendered by `KnaufImageGenTools`. Centralises the policy so the
 * mount in ChatForm.tsx and the chip itself share one source of truth.
 *
 * Policy:
 *   1. `interface.knauf.imageGen === false` in `librechat.yaml` is a hard
 *      global kill switch — chip hidden everywhere.
 *   2. On a custom (persistent) agent chat, the chip is NEVER shown. If
 *      the admin installed `image_gen_oai` on the agent the tool is
 *      always active — no per-chat opt-in. The backend treats stored
 *      tools as authoritative on this branch (no strip in `loadAgent`).
 *   3. On a default-spec chat (no custom agent — `agent_id` absent or
 *      ephemeral) the chip is universally available so long as the
 *      conversation is on a Knauf model spec (`conversation.spec` set).
 *      The backend gate in `loadEphemeralAgent` still enforces per-chat
 *      opt-in via `ephemeralAgent.image_gen`.
 *
 * KK20-168.
 */
import { useMemo } from 'react';
import { isEphemeralAgentId } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';

interface UseImageGenAvailableArgs {
  agentId?: string | null;
  spec?: string | null;
}

export function useImageGenAvailable({ agentId, spec }: UseImageGenAvailableArgs): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  const isCustomAgent = !!agentId && !isEphemeralAgentId(agentId);

  return useMemo(() => {
    if (startupConfig?.interface?.knauf?.imageGen === false) {
      return false;
    }
    if (isCustomAgent) {
      return false;
    }
    return !!spec;
  }, [startupConfig?.interface?.knauf?.imageGen, isCustomAgent, spec]);
}

export default useImageGenAvailable;

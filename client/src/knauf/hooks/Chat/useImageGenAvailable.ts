/**
 * [knauf] Visibility predicate for the per-conversation image-generation
 * chip rendered by `KnaufImageGenTools`. Centralises the policy so the
 * mount in ChatForm.tsx and the chip itself share one source of truth.
 *
 * Policy:
 *   1. `interface.knauf.imageGen === false` in `librechat.yaml` is a hard
 *      global kill switch — chip hidden everywhere.
 *   2. On a custom (persistent) agent chat, the chip is available iff the
 *      agent has `image_gen_oai` in its `tools` array (admin opt-in via
 *      the agent builder).
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
import { useGetStartupConfig, useGetAgentByIdQuery } from '~/data-provider';

const IMAGE_GEN_TOOL = 'image_gen_oai';

interface UseImageGenAvailableArgs {
  agentId?: string | null;
  spec?: string | null;
}

export function useImageGenAvailable({ agentId, spec }: UseImageGenAvailableArgs): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  const isCustomAgent = !!agentId && !isEphemeralAgentId(agentId);
  const { data: agent } = useGetAgentByIdQuery(isCustomAgent ? agentId : null);

  return useMemo(() => {
    if (startupConfig?.interface?.knauf?.imageGen === false) {
      return false;
    }
    if (isCustomAgent) {
      return !!agent?.tools?.includes(IMAGE_GEN_TOOL);
    }
    return !!spec;
  }, [startupConfig?.interface?.knauf?.imageGen, isCustomAgent, agent?.tools, spec]);
}

export default useImageGenAvailable;

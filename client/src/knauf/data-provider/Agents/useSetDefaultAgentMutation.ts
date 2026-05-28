/**
 * Admin-only mutation that flips the system-wide default-agent flag.
 *
 * Server-side, PATCH /api/agents/:id with `{ isDefault: true }` triggers the
 * KK20-123 exclusivity invariant: any other agent that previously had
 * `isDefault: true` is unset first. The upstream `useUpdateAgentMutation`
 * only patches the *edited* agent in the React Query cache, so after a
 * default switch the previously-default agent would still appear as default
 * client-side until something else refetched. We invalidate the agents
 * query family on success to force the agentsMap to re-derive from the
 * server's actual state — that's the only way the locked-default badge in
 * `KnaufModelSelector` swaps to the new agent atomically.
 *
 * KK20-123 — superseded the deprecated yaml-driven `defaultAgentId`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  type Agent,
  type AgentUpdateParams,
} from 'librechat-data-provider';

export type SetDefaultAgentVariables = {
  agent_id: string;
  isDefault: boolean;
};

export const useSetDefaultAgentMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<Agent, Error, SetDefaultAgentVariables>({
    mutationFn: ({ agent_id, isDefault }) =>
      dataService.updateAgent({
        agent_id,
        data: { isDefault } as Pick<AgentUpdateParams, 'isDefault'>,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.agents]);
      queryClient.invalidateQueries([QueryKeys.agent]);
    },
  });
};

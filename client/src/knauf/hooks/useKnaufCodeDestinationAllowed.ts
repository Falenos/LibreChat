import { useMemo } from 'react';
import { useGetStartupConfig } from '~/data-provider';

/**
 * [knauf] KK20-257 — may a file be sent to the code sandbox in this conversation?
 *
 * One expression, three call sites: the paperclip menu's "Upload files to edit" row
 * (AttachFileMenu), its drag-drop twin (DragDropModal), and the tabular auto-routing rule
 * (useFileHandling). They must agree — the menu offering a destination that the routing
 * rule refuses, or the reverse, is a bug users read as randomness.
 *
 * WHY IT IS NOT JUST `codeAllowedByAgent`
 * Upstream's `useAgentToolPermissions` answers from the ephemeral agent alone
 * (`ephemeralAgent?.execute_code ?? false`). The **server** is more generous: it registers
 * the tool when the ephemeral agent OR the resolved model spec asks for it —
 * `ephemeralAgent?.execute_code === true || modelSpec?.executeCode === true`
 * (packages/api/src/agents/load.ts). So a client that reads only the first term can be
 * strictly narrower than the backend it is describing, and then it hides a destination
 * that would in fact have worked.
 *
 * That gap is reachable: any path that leaves the ephemeral agent unseeded — the
 * `updateEphemeralAgent(targetId, null)` in `applyModelSpecEffects`, a cleared
 * localStorage, a conversation restored before its spec resolves — produces exactly it.
 * `knaufHardDefaultSpecApplies` fixes the main offender at the source; this mirrors the
 * server's own condition so the remaining paths cannot reintroduce the same class of bug.
 *
 * Deliberately mirrors the server rather than being merely permissive: the spec consulted
 * is the one the conversation runs (`specName`), falling back to the hard default — which
 * is what a fresh conversation will be submitted with. A spec that sets `executeCode:
 * false` therefore still hides the destination, and a client "yes" always has a
 * server-side "yes" behind it.
 */
export default function useKnaufCodeDestinationAllowed(params: {
  /** `execute_code` is in the served `endpoints.agents.capabilities` (the fail-closed guard). */
  codeEnabled: boolean;
  /** Upstream's per-agent answer, from `useAgentToolPermissions`. */
  codeAllowedByAgent: boolean;
  /** `conversation?.spec`, where the caller has the conversation. */
  specName?: string | null;
}): boolean {
  const { codeEnabled, codeAllowedByAgent, specName } = params;
  const { data: startupConfig } = useGetStartupConfig();

  const specAllowsCode = useMemo(() => {
    const list = startupConfig?.modelSpecs?.list;
    if (!list?.length) {
      return false;
    }
    const spec =
      (specName != null && specName !== ''
        ? list.find((entry) => entry.name === specName)
        : undefined) ?? list.find((entry) => entry.default);
    return spec?.executeCode === true;
  }, [startupConfig?.modelSpecs?.list, specName]);

  // The capability is the hard gate — it is what the fail-closed LIBRECHAT_CODE_BASEURL
  // guard strips (packages/api/src/knauf/code/codeEnvGuard.ts), so nothing may pass it.
  return codeEnabled && (codeAllowedByAgent || specAllowsCode);
}

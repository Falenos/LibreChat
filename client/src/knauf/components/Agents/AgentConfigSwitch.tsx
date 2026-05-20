import { useRecoilValue } from 'recoil';
import { SystemRoles } from 'librechat-data-provider';
import UpstreamAgentConfig from '~/components/SidePanel/Agents/AgentConfig';
import { useAuthContext } from '~/hooks/AuthContext';
import KnaufAgentConfig from './KnaufAgentConfig';
import { knaufAdminBuilderModeAtom } from '~/knauf/store/builderMode';

/**
 * Routes the agent-builder body between the upstream `AgentConfig`
 * (detailed view) and the simplified `KnaufAgentConfig` (everyone else),
 * based on the logged-in user's role and the persisted admin builder mode.
 *
 * KK20-125 / FEAT-03 — admins default to detailed; everyone else, and
 * admins who explicitly toggle, see the simplified Knauf builder.
 *
 * This component lives entirely in Knauf territory; the call site in
 * `AgentPanel.tsx` only needs to swap its `import AgentConfig` target
 * from `KnaufAgentConfig` to this router.
 */
export default function AgentConfigSwitch() {
  const { user } = useAuthContext();
  const builderMode = useRecoilValue(knaufAdminBuilderModeAtom);

  const isAdmin = user?.role === SystemRoles.ADMIN;
  const showDetailed = isAdmin && builderMode === 'detailed';

  return showDetailed ? <UpstreamAgentConfig /> : <KnaufAgentConfig />;
}

import { Globe } from 'lucide-react';
import { Spinner } from '@librechat/client';
import { useWatch, useFormContext } from 'react-hook-form';
import {
  SystemRoles,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { AgentForm, AgentPanelProps } from '~/common';
import { useLocalize, useAuthContext, useHasAccess, useResourcePermissions } from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useUpdateAgentMutation } from '~/data-provider';
import AdvancedButton from './Advanced/AdvancedButton';
import VersionButton from './Version/VersionButton';
import DuplicateAgent from './DuplicateAgent';
import AdminSettings from './AdminSettings';
import DeleteButton from './DeleteButton';
import { Panel } from '~/common';
// [knauf] Builder simplification (KK20-125 / FEAT-03).
// The two HIDE flags below used to be module-level constants. They are now
// computed at runtime inside the component because their value depends on
// the logged-in user's role and the persisted admin builder mode. Admins
// in 'detailed' mode see the full upstream footer (Advanced panel button
// + Duplicate Agent); everyone else (including admins toggled to
// 'simplified') keeps the simplified-builder hiding behaviour.
import { useRecoilState } from 'recoil';
import { Switch } from '@librechat/client';
import { knaufAdminBuilderModeAtom } from '~/knauf/store/builderMode';
// End [knauf]

export default function AgentFooter({
  activePanel,
  createMutation,
  updateMutation,
  setActivePanel,
  setCurrentAgentId,
  isAvatarUploading = false,
}: Pick<
  AgentPanelProps,
  'setCurrentAgentId' | 'createMutation' | 'activePanel' | 'setActivePanel'
> & {
  updateMutation: ReturnType<typeof useUpdateAgentMutation>;
  isAvatarUploading?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();

  // [knauf] Derive simplification gates from role + persisted builder mode.
  // KK20-125 / FEAT-03 — see import-block comment.
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const [builderMode, setBuilderMode] = useRecoilState(knaufAdminBuilderModeAtom);
  const isAdminDetailed = isAdmin && builderMode === 'detailed';
  const KNAUF_HIDE_ADVANCED = !isAdminDetailed;
  const KNAUF_HIDE_DUPLICATE = !isAdminDetailed;
  // End [knauf]

  const methods = useFormContext<AgentForm>();

  const { control } = methods;
  const agent = useWatch({ control, name: 'agent' });
  const agent_id = useWatch({ control, name: 'id' });
  const hasAccessToShareAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.SHARE,
  });
  const hasAccessToShareRemoteAgents = useHasAccess({
    permissionType: PermissionTypes.REMOTE_AGENTS,
    permission: Permissions.SHARE,
  });
  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.AGENT,
    agent?._id || '',
  );
  const { hasPermission: hasRemoteAgentPermission, isLoading: remotePermissionsLoading } =
    useResourcePermissions(ResourceType.REMOTE_AGENT, agent?._id || '');

  const canShareThisAgent = hasPermission(PermissionBits.SHARE);
  const canEditThisAgent = hasPermission(PermissionBits.EDIT);
  const canDeleteThisAgent = hasPermission(PermissionBits.DELETE);
  const canShareRemoteAgent = hasRemoteAgentPermission(PermissionBits.SHARE);
  const isSaving = createMutation.isLoading || updateMutation.isLoading || isAvatarUploading;
  const renderSaveButton = () => {
    if (isSaving) {
      return <Spinner className="icon-md" aria-hidden="true" />;
    }

    if (agent_id) {
      return localize('com_ui_save');
    }

    return localize('com_ui_create');
  };

  const showButtons = activePanel === Panel.builder;

  return (
    <div className="mb-1 flex w-full flex-col gap-2">
      {/* [knauf] AdvancedButton hidden — see KNAUF_HIDE_ADVANCED above. */}
      {!KNAUF_HIDE_ADVANCED && showButtons && <AdvancedButton setActivePanel={setActivePanel} />}
      {/* End [knauf] */}
      {showButtons && agent_id && <VersionButton setActivePanel={setActivePanel} />}
      {/* [knauf] Admin-only toggle between detailed (upstream) and simplified
          (Knauf) builder views. KK20-125 / FEAT-03. Visible only when the
          builder is the active panel so it sits with the other admin
          controls. */}
      {isAdmin && showButtons && (
        <div className="flex items-center justify-end gap-2">
          <label htmlFor="knauf-admin-builder-mode-switch" className="text-sm text-text-secondary">
            {localize('com_knauf_builder_simplified_view')}
          </label>
          <Switch
            id="knauf-admin-builder-mode-switch"
            data-testid="knauf-admin-builder-mode-switch"
            checked={builderMode === 'simplified'}
            onCheckedChange={(checked) => setBuilderMode(checked ? 'simplified' : 'detailed')}
            aria-label={localize('com_knauf_builder_simplified_view')}
          />
        </div>
      )}
      {/* End [knauf] */}
      {user?.role === SystemRoles.ADMIN && showButtons && <AdminSettings />}
      {/* Context Button */}
      <div className="flex items-center justify-end gap-2">
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canDeleteThisAgent) &&
          !permissionsLoading && (
            <DeleteButton
              agent_id={agent_id}
              setCurrentAgentId={setCurrentAgentId}
              createMutation={createMutation}
            />
          )}
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canShareThisAgent) &&
          hasAccessToShareAgents &&
          !permissionsLoading && (
            <GenericGrantAccessDialog
              resourceDbId={agent?._id}
              resourceId={agent_id}
              resourceName={agent?.name ?? ''}
              resourceType={ResourceType.AGENT}
            />
          )}
        {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canShareRemoteAgent) &&
          hasAccessToShareRemoteAgents &&
          !remotePermissionsLoading &&
          agent?._id && (
            <GenericGrantAccessDialog
              resourceDbId={agent?._id}
              resourceId={agent_id}
              resourceName={agent?.name ?? ''}
              resourceType={ResourceType.REMOTE_AGENT}
            >
              <button
                type="button"
                className="btn btn-neutral border-token-border-light h-9 px-3"
                title={localize('com_ui_remote_access')}
              >
                <Globe className="h-4 w-4" aria-hidden="true" />
              </button>
            </GenericGrantAccessDialog>
          )}
        {/* [knauf] DuplicateAgent hidden — see KNAUF_HIDE_DUPLICATE above. */}
        {!KNAUF_HIDE_DUPLICATE &&
          (agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canEditThisAgent) &&
          !permissionsLoading && <DuplicateAgent agent_id={agent_id} />}
        {/* End [knauf] */}
        {/* Submit Button */}
        <button
          className="btn btn-primary focus:shadow-outline flex h-9 w-full items-center justify-center px-4 py-2 font-semibold text-white hover:bg-green-600 focus:border-green-500"
          type="submit"
          disabled={isSaving}
          aria-busy={isSaving}
        >
          {renderSaveButton()}
        </button>
      </div>
    </div>
  );
}

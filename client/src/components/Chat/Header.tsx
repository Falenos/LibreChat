import { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { Folder } from 'lucide-react';
import { useMediaQuery } from '@librechat/client';
import { getConfigDefaults, PermissionTypes, Permissions } from 'librechat-data-provider';
import type { TChatProject } from 'librechat-data-provider';
// [knauf] Agents-only picker with locked-default + user pins (KK20-128).
import ModelSelector from '~/knauf/components/Chat/KnaufModelSelector';
// End [knauf]
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import { OpenSidebar, PresetsMenu } from './Menus';
import BookmarkMenu from './Menus/BookmarkMenu';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { useHasAccess } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

function Header({ project }: { project?: TChatProject }) {
  const { data: startupConfig } = useGetStartupConfig();
  const navVisible = useRecoilValue(store.sidebarExpanded);

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  return (
    <div className="via-presentation/70 md:from-presentation/80 md:via-presentation/50 2xl:from-presentation/0 absolute top-0 z-10 flex h-[52px] w-full items-center justify-between bg-gradient-to-b from-presentation to-transparent p-2 font-semibold text-text-primary 2xl:via-transparent">
      <div className="hide-scrollbar flex w-full items-center justify-between gap-2 overflow-x-auto">
        <div className="mx-1 flex items-center">
          {isSmallScreen ? <OpenSidebar /> : null}
          {!(navVisible && isSmallScreen) && (
            <div
              className={cn(
                'flex items-center gap-2 pl-2',
                !isSmallScreen ? 'transition-all duration-200 ease-in-out' : '',
              )}
            >
              <ModelSelector startupConfig={startupConfig} />
              {project && (
                // [knauf] KK20-248 — keep project context visible after the
                // landing composer disappears and the conversation has messages.
                <div className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-border-light bg-surface-secondary/80 px-2.5 text-xs font-medium text-text-secondary">
                  <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{project.name}</span>
                </div>
              )}
              {interfaceConfig.presets === true && interfaceConfig.modelSelect && <PresetsMenu />}
              {hasAccessToBookmarks === true && <BookmarkMenu />}
              {/* [knauf] honor `interface.multiConvo` from librechat.yaml (KK20-128) */}
              {interfaceConfig.multiConvo === true && hasAccessToMultiConvo === true && (
                <AddMultiConvo />
              )}
              {/* End [knauf] */}
              {isSmallScreen && (
                <>
                  <ExportAndShareMenu
                    isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
                  />
                  {hasAccessToTemporaryChat === true && <TemporaryChat />}
                </>
              )}
            </div>
          )}
        </div>

        {!isSmallScreen && (
          <div className="flex items-center gap-2">
            <ExportAndShareMenu
              isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
            />
            {hasAccessToTemporaryChat === true && <TemporaryChat />}
          </div>
        )}
      </div>
      {/* Empty div for spacing */}
      <div />
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'Header';

export default MemoizedHeader;

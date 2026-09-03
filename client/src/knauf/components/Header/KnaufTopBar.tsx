/**
 * Knauf top-of-app header bar (KK20-173).
 *
 * Full-width horizontal bar that runs across the top of the application,
 * above the sidebar + chat split. Carries the Knauf wordmark on the
 * left and the user avatar with a dropdown menu on the right. The menu
 * items mirror the (now hidden) sidebar `AccountSettings` —
 * Email row, optional Balance row, My Files, KARL help, Settings, Log out —
 * so the top bar is the single user-menu surface.
 *
 * Reuses every dependency `AccountSettings` already pulled in
 * (`useAuthContext`, `useGetStartupConfig`, `useGetUserBalance`,
 * `MyFilesModal`, `Settings`, `Avatar`, etc.) and mounts the Knauf-owned
 * help dialog so the release notes do not depend on a separately served route.
 */
import { memo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import * as Menu from '@ariakit/react/menu';
import { BookOpen, FileText, LogOut } from 'lucide-react';
import { Avatar, DropdownMenuSeparator, GearIcon } from '@librechat/client';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import Settings from '~/components/Nav/Settings';
import { useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import KnaufHelpDialog from './KnaufHelpDialog';

function KnaufTopBar() {
  const localize = useLocalize();
  const { user, isAuthenticated, logout } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled === true,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const menuStore = Ariakit.useMenuStore({ placement: 'bottom-end' });

  // [knauf] Header height is h-14 (56px); keep in sync with KNAUF_HEADER_HEIGHT in routes/Root.tsx.
  return (
    <header className="flex h-14 w-full flex-shrink-0 items-center justify-between border-b border-border-light bg-surface-primary px-4">
      <div className="flex h-full items-center">
        <img src="/assets/knauf-logo.png" alt="Knauf" className="h-8 w-auto object-contain" />
      </div>
      <Menu.MenuProvider store={menuStore}>
        <Menu.MenuButton
          ref={avatarButtonRef}
          aria-label={localize('com_nav_account_settings')}
          data-testid="knauf-topbar-user"
          className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-surface-active-alt aria-[expanded=true]:bg-surface-active-alt"
        >
          <div className="size-8 flex-shrink-0">
            <Avatar user={user} size={32} />
          </div>
        </Menu.MenuButton>
        <Menu.Menu
          portal
          gutter={8}
          className="account-settings-popover popover-ui z-[125] w-[244px] rounded-lg"
        >
          <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
            {user?.email ?? localize('com_nav_user')}
          </div>
          <DropdownMenuSeparator />
          {startupConfig?.balance?.enabled === true && balanceQuery.data != null && (
            <>
              <div className="text-token-text-secondary ml-3 mr-2 py-2 text-sm" role="note">
                {localize('com_nav_balance')}:{' '}
                {new Intl.NumberFormat().format(Math.round(balanceQuery.data.tokenCredits))}
              </div>
              <DropdownMenuSeparator />
            </>
          )}
          <Menu.MenuItem onClick={() => setShowFiles(true)} className="select-item text-sm">
            <FileText className="icon-md" aria-hidden="true" />
            {localize('com_nav_my_files')}
          </Menu.MenuItem>
          {/* [knauf] KK20-250 / KK20-283 — discoverable user docs and release notes. */}
          <Menu.MenuItem onClick={() => setShowHelp(true)} className="select-item text-sm">
            <BookOpen className="icon-md" aria-hidden="true" />
            {localize('com_nav_karl_help')}
          </Menu.MenuItem>
          {/* End [knauf] */}
          <Menu.MenuItem onClick={() => setShowSettings(true)} className="select-item text-sm">
            <GearIcon className="icon-md" aria-hidden="true" />
            {localize('com_nav_settings')}
          </Menu.MenuItem>
          <DropdownMenuSeparator />
          <Menu.MenuItem onClick={() => logout()} className="select-item text-sm">
            <LogOut className="icon-md" aria-hidden="true" />
            {localize('com_nav_log_out')}
          </Menu.MenuItem>
        </Menu.Menu>
        {showFiles && (
          <MyFilesModal open={showFiles} onOpenChange={setShowFiles} triggerRef={avatarButtonRef} />
        )}
        {showHelp && (
          <KnaufHelpDialog
            open={showHelp}
            onOpenChange={setShowHelp}
            triggerRef={avatarButtonRef}
          />
        )}
        {showSettings && <Settings open={showSettings} onOpenChange={setShowSettings} />}
      </Menu.MenuProvider>
    </header>
  );
}

export default memo(KnaufTopBar);

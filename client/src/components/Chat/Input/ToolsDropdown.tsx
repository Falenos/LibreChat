import React, { useState, useMemo, useCallback } from 'react';
import * as Ariakit from '@ariakit/react';
import { TooltipAnchor, DropdownPopup, PinIcon, VectorIcon } from '@librechat/client';
import { Globe, ScrollText, Settings, Settings2, TerminalSquareIcon } from 'lucide-react';
import {
  AuthType,
  Permissions,
  ArtifactModes,
  PermissionTypes,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import { useLocalize, useHasAccess, useAgentCapabilities } from '~/hooks';
import ArtifactsSubMenu from '~/components/Chat/Input/ArtifactsSubMenu';
import MCPSubMenu from '~/components/Chat/Input/MCPSubMenu';
import { useGetStartupConfig } from '~/data-provider';
import { useBadgeRowContext } from '~/Providers';
import { cn } from '~/utils';

interface ToolsDropdownProps {
  disabled?: boolean;
  // [knauf] KK20-168 — extension point for fork-specific menu items
  // (used by KnaufToolsDropdown to inject "Create image"). Keeping the
  // injection surface to a single optional prop avoids spreading [knauf]
  // markers through the body of this file — see SEAMS row + the
  // KnaufToolsDropdown wrapper.
  extraItems?: MenuItemProps[];
  // End [knauf]
}

const ToolsDropdown = ({ disabled, extraItems }: ToolsDropdownProps) => {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { data: startupConfig } = useGetStartupConfig();

  const { codeEnabled, webSearchEnabled, artifactsEnabled, fileSearchEnabled, skillsEnabled } =
    useAgentCapabilities(context?.agentsConfig?.capabilities ?? defaultAgentCapabilities);

  const canUseWebSearch = useHasAccess({
    permissionType: PermissionTypes.WEB_SEARCH,
    permission: Permissions.USE,
  });

  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });

  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });

  const canUseMcp = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });

  const canUseSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });

  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const isDisabled = disabled ?? false;
  const {
    skills,
    webSearch,
    artifacts,
    fileSearch,
    mcpServerManager,
    codeInterpreter,
    searchApiKeyForm,
  } = context ?? {};

  const { setIsDialogOpen: setIsSearchDialogOpen, menuTriggerRef: searchMenuTriggerRef } =
    searchApiKeyForm ?? {};
  const {
    isPinned: isSearchPinned,
    setIsPinned: setIsSearchPinned,
    authData: webSearchAuthData,
  } = webSearch ?? {};
  const { isPinned: isCodePinned, setIsPinned: setIsCodePinned } = codeInterpreter ?? {};
  const { isPinned: isFileSearchPinned, setIsPinned: setIsFileSearchPinned } = fileSearch ?? {};
  const { isPinned: isArtifactsPinned, setIsPinned: setIsArtifactsPinned } = artifacts ?? {};
  const { isPinned: isSkillsPinned, setIsPinned: setIsSkillsPinned } = skills ?? {};

  const showWebSearchSettings = useMemo(() => {
    const authTypes = webSearchAuthData?.authTypes ?? [];
    if (authTypes.length === 0) return true;
    return !authTypes.every(([, authType]) => authType === AuthType.SYSTEM_DEFINED);
  }, [webSearchAuthData?.authTypes]);

  const handleWebSearchToggle = useCallback(() => {
    const newValue = !webSearch?.toggleState;
    webSearch?.debouncedChange({ value: newValue });
  }, [webSearch]);

  const handleCodeInterpreterToggle = useCallback(() => {
    const newValue = !codeInterpreter?.toggleState;
    codeInterpreter?.debouncedChange({ value: newValue });
  }, [codeInterpreter]);

  const handleFileSearchToggle = useCallback(() => {
    const newValue = !fileSearch?.toggleState;
    fileSearch?.debouncedChange({ value: newValue });
  }, [fileSearch]);

  const handleArtifactsToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (!currentState || currentState === '') {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: '' });
    }
  }, [artifacts]);

  const handleShadcnToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (currentState === ArtifactModes.SHADCNUI) {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: ArtifactModes.SHADCNUI });
    }
  }, [artifacts]);

  const handleCustomToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (currentState === ArtifactModes.CUSTOM) {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: ArtifactModes.CUSTOM });
    }
  }, [artifacts]);

  const handleSkillsToggle = useCallback(() => {
    const newValue = !skills?.toggleState;
    skills?.debouncedChange({ value: newValue });
  }, [skills]);

  const mcpPlaceholder = startupConfig?.interface?.mcpServers?.placeholder;

  const dropdownItems: MenuItemProps[] = [];

  // [knauf] Don't surface the file-search tool in the composer tools menu. The
  // chip itself is hidden (FileSearch.tsx) and document uploads go through the
  // "Upload files" menu (KK20-190), so a file-search toggle here would be a
  // confusing no-op. Hidden in the UI (not via the FILE_SEARCH permission) so
  // librechat.yaml stays = main. `as boolean` keeps the body reachable. KK20-190.
  const KNAUF_HIDE_FILE_SEARCH_TOOL = true as boolean;
  if (!KNAUF_HIDE_FILE_SEARCH_TOOL && fileSearchEnabled && canUseFileSearch) {
    dropdownItems.push({
      onClick: handleFileSearchToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props}>
          <div className="flex items-center gap-2">
            <VectorIcon className="icon-md" />
            <span>{localize('com_assistants_file_search')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsFileSearchPinned?.(!isFileSearchPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isFileSearchPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isFileSearchPinned ? 'Unpin' : 'Pin'}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isFileSearchPinned} />
            </div>
          </button>
        </div>
      ),
    });
  }
  // End [knauf]

  if (canUseWebSearch && webSearchEnabled) {
    dropdownItems.push({
      onClick: handleWebSearchToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props}>
          <div className="flex items-center gap-2">
            <Globe className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_web_search')}</span>
          </div>
          <div className="flex items-center gap-1">
            {showWebSearchSettings && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSearchDialogOpen?.(true);
                }}
                className={cn(
                  'rounded p-1 transition-all duration-200',
                  'hover:bg-surface-secondary hover:shadow-sm',
                  'text-text-secondary hover:text-text-primary',
                )}
                aria-label="Configure web search"
                ref={searchMenuTriggerRef}
              >
                <div className="h-4 w-4">
                  <Settings className="h-4 w-4" aria-hidden="true" />
                </div>
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsSearchPinned?.(!isSearchPinned);
              }}
              className={cn(
                'rounded p-1 transition-all duration-200',
                'hover:bg-surface-secondary hover:shadow-sm',
                !isSearchPinned && 'text-text-secondary hover:text-text-primary',
              )}
              aria-label={isSearchPinned ? 'Unpin' : 'Pin'}
            >
              <div className="h-4 w-4">
                <PinIcon unpin={isSearchPinned} />
              </div>
            </button>
          </div>
        </div>
      ),
    });
  }

  // [knauf] Don't surface the skills toggle in the composer tools menu. The chip
  // itself is hidden (Skills.tsx) because every KARL spec sets `skills: true`, so
  // this entry could only ever turn skills off. Hidden in the UI (not via the
  // SKILLS permission) so librechat.yaml stays as-is and the `$` popover keeps
  // working. `as boolean` keeps the body reachable. Mirrors KK20-190.
  const KNAUF_HIDE_SKILLS_TOOL = true as boolean;
  if (!KNAUF_HIDE_SKILLS_TOOL && canUseSkills && skillsEnabled) {
    dropdownItems.push({
      onClick: handleSkillsToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props} data-testid="tools-menu-skills">
          <div className="flex items-center gap-2">
            <ScrollText className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_skills')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsSkillsPinned?.(!isSkillsPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isSkillsPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isSkillsPinned ? localize('com_ui_unpin') : localize('com_ui_pin')}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isSkillsPinned} />
            </div>
          </button>
        </div>
      ),
    });
  }
  // End [knauf]

  // [knauf] KK20-257 — don't surface the code-interpreter toggle in the composer tools
  // menu. The chip itself is hidden (CodeInterpreter.tsx) because code execution is
  // always on for every user-facing KARL spec, so a toggle here could only turn the
  // sandbox off. Hidden in the UI rather than via the RUN_CODE permission, because that
  // permission is what makes the manual Run button work (see CodeInterpreter.tsx for the
  // full reasoning). `as boolean` keeps the upstream body reachable for clean merges.
  const KNAUF_HIDE_CODE_INTERPRETER_TOOL = true as boolean;
  if (!KNAUF_HIDE_CODE_INTERPRETER_TOOL && canRunCode && codeEnabled) {
    dropdownItems.push({
      onClick: handleCodeInterpreterToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props}>
          <div className="flex items-center gap-2">
            <TerminalSquareIcon className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_run_code')}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsCodePinned?.(!isCodePinned);
              }}
              className={cn(
                'rounded p-1 transition-all duration-200',
                'hover:bg-surface-secondary hover:shadow-sm',
                !isCodePinned && 'text-text-primary hover:text-text-primary',
              )}
              aria-label={isCodePinned ? 'Unpin' : 'Pin'}
            >
              <div className="h-4 w-4">
                <PinIcon unpin={isCodePinned} />
              </div>
            </button>
          </div>
        </div>
      ),
    });
  }
  // End [knauf]

  // [knauf] Don't surface the artifacts submenu in the composer tools menu. The
  // chip itself is hidden (Artifacts.tsx) because every KARL spec sets
  // `artifacts: 'default'`, so this entry could only ever turn artifacts off (or
  // switch a mode we don't ship). Hidden in the UI (not via the capability) so
  // `artifacts: 'default'` keeps flowing through. `as boolean` keeps the body
  // reachable. Mirrors KK20-190.
  const KNAUF_HIDE_ARTIFACTS_TOOL = true as boolean;
  if (!KNAUF_HIDE_ARTIFACTS_TOOL && artifactsEnabled && setIsArtifactsPinned != null) {
    dropdownItems.push({
      hideOnClick: false,
      render: (props) => (
        <ArtifactsSubMenu
          {...props}
          isArtifactsPinned={isArtifactsPinned ?? false}
          setIsArtifactsPinned={setIsArtifactsPinned}
          artifactsMode={artifacts?.toggleState as string}
          handleArtifactsToggle={handleArtifactsToggle}
          handleShadcnToggle={handleShadcnToggle}
          handleCustomToggle={handleCustomToggle}
        />
      ),
    });
  }
  // End [knauf]

  const { availableMCPServers } = mcpServerManager ?? {};
  if (canUseMcp && availableMCPServers && availableMCPServers.length > 0) {
    dropdownItems.push({
      hideOnClick: false,
      render: (props) => <MCPSubMenu {...props} placeholder={mcpPlaceholder} />,
    });
  }

  // [knauf] KK20-168 — append fork-specific items at the tail. See the
  // `extraItems` prop comment + KnaufToolsDropdown.
  if (extraItems && extraItems.length > 0) {
    dropdownItems.push(...extraItems);
  }
  // End [knauf]

  if (dropdownItems.length === 0) {
    return null;
  }

  const menuTrigger = (
    <TooltipAnchor
      render={
        <Ariakit.MenuButton
          disabled={isDisabled}
          id="tools-dropdown-button"
          aria-label="Tools Options"
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
            isPopoverActive && 'bg-surface-hover',
          )}
        >
          <div className="flex w-full items-center justify-center gap-2">
            <Settings2 className="size-5" aria-hidden="true" />
          </div>
        </Ariakit.MenuButton>
      }
      id="tools-dropdown-button"
      description={localize('com_ui_tools')}
      disabled={isDisabled}
    />
  );

  return (
    <DropdownPopup
      itemClassName="flex w-full cursor-pointer rounded-lg items-center justify-between hover:bg-surface-hover gap-5"
      menuId="tools-dropdown-menu"
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      modal={true}
      unmountOnHide={true}
      trigger={menuTrigger}
      items={dropdownItems}
      iconClassName="mr-0"
    />
  );
};

export default React.memo(ToolsDropdown);

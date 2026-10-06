import React, { useState } from 'react';
import { MenuButton } from '@ariakit/react';
import { History, Check } from 'lucide-react';
import { DropdownPopup, TooltipAnchor, Button, useMediaQuery } from '@librechat/client';
import { useLocalize } from '~/hooks';

// [knauf] KK20-410 — display persisted artifact revision numbers and unavailable gaps.
interface ArtifactVersionProps {
  currentIndex: number;
  versions: Array<{ version: number; available: boolean }>;
  isLoading?: boolean;
  onVersionChange: (index: number) => void;
}

export default function ArtifactVersion({
  currentIndex,
  versions,
  isLoading = false,
  onVersionChange,
}: Readonly<ArtifactVersionProps>) {
  const localize = useLocalize();
  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const menuId = 'version-dropdown-menu';

  const handleValueChange = (value: string) => {
    const index = parseInt(value, 10);
    onVersionChange(index);
    setIsPopoverActive(false);
  };

  if (versions.length <= 1) {
    return null;
  }

  const options = versions.map(({ version, available }, index) => ({
    value: index.toString(),
    label: available
      ? localize('com_ui_version_var', { 0: String(version) })
      : `${localize('com_ui_version_var', { 0: String(version) })} — ${localize(
          'com_ui_unavailable',
        )}`,
    available,
  }));

  const dropdownItems = options.map((option) => {
    const isSelected = option.value === String(currentIndex);
    return {
      label: option.label,
      onClick: () => handleValueChange(option.value),
      value: option.value,
      disabled: !option.available || isLoading,
      icon: isSelected ? (
        <Check size={16} className="text-text-primary" aria-hidden="true" />
      ) : undefined,
    };
  });

  return (
    <DropdownPopup
      menuId={menuId}
      portal
      focusLoop
      unmountOnHide
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      trigger={
        <TooltipAnchor
          description={localize('com_ui_change_version')}
          render={
            <Button
              size="icon"
              variant="ghost"
              asChild
              disabled={isLoading}
              aria-busy={isLoading}
              aria-label={localize('com_ui_change_version')}
            >
              <MenuButton>
                <History
                  size={18}
                  className="text-text-secondary"
                  aria-hidden="true"
                  focusable="false"
                />
              </MenuButton>
            </Button>
          }
        />
      }
      items={dropdownItems}
      className={isSmallScreen ? '' : 'absolute right-0 top-0 mt-2'}
    />
  );
}
// End [knauf]

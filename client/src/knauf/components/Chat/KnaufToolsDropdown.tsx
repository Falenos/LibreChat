/**
 * Knauf wrapper around the upstream `ToolsDropdown` (KK20-168). Builds the
 * Knauf-specific "Create image" menu item and forwards it to upstream via
 * the `extraItems` prop. Replaces an earlier ~80-line inline `[knauf]`
 * block inside ToolsDropdown.tsx — the upstream seam is now a 5-line prop
 * addition, and all Knauf logic lives here.
 *
 * Visibility is delegated to `useImageGenAvailable` (kill switch +
 * default-spec branch — same source of truth the chip rendered by
 * `KnaufImageGenTools` uses). Toggle + pin state come from
 * `useToolToggle('image_gen')`, sharing Recoil + localStorage state with
 * the chip so the popover entry and the composer chip stay in sync.
 */
import { useCallback, useMemo } from 'react';
import { ImageIcon } from 'lucide-react';
import { PinIcon } from '@librechat/client';
import { LocalStorageKeys } from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import { useLocalize, useToolToggle } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';
import ToolsDropdown from '~/components/Chat/Input/ToolsDropdown';
import { useImageGenAvailable } from '~/knauf/hooks/Chat/useImageGenAvailable';
import { cn } from '~/utils';

interface KnaufToolsDropdownProps {
  disabled?: boolean;
}

const KnaufToolsDropdown = ({ disabled }: KnaufToolsDropdownProps) => {
  const localize = useLocalize();
  const context = useBadgeRowContext();

  const imageGenAvailable = useImageGenAvailable({
    agentId: null,
    spec: context?.specName,
  });

  const imageGen = useToolToggle({
    conversationId: context?.conversationId,
    toolKey: 'image_gen',
    localStorageKey: LocalStorageKeys.LAST_IMAGE_GEN_TOGGLE_,
    isAuthenticated: true,
  });
  const { isPinned: isImageGenPinned, setIsPinned: setIsImageGenPinned } = imageGen;

  const handleImageGenToggle = useCallback(() => {
    const newValue = !imageGen.toggleState;
    imageGen.debouncedChange({ value: newValue });
  }, [imageGen]);

  const extraItems = useMemo<MenuItemProps[]>(() => {
    if (!imageGenAvailable) {
      return [];
    }
    return [
      {
        onClick: handleImageGenToggle,
        hideOnClick: false,
        render: (props) => (
          <div {...props}>
            <div className="flex items-center gap-2">
              <ImageIcon className="icon-md" aria-hidden="true" />
              <span>{localize('com_knauf_create_image')}</span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsImageGenPinned?.(!isImageGenPinned);
              }}
              className={cn(
                'rounded p-1 transition-all duration-200',
                'hover:bg-surface-secondary hover:shadow-sm',
                !isImageGenPinned && 'text-text-secondary hover:text-text-primary',
              )}
              aria-label={isImageGenPinned ? 'Unpin' : 'Pin'}
            >
              <div className="h-4 w-4">
                <PinIcon unpin={isImageGenPinned} />
              </div>
            </button>
          </div>
        ),
      },
    ];
  }, [imageGenAvailable, handleImageGenToggle, isImageGenPinned, setIsImageGenPinned, localize]);

  return <ToolsDropdown disabled={disabled} extraItems={extraItems} />;
};

export default KnaufToolsDropdown;

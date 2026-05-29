/**
 * [knauf] Per-chat image-generation chip.
 *
 * The menu item that flips the toggle now lives in the upstream
 * `ToolsDropdown` popover (one Settings2 icon, all tools inside). This
 * component only renders the pinned/toggled CheckboxButton chip in the
 * composer row. Visibility is delegated to `useImageGenAvailable` so the
 * policy (kill switch, custom-agent always-hidden, default-spec branch)
 * lives in one place; the chip and the popover item share Recoil state via
 * `useToolToggle('image_gen')`.
 *
 * KK20-168.
 */
import { memo } from 'react';
import { ImageIcon } from 'lucide-react';
import { CheckboxButton } from '@librechat/client';
import { LocalStorageKeys } from 'librechat-data-provider';
import { useToolToggle, useLocalize } from '~/hooks';
import { useImageGenAvailable } from '~/knauf/hooks/Chat/useImageGenAvailable';

interface KnaufImageGenToolsProps {
  agentId?: string | null;
  conversationId?: string | null;
  spec?: string | null;
}

function KnaufImageGenTools({ agentId, conversationId, spec }: Readonly<KnaufImageGenToolsProps>) {
  const localize = useLocalize();
  const available = useImageGenAvailable({ agentId, spec });

  const imageGen = useToolToggle({
    conversationId,
    toolKey: 'image_gen',
    localStorageKey: LocalStorageKeys.LAST_IMAGE_GEN_TOGGLE_,
    isAuthenticated: true,
  });

  const { toggleState, debouncedChange, isPinned } = imageGen;
  const enabled = toggleState === true;

  if (!available) return null;
  if (!enabled && !isPinned) return null;

  return (
    <CheckboxButton
      className="max-w-fit"
      checked={enabled}
      setValue={debouncedChange}
      label={localize('com_knauf_create_image')}
      isCheckedClassName="border-green-600/40 bg-green-500/10 hover:bg-green-700/10"
      icon={<ImageIcon className="icon-md" />}
    />
  );
}

export default memo(KnaufImageGenTools);

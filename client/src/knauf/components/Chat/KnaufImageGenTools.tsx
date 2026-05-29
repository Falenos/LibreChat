/**
 * [knauf] Per-chat image-generation toggle.
 *
 * Visibility is delegated to `useImageGenAvailable`, which encodes the
 * three-branch policy: global kill switch via `interface.knauf.imageGen`,
 * custom-agent branch requires `image_gen_oai` in the agent's `tools`,
 * default-spec branch is universally eligible when a Knauf model spec is
 * active. Default per-conversation state is OFF — the user must explicitly
 * enable image gen each chat. The backend gate in `loadAgent` /
 * `loadEphemeralAgent` strips `image_gen_oai` / `image_edit_oai` when the
 * per-chat toggle is OFF.
 *
 * UX mirrors upstream's File Search: a Settings2 icon next to the
 * paperclip opens a popover with one "Create image" row + pin button.
 * Pinning promotes a CheckboxButton chip into the composer, which the
 * user clicks to flip the per-chat toggle.
 */
import { useState, useCallback, memo, type HTMLAttributes } from 'react';
import * as Ariakit from '@ariakit/react';
import { ImageIcon, Settings2 } from 'lucide-react';
import { CheckboxButton, DropdownPopup, PinIcon, TooltipAnchor } from '@librechat/client';
import { LocalStorageKeys } from 'librechat-data-provider';
import { useToolToggle, useLocalize } from '~/hooks';
import { useImageGenAvailable } from '~/knauf/hooks/Chat/useImageGenAvailable';
import { cn } from '~/utils';

interface KnaufImageGenToolsProps {
  agentId?: string | null;
  conversationId?: string | null;
  spec?: string | null;
}

function KnaufImageGenTools({ agentId, conversationId, spec }: Readonly<KnaufImageGenToolsProps>) {
  const localize = useLocalize();
  const available = useImageGenAvailable({ agentId, spec });

  // Hook order must stay stable across renders — call the toggle hook before
  // any conditional early-return below.
  const imageGen = useToolToggle({
    conversationId,
    toolKey: 'image_gen',
    localStorageKey: LocalStorageKeys.LAST_IMAGE_GEN_TOGGLE_,
    isAuthenticated: true,
  });
  const [popoverOpen, setPopoverOpen] = useState(false);

  const { toggleState, debouncedChange, isPinned, setIsPinned } = imageGen;
  const enabled = toggleState === true;

  const handleToggle = useCallback(() => {
    debouncedChange({ value: !enabled });
  }, [debouncedChange, enabled]);

  if (!available) {
    return null;
  }

  const popoverItems = [
    {
      onClick: handleToggle,
      hideOnClick: false,
      render: (props: HTMLAttributes<HTMLDivElement>) => (
        <div {...props}>
          <div className="flex items-center gap-2">
            <ImageIcon className="icon-md" aria-hidden="true" />
            <span>{localize('com_knauf_create_image')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsPinned?.(!isPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isPinned ? 'Unpin' : 'Pin'}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isPinned} />
            </div>
          </button>
        </div>
      ),
    },
  ];

  const menuTrigger = (
    <TooltipAnchor
      id="knauf-imagegen-button"
      description={localize('com_knauf_create_image')}
      render={
        <Ariakit.MenuButton
          id="knauf-imagegen-button"
          aria-label={localize('com_knauf_create_image')}
          className={cn(
            'flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-opacity-50',
            popoverOpen && 'bg-surface-hover',
          )}
        >
          <Settings2 className="size-5" aria-hidden="true" />
        </Ariakit.MenuButton>
      }
    />
  );

  return (
    <>
      <DropdownPopup
        itemClassName="flex w-full cursor-pointer rounded-lg items-center justify-between hover:bg-surface-hover gap-5"
        menuId="knauf-imagegen-popover"
        isOpen={popoverOpen}
        setIsOpen={setPopoverOpen}
        modal={true}
        unmountOnHide={true}
        trigger={menuTrigger}
        items={popoverItems}
        iconClassName="mr-0"
      />
      {(enabled || isPinned) && (
        <CheckboxButton
          className="max-w-fit"
          checked={enabled}
          setValue={debouncedChange}
          label={localize('com_knauf_create_image')}
          isCheckedClassName="border-green-600/40 bg-green-500/10 hover:bg-green-700/10"
          icon={<ImageIcon className="icon-md" />}
        />
      )}
    </>
  );
}

export default memo(KnaufImageGenTools);

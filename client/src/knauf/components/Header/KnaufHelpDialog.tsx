import type { MutableRefObject } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { useLocalize } from '~/hooks';

type KnaufHelpDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: MutableRefObject<HTMLButtonElement | null>;
}>;

export default function KnaufHelpDialog({ open, onOpenChange, triggerRef }: KnaufHelpDialogProps) {
  const localize = useLocalize();

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="h-[85vh] w-11/12 max-w-5xl">
        <OGDialogHeader>
          <OGDialogTitle className="sr-only">{localize('com_nav_karl_help')}</OGDialogTitle>
        </OGDialogHeader>
        <iframe
          src="/help/index.html"
          title={localize('com_nav_karl_help')}
          className="mt-4 h-[calc(85vh-6rem)] w-full rounded-md border border-border-light bg-white"
        />
      </OGDialogContent>
    </OGDialog>
  );
}

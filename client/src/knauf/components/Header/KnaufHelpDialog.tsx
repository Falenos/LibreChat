import { useContext, type MutableRefObject } from 'react';
import {
  ThemeContext,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  isDark,
} from '@librechat/client';
import { useLocalize } from '~/hooks';

type KnaufHelpDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: MutableRefObject<HTMLButtonElement | null>;
}>;

export default function KnaufHelpDialog({ open, onOpenChange, triggerRef }: KnaufHelpDialogProps) {
  const localize = useLocalize();
  const { theme } = useContext(ThemeContext);
  const helpTheme = isDark(theme) ? 'dark' : 'light';

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="h-[85vh] w-11/12 max-w-5xl border-border-light bg-surface-primary text-text-primary">
        <OGDialogHeader>
          <OGDialogTitle className="sr-only">{localize('com_nav_karl_help')}</OGDialogTitle>
        </OGDialogHeader>
        <iframe
          src={`/help/index.html?theme=${helpTheme}`}
          title={localize('com_nav_karl_help')}
          className="mt-4 h-[calc(85vh-6rem)] w-full rounded-md border border-border-light bg-surface-primary"
        />
      </OGDialogContent>
    </OGDialog>
  );
}

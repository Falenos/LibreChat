/**
 * ✦ Auto-generate / Polish & expand button next to the instructions
 * textarea. Calls POST /api/knauf/draft-instructions via
 * `useDraftInstructions`. Visual style mirrors upstream's `+ Variables`
 * button in client/src/components/SidePanel/Agents/Instructions.tsx so
 * the two action buttons sit naturally side-by-side.
 */
import { Sparkles } from 'lucide-react';
import { cn } from '~/utils';
import { useLocalize } from '~/hooks';

export default function AutoGenerateButton({
  hasDraft,
  drafting,
  disabled,
  onClick,
  labelClassName,
}: Readonly<{
  hasDraft: boolean;
  drafting: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** Extra classes on the text label — e.g. `"hidden sm:inline"` to hide on mobile. */
  labelClassName?: string;
}>) {
  const localize = useLocalize();

  let label: string;
  if (drafting) {
    label = localize('com_knauf_prompt_drafting');
  } else if (hasDraft) {
    label = localize('com_knauf_prompt_polish');
  } else {
    label = localize('com_knauf_prompt_generate');
  }

  let title: string;
  if (drafting) {
    title = localize('com_knauf_prompt_drafting');
  } else if (hasDraft) {
    title = localize('com_knauf_prompt_polish_title');
  } else {
    title = localize('com_knauf_prompt_generate_title');
  }

  const inert = drafting || disabled;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inert}
      title={title}
      className={cn(
        'flex h-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border-medium bg-surface-secondary px-2 text-sm text-text-primary transition-colors',
        inert ? 'cursor-not-allowed opacity-70' : 'hover:bg-surface-tertiary',
      )}
    >
      {drafting ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <Sparkles className="h-3 w-3 text-text-secondary" aria-hidden />
      )}
      <span className={labelClassName}>{label}</span>
    </button>
  );
}

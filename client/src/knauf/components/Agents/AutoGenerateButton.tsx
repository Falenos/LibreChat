/**
 * ✦ Auto-generate / Polish & expand button next to the instructions
 * textarea. Calls POST /api/knauf/draft-instructions via
 * `useDraftInstructions`. Visual style mirrors upstream's `+ Variables`
 * button in client/src/components/SidePanel/Agents/Instructions.tsx so
 * the two action buttons sit naturally side-by-side.
 */
import { Sparkles } from 'lucide-react';
import { cn } from '~/utils';

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
  // Short labels that fit comfortably even when the side panel is at its
  // narrow setting. The Sparkles icon plus the title attribute carry the
  // long-form meaning when needed.
  let label: string;
  if (drafting) {
    label = 'Drafting…';
  } else if (hasDraft) {
    label = 'Polish';
  } else {
    label = 'Generate';
  }

  let title: string;
  if (drafting) {
    title = 'Drafting…';
  } else if (hasDraft) {
    title = 'Polish what you wrote, using the personality and skills above.';
  } else {
    title = 'KARL will draft instructions for you. You can keep editing after.';
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

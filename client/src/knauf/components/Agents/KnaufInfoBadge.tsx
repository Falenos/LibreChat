/**
 * Small "i" badge that reveals an explanatory tooltip on hover/focus.
 *
 * Uses Radix HoverCard (already a dep) instead of the native `title`
 * attribute — the native tooltip is unreliable (browser-styled, slow to
 * appear, doesn't render in some contexts). HoverCard portals the tooltip
 * out of the side panel, applies LibreChat's surface tokens, and shows
 * promptly on hover or keyboard focus.
 */
import * as HoverCard from '@radix-ui/react-hover-card';

export default function KnaufInfoBadge({ tip }: Readonly<{ tip: string }>) {
  return (
    <HoverCard.Root openDelay={120} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          aria-label="Info"
          className="inline-flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-border-light text-[9px] font-bold leading-none text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary focus:border-text-primary focus:text-text-primary focus:outline-none"
        >
          i
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          sideOffset={6}
          align="center"
          collisionPadding={8}
          className="z-[1100] max-w-[260px] rounded-md border border-border-light bg-surface-primary px-3 py-2 text-xs leading-snug text-text-secondary shadow-lg"
        >
          {tip}
          <HoverCard.Arrow className="fill-border-light" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/**
 * 3-pill toggle group for personality. Pills source labels and tooltips from
 * upstream's `modelSpecs.list` (filtered to `karl-personality-*` entries
 * by usePersonalities). Active state uses upstream's `bg-surface-active-alt`
 * with a heavier border — same neutral-tinted "selected" treatment used in
 * other LibreChat side panels (no Knauf brand colour).
 *
 * Each pill shows the personality's model name in a small monospace caption
 * underneath the label, so admins always know which deployment each
 * personality maps to.
 */
import { cn } from '~/utils';
import type { KnaufPersonality } from '~/knauf/common/agents-types';

export default function PersonalityPills({
  personalities,
  value,
  onChange,
}: Readonly<{
  personalities: KnaufPersonality[];
  value: string;
  onChange: (name: string) => void;
}>) {
  if (personalities.length === 0) {
    return null;
  }

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${personalities.length}, 1fr)` }}
    >
      {personalities.map((p) => {
        const on = value === p.name;
        const model = typeof p.preset?.model === 'string' ? p.preset.model : null;
        return (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.name)}
            title={p.description}
            aria-pressed={on}
            className={cn(
              'flex flex-col items-center gap-0.5 rounded-md border px-3 py-2 text-center text-sm font-medium transition-colors',
              on
                ? 'border-border-heavy bg-surface-active-alt text-text-primary'
                : 'border-border-light text-text-primary hover:border-border-medium hover:bg-surface-secondary',
            )}
          >
            <span>{p.label}</span>
            {model ? (
              <span className="font-mono text-[11px] font-normal text-text-tertiary">
                {model}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

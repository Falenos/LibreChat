/**
 * Single-row capability toggle. Inherits the panel surface (no fill);
 * hover reveals a subtle `bg-surface-secondary` like upstream's
 * MemoryCard / BookmarkCard rows. Uses upstream's `<Switch>` primitive.
 */
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { Switch } from '@librechat/client';
import { cn } from '~/utils';

export default function CapabilitySwitch({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      aria-pressed={checked}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-colors hover:bg-surface-secondary',
        checked ? 'border-border-medium' : 'border-border-light hover:border-border-medium',
      )}
    >
      <div
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors',
          checked
            ? 'bg-surface-active-alt text-text-primary'
            : 'bg-surface-tertiary text-text-secondary',
        )}
      >
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="mt-0.5 text-xs leading-snug text-text-secondary">
          {description}
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
        <Switch
          checked={checked}
          onCheckedChange={(next) => onChange(!!next)}
          aria-label={label}
        />
      </div>
    </div>
  );
}

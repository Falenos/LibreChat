/**
 * Single-row capability toggle. Inherits the panel surface (no fill);
 * hover reveals a subtle `bg-surface-secondary` like upstream's
 * MemoryCard / BookmarkCard rows. Uses upstream's `<Switch>` primitive.
 */
import { useId, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { Switch } from '@librechat/client';
import { cn } from '~/utils';

export default function CapabilitySwitch({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
  disabled,
}: Readonly<{
  icon: ComponentType<LucideProps>;
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}>) {
  const switchId = useId();

  /**
   * Build the row's container className without nested ternaries: pick the
   * cursor + border + hover treatment per (disabled, checked) state.
   */
  let containerStateClass: string;
  if (disabled) {
    containerStateClass = 'cursor-not-allowed border-border-light opacity-60';
  } else if (checked) {
    containerStateClass = 'cursor-pointer border-border-medium hover:bg-surface-secondary';
  } else {
    containerStateClass =
      'cursor-pointer border-border-light hover:border-border-medium hover:bg-surface-secondary';
  }

  return (
    <label
      htmlFor={switchId}
      className={cn(
        'flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors',
        containerStateClass,
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
        <div className="mt-0.5 text-xs leading-snug text-text-secondary">{description}</div>
      </div>
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={(next) => onChange(!!next)}
        aria-label={label}
        disabled={disabled}
        className="flex-shrink-0"
      />
    </label>
  );
}

/** Template selection grid for the agent builder instructions field. */
import { FileText } from 'lucide-react';
import { usePromptTemplates } from '~/knauf/data-provider/Agents/usePromptTemplates';
import type { PromptTemplate } from '~/knauf/data-provider/data-service';
import { cn } from '~/utils';

export default function TemplatePicker({
  onSelect,
  compact,
  activeTemplateId,
}: Readonly<{
  /** Called when user picks a template. */
  onSelect: (template: PromptTemplate) => void;
  /** Compact layout for the overlay's collapsible panel. */
  compact?: boolean;
  /** ID of the currently applied template (highlighted in the grid). */
  activeTemplateId?: string | null;
}>) {
  const { data, isLoading } = usePromptTemplates();
  const templates = data?.templates ?? [];

  if (isLoading) {
    return (
      <p className="py-4 text-center text-xs text-text-tertiary">
        Loading templates…
      </p>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-text-tertiary">
        No templates configured.
      </p>
    );
  }

  return (
    <div>
      {!compact && (
        <p className="mb-2 text-xs text-text-secondary">
          Pick a template to get started, or write your own below.
        </p>
      )}
      <div
        className={cn(
          'grid gap-2',
          compact ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5' : 'grid-cols-1',
        )}
      >
        {templates.map((t) => {
          const isActive = activeTemplateId === t.id;
          return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t)}
            className={cn(
              'group flex items-start gap-2 rounded-lg border p-3 text-left transition-colors',
              compact && 'flex-col items-center text-center',
              isActive
                ? 'border-green-500 bg-green-500/10 ring-1 ring-green-500/30'
                : 'border-border-light bg-surface-secondary hover:border-border-heavy hover:bg-surface-tertiary',
            )}
          >
            <FileText
              className={cn(
                'mt-0.5 h-4 w-4 flex-shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary',
                compact && 'mt-0',
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary">{t.label}</div>
              <div
                className={cn(
                  'mt-0.5 text-xs leading-snug text-text-secondary',
                  compact && 'line-clamp-2',
                )}
              >
                {t.description}
              </div>
            </div>
          </button>
          );
        })}
      </div>
    </div>
  );
}

/** Compact dropdown for template selection in the sidebar. */
import { LayoutTemplate } from 'lucide-react';
import { usePromptTemplates } from '~/knauf/data-provider/Agents/usePromptTemplates';
import type { PromptTemplate } from '~/knauf/data-provider/data-service';
import { cn, defaultTextProps, removeFocusOutlines } from '~/utils';

export default function TemplateSelect({
  onSelect,
}: Readonly<{
  onSelect: (template: PromptTemplate) => void;
}>) {
  const { data, isLoading } = usePromptTemplates();
  const templates = data?.templates ?? [];

  if (isLoading || templates.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <LayoutTemplate className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" aria-hidden />
      <select
        aria-label="Pick a template"
        defaultValue=""
        onChange={(e) => {
          const t = templates.find((t) => t.id === e.target.value);
          if (t) onSelect(t);
          // Reset so the same template can be re-selected
          e.target.value = '';
        }}
        className={cn(
          defaultTextProps,
          removeFocusOutlines,
          'h-8 w-full cursor-pointer rounded-md border border-border-light bg-surface-secondary px-2 text-sm text-text-primary',
          'focus-visible:ring-2 focus-visible:ring-ring-primary',
        )}
      >
        <option value="" disabled>
          Pick a template…
        </option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label} — {t.description}
          </option>
        ))}
      </select>
    </div>
  );
}

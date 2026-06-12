/** Compact combobox for template selection in the sidebar.
 *  Uses ControlCombobox to match the AgentCategorySelector styling. */
import { useEffect, useRef, useState } from 'react';
import { ControlCombobox } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { usePromptTemplates } from '~/knauf/data-provider/Agents/usePromptTemplates';
import type { PromptTemplate } from '~/knauf/data-provider/data-service';

export default function TemplateSelect({
  onSelect,
  loading,
}: Readonly<{
  onSelect: (template: PromptTemplate) => void;
  /** Show a loading indicator (e.g. while auto-applying a template). */
  loading?: boolean;
}>) {
  const localize = useLocalize();
  const { data, isLoading } = usePromptTemplates();
  const templates = data?.templates ?? [];
  const [selectedValue, setSelectedValue] = useState('');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  if (isLoading || templates.length === 0) return null;

  const items = templates.map((tpl) => ({
    label: tpl.label,
    value: tpl.id,
  }));

  return (
    <ControlCombobox
      selectedValue={selectedValue}
      displayValue={loading ? localize('com_knauf_prompt_applying_template') : localize('com_knauf_prompt_pick_template')}
      searchPlaceholder={localize('com_knauf_prompt_search_templates')}
      setValue={(value) => {
        const match = templates.find((tpl) => tpl.id === value);
        if (match) {
          setSelectedValue(value);
          onSelect(match);
          // Reset after a brief moment so the same template can be re-selected
          clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(() => setSelectedValue(''), 300);
        }
      }}
      items={items}
      ariaLabel={localize('com_knauf_prompt_pick_template')}
      isCollapsed={false}
      showCarat={true}
    />
  );
}

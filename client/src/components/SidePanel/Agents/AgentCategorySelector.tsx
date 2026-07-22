import React, { memo, useCallback, useState } from 'react';
// [knauf] Custom-category mutation and cache integration.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ControlCombobox, useToastContext } from '@librechat/client';
import { QueryKeys, SystemRoles, type TMarketplaceCategory } from 'librechat-data-provider';
import { Trash2 } from 'lucide-react';
// End [knauf]
import {
  useWatch,
  FieldPath,
  Controller,
  FieldValues,
  useFormContext,
  ControllerRenderProps,
} from 'react-hook-form';
// [knauf] Read the signed-in role to restrict custom-group creation to administrators.
import { TranslationKeys, useLocalize, useAgentCategories, useAuthContext } from '~/hooks';
// End [knauf]
// [knauf] Custom agent categories persist through the additive Knauf API.
import { deleteAgentCategory, postAgentCategory } from '~/knauf/data-provider/data-service';
// End [knauf]
import { cn } from '~/utils';

/**
 * Custom hook to handle category synchronization
 */
const useCategorySync = (agent_id: string | null) => {
  const [handled, setHandled] = useState(false);

  return {
    syncCategory: <T extends FieldPath<FieldValues>>(
      field: ControllerRenderProps<FieldValues, T>,
    ) => {
      // Only run once and only for new agents
      if (!handled && agent_id === '' && !field.value) {
        field.onChange('general');
        setHandled(true);
      }
    },
  };
};

/**
 * A component for selecting agent categories with form validation
 */
const AgentCategorySelector: React.FC<{ className?: string }> = ({ className }) => {
  const localize = useLocalize();
  // [knauf] Hide every custom-group creation entry point from non-admin users.
  const { user } = useAuthContext();
  const isAdmin = user?.role === SystemRoles.ADMIN;
  // End [knauf]
  const formContext = useFormContext();
  const { categories } = useAgentCategories();
  // [knauf] Create and cache user-named groups directly from the category search.
  const { showToast } = useToastContext();
  const queryClient = useQueryClient();
  const createCategory = useMutation(postAgentCategory, {
    onSuccess: (category) => {
      queryClient.setQueryData<TMarketplaceCategory[]>(
        [QueryKeys.agentCategories],
        (current = []) => {
          if (current.some((item) => item.value === category.value)) {
            return current;
          }
          const allCategory = current.find((item) => item.value === 'all');
          return [
            ...current.filter((item) => item.value !== 'all'),
            category,
            ...(allCategory ? [allCategory] : []),
          ];
        },
      );
      queryClient.invalidateQueries([QueryKeys.agentCategories]);
    },
  });
  // End [knauf]
  // [knauf] Remove deleted custom groups from the shared category cache.
  const deleteCategory = useMutation(deleteAgentCategory, {
    onSuccess: (_, value) => {
      queryClient.setQueryData<TMarketplaceCategory[]>(
        [QueryKeys.agentCategories],
        (current = []) => current.filter((category) => category.value !== value),
      );
      queryClient.invalidateQueries([QueryKeys.agentCategories]);
      showToast({ message: localize('com_ui_deleted'), status: 'success' });
    },
  });
  // End [knauf]

  const agent_id = useWatch({
    name: 'id',
    control: formContext.control,
  });

  const { syncCategory } = useCategorySync(agent_id);
  const getCategoryLabel = (category: { label: string; value: string }) => {
    if (category.label && category.label.startsWith('com_')) {
      return localize(category.label as TranslationKeys);
    }
    return category.label;
  };

  const comboboxItems = categories.map((category) => ({
    label: getCategoryLabel(category),
    value: category.value,
  }));

  const getCategoryDisplayValue = (value: string) => {
    const categoryItem = comboboxItems.find((c) => c.value === value);
    return categoryItem?.label || comboboxItems.find((c) => c.value === 'general')?.label;
  };

  const searchPlaceholder = localize('com_ui_search_agent_category');
  const ariaLabel = localize('com_ui_agent_category_selector_aria');
  // [knauf] Keep creatable-option copy stable for the memoized combobox.
  const getCreateLabel = useCallback(
    (value: string) => localize('com_knauf_create_agent_group', { 0: value }),
    [localize],
  );
  // End [knauf]

  return (
    <Controller
      name="category"
      control={formContext.control}
      defaultValue="general"
      render={({ field }) => {
        // Sync category if needed (without using useEffect in render)
        syncCategory(field);

        const displayValue = getCategoryDisplayValue(field.value);
        // [knauf] Resolve whether the selected group is custom and therefore admin-deletable.
        const selectedCategory = categories.find((category) => category.value === field.value);
        const selectedCategoryLabel = selectedCategory
          ? getCategoryLabel(selectedCategory)
          : displayValue;
        // End [knauf]

        return (
          <>
            {/* [knauf] Turn an unmatched search into a localized create-group option. */}
            <ControlCombobox
              selectedValue={field.value}
              displayValue={displayValue}
              searchPlaceholder={searchPlaceholder}
              setValue={(value) => {
                if (comboboxItems.some((item) => item.value === value)) {
                  field.onChange(value);
                  return;
                }

                createCategory
                  .mutateAsync({ label: value })
                  .then((category) => field.onChange(category.value))
                  .catch(() =>
                    showToast({
                      message: localize('com_knauf_create_agent_group_error'),
                      status: 'error',
                    }),
                  );
              }}
              items={comboboxItems}
              className={cn(className)}
              ariaLabel={ariaLabel}
              isCollapsed={false}
              showCarat={true}
              createPromptLabel={
                isAdmin ? localize('com_knauf_create_agent_group_prompt') : undefined
              }
              createInputPlaceholder={isAdmin ? localize('com_ui_name') : undefined}
              createSaveLabel={isAdmin ? localize('com_ui_save') : undefined}
              getCreateLabel={isAdmin ? getCreateLabel : undefined}
            />
            {/* End [knauf] */}
            {/* [knauf] Let administrators delete only unused custom groups. */}
            {isAdmin && selectedCategory?.custom === true && (
              <button
                type="button"
                disabled={deleteCategory.isLoading}
                aria-label={localize('com_knauf_delete_agent_group', {
                  0: selectedCategoryLabel,
                })}
                title={localize('com_knauf_delete_agent_group', { 0: selectedCategoryLabel })}
                onClick={() => {
                  if (
                    !window.confirm(
                      localize('com_knauf_delete_agent_group_confirm', {
                        0: selectedCategoryLabel,
                      }),
                    )
                  ) {
                    return;
                  }
                  deleteCategory.mutate(selectedCategory.value, {
                    onSuccess: () => field.onChange('general'),
                    onError: () =>
                      showToast({
                        message: localize('com_knauf_delete_agent_group_error', {
                          0: selectedCategoryLabel,
                        }),
                        status: 'error',
                      }),
                  });
                }}
                className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                <span>
                  {localize('com_knauf_delete_agent_group', { 0: selectedCategoryLabel })}
                </span>
              </button>
            )}
            {/* End [knauf] */}
          </>
        );
      }}
    />
  );
};

const MemoizedAgentCategorySelector = memo(
  AgentCategorySelector,
  (prevProps, nextProps) => prevProps.className === nextProps.className,
);
MemoizedAgentCategorySelector.displayName = 'AgentCategorySelector';

export default MemoizedAgentCategorySelector;

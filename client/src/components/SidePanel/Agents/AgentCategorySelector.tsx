import React, { memo, useCallback, useState } from 'react';
// [knauf] Custom-category mutation and cache integration.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ControlCombobox, useToastContext } from '@librechat/client';
import { QueryKeys, SystemRoles, type TMarketplaceCategory } from 'librechat-data-provider';
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
  const { mutate: deleteCategory, isLoading: isDeletingCategory } = useMutation(
    deleteAgentCategory,
    {
      onSuccess: (_, value) => {
        queryClient.setQueryData<TMarketplaceCategory[]>(
          [QueryKeys.agentCategories],
          (current = []) => current.filter((category) => category.value !== value),
        );
        queryClient.invalidateQueries([QueryKeys.agentCategories]);
        if (formContext.getValues('category') === value) {
          formContext.setValue('category', 'general');
        }
        showToast({ message: localize('com_ui_deleted'), status: 'success' });
      },
      onError: (_, value) => {
        const category = categories.find((item) => item.value === value);
        const label =
          category?.label && category.label.startsWith('com_')
            ? localize(category.label as TranslationKeys)
            : (category?.label ?? value);
        showToast({
          message: localize('com_knauf_delete_agent_group_error', {
            0: label,
          }),
          status: 'error',
        });
      },
    },
  );
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
  // [knauf] Expose stable admin-only delete controls to custom-group option rows.
  const isCategoryDeletable = useCallback(
    (value: string) => categories.some((category) => category.value === value && category.custom),
    [categories],
  );
  const getDeleteItemLabel = useCallback(
    (label: string) => localize('com_knauf_delete_agent_group', { 0: label }),
    [localize],
  );
  const handleDeleteCategory = useCallback(
    (value: string) => {
      const category = categories.find((item) => item.value === value);
      if (!isAdmin || category?.custom !== true) {
        return;
      }
      const label = category.label.startsWith('com_')
        ? localize(category.label as TranslationKeys)
        : category.label;
      if (!window.confirm(localize('com_knauf_delete_agent_group_confirm', { 0: label }))) {
        return;
      }
      deleteCategory(value);
    },
    [categories, deleteCategory, isAdmin, localize],
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
              isItemDeletable={isAdmin ? isCategoryDeletable : undefined}
              onDeleteItem={isAdmin ? handleDeleteCategory : undefined}
              getDeleteItemLabel={isAdmin ? getDeleteItemLabel : undefined}
              deleteItemDisabled={isDeletingCategory}
            />
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

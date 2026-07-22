import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { QueryKeys, SystemRoles } from 'librechat-data-provider';

const mockPostAgentCategory = jest.fn();
const mockDeleteAgentCategory = jest.fn();
const mockShowToast = jest.fn();
let selectedCategory = '';
let mockUserRole = SystemRoles.ADMIN;
let mockCategories: Array<{ value: string; label: string; custom?: boolean }> = [];

jest.mock('@librechat/client', () => ({
  ControlCombobox: ({
    setValue,
    createPromptLabel,
    createInputPlaceholder,
    createSaveLabel,
    getCreateLabel,
    items,
  }: {
    setValue: (value: string) => void;
    createPromptLabel?: string;
    createInputPlaceholder?: string;
    createSaveLabel?: string;
    getCreateLabel?: (value: string) => string;
    items: Array<{ value: string; label?: string }>;
  }) => (
    <>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-label={`select-${item.value}`}
          onClick={() => setValue(item.value)}
        />
      ))}
      {createPromptLabel && createInputPlaceholder && createSaveLabel && (
        <>
          <span>{createPromptLabel}</span>
          <input aria-label={createInputPlaceholder} readOnly />
          <button type="button">{createSaveLabel}</button>
        </>
      )}
      {getCreateLabel && (
        <button type="button" onClick={() => setValue('Field Operations')}>
          {getCreateLabel('Field Operations')}
        </button>
      )}
    </>
  ),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { role: mockUserRole } }),
  useAgentCategories: () => ({
    categories: mockCategories,
  }),
  useLocalize: () => (key: string, values?: Record<number, string>) => {
    if (key === 'com_knauf_create_agent_group') {
      return `Create group “${values?.[0]}”`;
    }
    return (
      {
        com_knauf_create_agent_group_prompt: 'Create new group',
        com_knauf_delete_agent_group: `Delete group “${values?.[0]}”`,
        com_knauf_delete_agent_group_confirm: `Delete group “${values?.[0]}”?`,
        com_knauf_delete_agent_group_error: `Couldn't delete “${values?.[0]}”.`,
        com_ui_name: 'Name',
        com_ui_save: 'Save',
        com_ui_deleted: 'Deleted',
      }[key] ?? key
    );
  },
}));

jest.mock('~/knauf/data-provider/data-service', () => ({
  postAgentCategory: (...args: unknown[]) => mockPostAgentCategory(...args),
  deleteAgentCategory: (...args: unknown[]) => mockDeleteAgentCategory(...args),
}));

import AgentCategorySelector from '~/components/SidePanel/Agents/AgentCategorySelector';

function FormHarness() {
  const methods = useForm({ defaultValues: { id: '', category: 'general' } });
  selectedCategory = methods.watch('category');
  return (
    <FormProvider {...methods}>
      <AgentCategorySelector />
    </FormProvider>
  );
}

describe('AgentCategorySelector custom groups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectedCategory = '';
    mockUserRole = SystemRoles.ADMIN;
    mockCategories = [{ value: 'general', label: 'General', custom: false }];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates, caches, and selects an unmatched searched group', async () => {
    const category = {
      value: 'custom_field_ops',
      label: 'Field Operations',
      custom: true,
      count: 0,
    };
    mockPostAgentCategory.mockResolvedValue(category);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const general = { value: 'general', label: 'General', count: 0 };
    const all = { value: 'all', label: 'All', count: 0 };
    queryClient.setQueryData([QueryKeys.agentCategories], [general, all]);

    render(
      <QueryClientProvider client={queryClient}>
        <FormHarness />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Create new group')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create group “Field Operations”' }));

    await waitFor(() =>
      expect(mockPostAgentCategory).toHaveBeenCalledWith({ label: 'Field Operations' }),
    );
    await waitFor(() => expect(selectedCategory).toBe('custom_field_ops'));
    expect(queryClient.getQueryData([QueryKeys.agentCategories])).toEqual([general, category, all]);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('selects a known category without creating another group', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <FormHarness />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-general' }));

    expect(selectedCategory).toBe('general');
    expect(mockPostAgentCategory).not.toHaveBeenCalled();
  });

  it('hides every group-creation entry point from non-admin users', () => {
    mockUserRole = SystemRoles.USER;
    mockCategories.push({
      value: 'custom_field_ops',
      label: 'Field Operations',
      custom: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <FormHarness />
      </QueryClientProvider>,
    );

    expect(screen.queryByText('Create new group')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create group “Field Operations”' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'select-custom_field_ops' }));
    expect(
      screen.queryByRole('button', { name: 'Delete group “Field Operations”' }),
    ).not.toBeInTheDocument();
  });

  it('lets an admin delete an unused custom group and resets to General', async () => {
    mockCategories.push({
      value: 'custom_field_ops',
      label: 'Field Operations',
      custom: true,
    });
    mockDeleteAgentCategory.mockResolvedValue(undefined);
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.agentCategories], mockCategories);

    render(
      <QueryClientProvider client={queryClient}>
        <FormHarness />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-custom_field_ops' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete group “Field Operations”' }));

    expect(confirm).toHaveBeenCalledWith('Delete group “Field Operations”?');
    await waitFor(() => expect(mockDeleteAgentCategory).toHaveBeenCalledWith('custom_field_ops'));
    await waitFor(() => expect(selectedCategory).toBe('general'));
    expect(queryClient.getQueryData([QueryKeys.agentCategories])).toEqual([
      { value: 'general', label: 'General', custom: false },
    ]);
  });
});

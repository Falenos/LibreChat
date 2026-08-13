import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import { PermissionBits } from 'librechat-data-provider';

const mockCreate = jest.fn();
const mockFetchNextPage = jest.fn();
const mockUseListAgentsQuery = jest.fn(() => ({
  data: [{ id: 'agent-1', name: 'Agent One' }],
}));
let mockHasNextPage = false;
let mockProjectCreated: ((project: { _id: string; name: string }) => void) | undefined;

jest.mock('uuid', () => ({ v4: () => 'request-1' }));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  ControlCombobox: ({
    ariaLabel,
    items,
    selectedValue,
    setValue,
  }: Readonly<{
    ariaLabel: string;
    items: Array<{ label: string; value: string }>;
    selectedValue: string;
    setValue: (value: string) => void;
  }>) => (
    <select
      aria-label={ariaLabel}
      value={selectedValue}
      onChange={(event) => setValue(event.target.value)}
    >
      <option value="" />
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  Dropdown: () => <div />,
  Input: 'input',
  Label: ({ children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  OGDialog: ({ children }: Readonly<{ children: ReactNode }>) => children,
  OGDialogTemplate: ({ main, buttons }: Readonly<{ main: ReactNode; buttons: ReactNode }>) => (
    <>
      {main}
      {buttons}
    </>
  ),
  Spinner: () => <div />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: (...args: unknown[]) => mockUseListAgentsQuery(...args),
  useProjectsInfiniteQuery: () => ({
    data: { pages: [{ projects: [{ _id: 'project-1', name: 'Project One' }] }] },
    fetchNextPage: mockFetchNextPage,
    hasNextPage: mockHasNextPage,
    isFetchingNextPage: false,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Projects/ProjectCreateDialog', () => ({
  __esModule: true,
  default: ({
    open,
    onCreated,
  }: Readonly<{
    open: boolean;
    onCreated?: (project: { _id: string; name: string }) => void;
  }>) => {
    mockProjectCreated = onCreated;
    return open ? <div>project-create-dialog</div> : null;
  },
}));

jest.mock('~/knauf/data-provider/Schedules', () => ({
  useCreateScheduleMutation: () => ({ isLoading: false, mutate: mockCreate }),
  useUpdateScheduleMutation: () => ({ isLoading: false, mutate: jest.fn() }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

import ScheduleDialog from './ScheduleDialog';

describe('ScheduleDialog project selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasNextPage = false;
    mockProjectCreated = undefined;
  });

  test('loads every project page while the dialog is open', async () => {
    mockHasNextPage = true;
    render(<ScheduleDialog open={true} onOpenChange={jest.fn()} />);

    await waitFor(() => expect(mockFetchNextPage).toHaveBeenCalledTimes(1));
  });

  test('lists Agents the user may view rather than only Agents they may edit', () => {
    render(<ScheduleDialog open={true} onOpenChange={jest.fn()} />);

    expect(mockUseListAgentsQuery).toHaveBeenCalledWith(
      { requiredPermission: PermissionBits.VIEW },
      expect.any(Object),
    );
  });

  test('requires a project and submits its id with the schedule', async () => {
    render(<ScheduleDialog open={true} onOpenChange={jest.fn()} />);

    fireEvent.change(screen.getByLabelText('com_ui_name'), {
      target: { value: 'Daily summary' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_prompt'), {
      target: { value: 'Summarize the latest updates' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_agent'), {
      target: { value: 'agent-1' },
    });

    const createButton = screen.getByRole('button', { name: 'com_ui_create' });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('com_ui_projects'), {
      target: { value: 'project-1' },
    });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-1',
          chatProjectId: 'project-1',
          clientRequestId: 'request-1',
        }),
      ),
    );
  });

  test('creates and immediately selects a project without leaving the schedule form', async () => {
    render(<ScheduleDialog open={true} onOpenChange={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create_project' }));
    expect(screen.getByText('project-create-dialog')).toBeInTheDocument();

    act(() => {
      mockProjectCreated?.({ _id: 'project-new', name: 'New Project' });
    });

    await waitFor(() =>
      expect(screen.getByLabelText('com_ui_projects')).toHaveValue('project-new'),
    );
    expect(screen.getByRole('option', { name: 'New Project' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('com_ui_name'), {
      target: { value: 'Daily summary' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_prompt'), {
      target: { value: 'Summarize the latest updates' },
    });
    fireEvent.change(screen.getByLabelText('com_ui_agent'), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_create' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ chatProjectId: 'project-new' }),
      ),
    );
  });
});

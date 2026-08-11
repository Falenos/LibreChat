import { fireEvent, render, screen } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const mockUseSchedulesQuery = jest.fn();

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  Spinner: () => <div data-testid="spinner" />,
  TooltipAnchor: ({ render: trigger }: Readonly<{ render: ReactNode }>) => trigger,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/knauf/data-provider/Schedules', () => ({
  useSchedulesQuery: () => mockUseSchedulesQuery(),
}));

jest.mock('./ScheduleCard', () => ({
  __esModule: true,
  default: ({ schedule }: Readonly<{ schedule: { name: string } }>) => (
    <div data-testid="schedule-card">{schedule.name}</div>
  ),
}));

jest.mock('./ScheduleDialog', () => ({
  __esModule: true,
  default: () => <div role="dialog" />,
}));

import SchedulePanel from './SchedulePanel';

describe('SchedulePanel', () => {
  it('does not present a false empty state when loading fails', () => {
    const refetch = jest.fn();
    mockUseSchedulesQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    render(<SchedulePanel />);
    expect(screen.getByText('com_knauf_scheduler_error')).toBeInTheDocument();
    expect(screen.queryByText('com_knauf_scheduler_empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders schedules and opens the create dialog below the configured limit', () => {
    mockUseSchedulesQuery.mockReturnValue({
      data: {
        schedules: [{ id: 'schedule-1', name: 'Daily summary' }],
        limits: { maxPerUser: 10 },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });

    render(<SchedulePanel />);
    expect(screen.getByTestId('schedule-card')).toHaveTextContent('Daily summary');

    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_scheduler_new' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disables creation when the server limit is reached', () => {
    mockUseSchedulesQuery.mockReturnValue({
      data: {
        schedules: [{ id: 'schedule-1', name: 'Daily summary' }],
        limits: { maxPerUser: 1 },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });

    render(<SchedulePanel />);
    expect(screen.getByRole('button', { name: 'com_knauf_scheduler_new' })).toBeDisabled();
  });
});

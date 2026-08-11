import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Schedule } from '~/knauf/common/schedules';

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
}));

jest.mock('react-i18next', () => ({
  Trans: () => null,
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

jest.mock('@librechat/client', () => ({
  DropdownPopup: ({ trigger }: { trigger: ReactNode }) => trigger,
  Label: ({ children }: { children: ReactNode }) => children,
  OGDialog: () => null,
  OGDialogTemplate: () => null,
  Spinner: () => null,
  Switch: ({ checked }: { checked: boolean }) => (
    <input type="checkbox" checked={checked} readOnly />
  ),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/knauf/data-provider/Schedules', () => ({
  useDeleteScheduleMutation: () => ({ mutate: jest.fn() }),
  useRunScheduleNowMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({ 'agent-1': { name: 'Agent One' } }),
}));

jest.mock('~/utils', () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(' '),
  getMessageTimestamp: () => null,
}));

jest.mock('./ScheduleDialog', () => () => null);

import ScheduleCard from './ScheduleCard';

const schedule: Schedule = {
  id: 'schedule-1',
  user: 'user-1',
  name: 'Daily summary',
  prompt: 'Summarize the day',
  agent_id: 'agent-1',
  chatProjectId: 'project-1',
  cadence: { frequency: 'daily', hour: 9, minute: 0 },
  timezone: 'Europe/Berlin',
  target: 'new',
  enabled: false,
  disabledReason: 'too_many_failures',
  runCount: 0,
  failureCount: 5,
  createdAt: '2026-05-15T10:00:00.000Z',
  updatedAt: '2026-05-15T10:00:00.000Z',
};

describe('ScheduleCard', () => {
  it('explains an automatic consecutive-failure disable', () => {
    render(<ScheduleCard schedule={schedule} />);

    expect(screen.getByText('com_knauf_scheduler_disabled_too_many_failures')).toBeInTheDocument();
  });

  it('does not render an unknown disabled reason as the known failure explanation', () => {
    render(<ScheduleCard schedule={{ ...schedule, disabledReason: 'future_reason' }} />);

    expect(
      screen.queryByText('com_knauf_scheduler_disabled_too_many_failures'),
    ).not.toBeInTheDocument();
  });
});

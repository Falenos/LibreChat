jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '/base',
  request: {
    delete: jest.fn(),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

import { request } from 'librechat-data-provider';
import {
  deleteSchedule,
  getSchedules,
  postSchedule,
  postScheduleRun,
  updateSchedule,
} from '~/knauf/data-provider/data-service';
import type { CreateSchedule, UpdateSchedule } from '~/knauf/common/schedules';

const mockRequest = jest.mocked(request);

const createPayload: CreateSchedule = {
  name: 'Daily summary',
  prompt: 'Summarize the latest updates',
  agent_id: 'agent-1',
  chatProjectId: 'project-1',
  cadence: { frequency: 'daily', hour: 9, minute: 30 },
  timezone: 'Europe/Berlin',
  target: 'new',
  enabled: true,
  clientRequestId: 'request-1',
};

describe('scheduler data service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the upstream-compatible schedules collection path', () => {
    getSchedules();
    postSchedule(createPayload);

    expect(mockRequest.get).toHaveBeenCalledWith('/base/api/schedules');
    expect(mockRequest.post).toHaveBeenCalledWith('/base/api/schedules', createPayload);
  });

  it('encodes schedule identifiers for item mutations and Run Now', () => {
    const updatePayload: UpdateSchedule = { enabled: false, expectedConfigRevision: 3 };

    updateSchedule('schedule/1', updatePayload);
    deleteSchedule('schedule/1');
    postScheduleRun('schedule/1');

    expect(mockRequest.patch).toHaveBeenCalledWith(
      '/base/api/schedules/schedule%2F1',
      updatePayload,
    );
    expect(mockRequest.delete).toHaveBeenCalledWith('/base/api/schedules/schedule%2F1');
    expect(mockRequest.post).toHaveBeenCalledWith('/base/api/schedules/schedule%2F1/run', {});
  });
});

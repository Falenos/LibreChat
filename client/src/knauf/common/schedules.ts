export const scheduleFrequencies = ['hourly', 'daily', 'weekdays', 'weekly'] as const;

export type ScheduleFrequency = (typeof scheduleFrequencies)[number];
export type ScheduleTarget = 'new';
export type ScheduleRunStatus = 'started' | 'success' | 'error' | 'interrupted';
export type ScheduleDisabledReason = 'too_many_failures' | (string & {});

export type ScheduleCadence = {
  frequency: ScheduleFrequency;
  hour: number;
  minute: number;
  daysOfWeek?: number[];
};

export type ScheduleLastRun = {
  conversationId?: string;
  status: ScheduleRunStatus;
  error?: string;
  firedAt: string;
};

export type Schedule = {
  id: string;
  user: string;
  name: string;
  prompt: string;
  agent_id: string;
  chatProjectId: string;
  cadence: ScheduleCadence;
  timezone: string;
  target: ScheduleTarget;
  enabled: boolean;
  disabledReason?: ScheduleDisabledReason;
  nextRunAt?: string;
  lastRun?: ScheduleLastRun;
  runCount: number;
  failureCount: number;
  configRevision?: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSchedule = {
  name: string;
  prompt: string;
  agent_id: string;
  chatProjectId: string;
  cadence: ScheduleCadence;
  timezone: string;
  target: ScheduleTarget;
  enabled: boolean;
  clientRequestId: string;
};

export type UpdateSchedule = Partial<Omit<CreateSchedule, 'clientRequestId'>> & {
  expectedConfigRevision?: number;
};

export type SchedulesResponse = {
  schedules: Schedule[];
  limits: { maxPerUser: number };
};

export type ScheduleRunNowResponse = {
  scheduleId: string;
  conversationId: string;
  status: 'started';
};

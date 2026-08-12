import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query';
import type {
  CreateSchedule,
  Schedule,
  ScheduleRunNowResponse,
  UpdateSchedule,
} from '~/knauf/common/schedules';
import {
  deleteSchedule,
  postSchedule,
  postScheduleRun,
  updateSchedule,
} from '~/knauf/data-provider/data-service';
import { SCHEDULES_QUERY_KEY } from './queries';

export function useCreateScheduleMutation(
  options?: UseMutationOptions<Schedule, Error, CreateSchedule>,
) {
  const queryClient = useQueryClient();
  return useMutation<Schedule, Error, CreateSchedule>(postSchedule, {
    ...options,
    onSuccess: (...args) => {
      void queryClient.invalidateQueries(SCHEDULES_QUERY_KEY);
      options?.onSuccess?.(...args);
    },
  });
}

export type UpdateScheduleParams = { id: string; payload: UpdateSchedule };

export function useUpdateScheduleMutation(
  options?: UseMutationOptions<Schedule, Error, UpdateScheduleParams>,
) {
  const queryClient = useQueryClient();
  return useMutation<Schedule, Error, UpdateScheduleParams>(
    ({ id, payload }) => updateSchedule(id, payload),
    {
      ...options,
      onSuccess: (...args) => {
        void queryClient.invalidateQueries(SCHEDULES_QUERY_KEY);
        options?.onSuccess?.(...args);
      },
    },
  );
}

export function useDeleteScheduleMutation(options?: UseMutationOptions<void, Error, string>) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>(deleteSchedule, {
    ...options,
    onSuccess: (...args) => {
      void queryClient.invalidateQueries(SCHEDULES_QUERY_KEY);
      options?.onSuccess?.(...args);
    },
  });
}

export function useRunScheduleNowMutation(
  options?: UseMutationOptions<ScheduleRunNowResponse, Error, string>,
) {
  const queryClient = useQueryClient();
  return useMutation<ScheduleRunNowResponse, Error, string>(postScheduleRun, {
    ...options,
    onSettled: (...args) => {
      void queryClient.invalidateQueries(SCHEDULES_QUERY_KEY);
      options?.onSettled?.(...args);
    },
  });
}

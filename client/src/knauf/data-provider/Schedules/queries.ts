import { useQuery, type QueryObserverResult, type UseQueryOptions } from '@tanstack/react-query';
import type { SchedulesResponse } from '~/knauf/common/schedules';
import { getSchedules } from '~/knauf/data-provider/data-service';

export const SCHEDULES_QUERY_KEY = ['knauf-schedules'] as const;

export function useSchedulesQuery(
  config?: UseQueryOptions<SchedulesResponse>,
): QueryObserverResult<SchedulesResponse> {
  return useQuery<SchedulesResponse>(SCHEDULES_QUERY_KEY, getSchedules, {
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 60_000,
    ...config,
  });
}

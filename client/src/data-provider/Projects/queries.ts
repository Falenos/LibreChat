import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type {
  UseInfiniteQueryOptions,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import type {
  ProjectListParams,
  ProjectListResponse,
  TChatProject,
  TChatProjectFile,
  TChatProjectFilesResponse,
} from 'librechat-data-provider';

// [knauf] KK20-248 — make project file indexing poll cadence configurable for slower async environments.
const DEFAULT_PROJECT_FILE_INDEX_POLL_MS = 3_000;
const rawProjectFileIndexPollMs = Number.parseInt(
  import.meta.env.VITE_PROJECT_FILE_INDEX_POLL_MS ?? '',
  10,
);
const PROJECT_FILE_INDEX_POLL_MS =
  Number.isFinite(rawProjectFileIndexPollMs) && rawProjectFileIndexPollMs > 0
    ? rawProjectFileIndexPollMs
    : DEFAULT_PROJECT_FILE_INDEX_POLL_MS;
// End [knauf]
const pendingProjectFileStatuses = new Set(['uploading', 'processing']);

const projectFilesRefetchInterval = (data?: TChatProjectFilesResponse): number | false =>
  data?.files?.some((file: TChatProjectFile) => {
    if (file.indexing) {
      return !file.indexing.ready && file.indexing.status !== 'failed';
    }
    return pendingProjectFileStatuses.has(file.status);
  })
    ? PROJECT_FILE_INDEX_POLL_MS
    : false;

export const useProjectsInfiniteQuery = (
  params: ProjectListParams = {},
  config?: UseInfiniteQueryOptions<ProjectListResponse, unknown>,
) => {
  const { sortBy, sortDirection, search, limit } = params;

  return useInfiniteQuery<ProjectListResponse>({
    queryKey: [QueryKeys.projects, { sortBy, sortDirection, search, limit }],
    queryFn: ({ pageParam }) =>
      dataService.listProjects({
        sortBy,
        sortDirection,
        search,
        limit,
        cursor: pageParam?.toString(),
      }),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000,
    cacheTime: 30 * 60 * 1000,
    ...config,
  });
};

export const useProjectQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProject>,
): QueryObserverResult<TChatProject, unknown> => {
  return useQuery<TChatProject>(
    [QueryKeys.project, projectId],
    () => dataService.getProjectById(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

// [knauf] KK20-248 — project knowledge files query for the project workspace.
export const useProjectFilesQuery = (
  projectId?: string | null,
  config?: UseQueryOptions<TChatProjectFilesResponse>,
): QueryObserverResult<TChatProjectFilesResponse, unknown> => {
  return useQuery<TChatProjectFilesResponse>(
    [QueryKeys.projectFiles, projectId],
    () => dataService.listProjectFiles(projectId ?? ''),
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: projectFilesRefetchInterval,
      ...config,
    },
  );
};
// End [knauf]

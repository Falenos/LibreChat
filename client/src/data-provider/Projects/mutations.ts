import { useRecoilCallback } from 'recoil';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  TChatProject,
  TConversation,
  TCreateChatProjectRequest,
  TDeleteChatProjectResponse,
  TUpdateChatProjectRequest,
  TAssignConversationToProjectRequest,
  TAssignConversationToProjectResponse,
  TAddChatProjectFileRequest,
  TChatProjectFile,
  TDeleteChatProjectFileRequest,
  TDeleteChatProjectFileResponse,
} from 'librechat-data-provider';
import { useNewConvo } from '~/hooks';
import store from '~/store';

export const useCreateProjectMutation = (): UseMutationResult<
  TChatProject,
  unknown,
  TCreateChatProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: TCreateChatProjectRequest) => dataService.createProject(payload), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.projects]);
    },
  });
};

export const useUpdateProjectMutation = (): UseMutationResult<
  TChatProject,
  unknown,
  TUpdateChatProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: TUpdateChatProjectRequest) => dataService.updateProject(payload), {
    onSuccess: (project) => {
      queryClient.setQueryData([QueryKeys.project, project._id], project);
      queryClient.invalidateQueries([QueryKeys.projects]);
    },
  });
};

export const useDeleteProjectMutation = (): UseMutationResult<
  TDeleteChatProjectResponse,
  unknown,
  string,
  unknown
> => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { newConversation } = useNewConvo();
  const getActiveConversation = useRecoilCallback(
    ({ snapshot }) =>
      async () => {
        return await snapshot.getPromise(store.conversationByIndex(0));
      },
    [],
  );
  const clearActiveConversationProject = useRecoilCallback(
    ({ snapshot, set }) =>
      async (projectId: string) => {
        const conversation = await snapshot.getPromise(store.conversationByIndex(0));
        if (conversation?.conversationId && conversation.chatProjectId === projectId) {
          set(store.updateConversationSelector(conversation.conversationId), {
            ...conversation,
            chatProjectId: null,
          });
          return true;
        }
        return false;
      },
    [],
  );

  return useMutation((projectId: string) => dataService.deleteProject(projectId), {
    onSuccess: async (_result, projectId) => {
      const activeConversation = await getActiveConversation();
      const deletedOpenProject = activeConversation?.chatProjectId === projectId;
      await clearActiveConversationProject(projectId);

      const projectFilesQueries = queryClient
        .getQueryCache()
        .findAll({ queryKey: [QueryKeys.projectFiles, projectId] });
      const deletedFileIds = new Set<string>();
      projectFilesQueries.forEach((query) => {
        const cached = queryClient.getQueryData<{ files?: Array<{ file_id: string }> }>(query.queryKey);
        cached?.files?.forEach((file) => {
          if (file.file_id) {
            deletedFileIds.add(file.file_id);
          }
        });
      });

      if (deletedFileIds.size > 0) {
        queryClient.setQueryData([QueryKeys.files], (files: TChatProjectFile[] | undefined) =>
          (files ?? []).filter((file) => !deletedFileIds.has(file.file_id)),
        );
      }

      queryClient.removeQueries([QueryKeys.projectFiles, projectId], { exact: false });
      queryClient.invalidateQueries([QueryKeys.files]);
      queryClient.invalidateQueries([QueryKeys.conversationTags]);
      queryClient.invalidateQueries([QueryKeys.project, projectId]);
      queryClient.removeQueries([QueryKeys.project, projectId], { type: 'inactive' });
      queryClient.invalidateQueries([QueryKeys.projects]);
      queryClient.invalidateQueries([QueryKeys.allConversations]);
      queryClient.invalidateQueries([QueryKeys.projectConversations]);

      if (deletedOpenProject) {
        newConversation();
        navigate('/c/new', { replace: true });
      }
    },
  });
};

export const useAssignConversationToProjectMutation = (): UseMutationResult<
  TAssignConversationToProjectResponse,
  unknown,
  TAssignConversationToProjectRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  const updateActiveConversation = useRecoilCallback(
    ({ set }) =>
      (conversation: TConversation) => {
        if (!conversation.conversationId) {
          return;
        }
        set(store.updateConversationSelector(conversation.conversationId), {
          ...conversation,
          chatProjectId: conversation.chatProjectId ?? null,
        });
      },
    [],
  );

  return useMutation(
    (payload: TAssignConversationToProjectRequest) =>
      dataService.assignConversationToProject(payload),
    {
      onSuccess: (result) => {
        updateActiveConversation(result.conversation);
        queryClient.setQueryData(
          [QueryKeys.conversation, result.conversation.conversationId],
          result.conversation,
        );
        [result.previousProjectId, result.projectId].forEach((projectId) => {
          if (projectId) {
            queryClient.invalidateQueries([QueryKeys.project, projectId]);
          }
        });
        queryClient.invalidateQueries([QueryKeys.projects]);
        queryClient.invalidateQueries([QueryKeys.allConversations]);
        queryClient.invalidateQueries([QueryKeys.projectConversations]);
      },
    },
  );
};

// [knauf] KK20-248 — mutations for explicit project knowledge files.
export const useAddProjectFileMutation = (): UseMutationResult<
  TChatProjectFile,
  unknown,
  TAddChatProjectFileRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: TAddChatProjectFileRequest) => dataService.addProjectFile(payload), {
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries([QueryKeys.projectFiles, payload.projectId]);
    },
  });
};

export const useDeleteProjectFileMutation = (): UseMutationResult<
  TDeleteChatProjectFileResponse,
  unknown,
  TDeleteChatProjectFileRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: TDeleteChatProjectFileRequest) => dataService.deleteProjectFile(payload),
    {
      onSuccess: (_result, payload) => {
        queryClient.setQueryData([QueryKeys.files], (files: TChatProjectFile[] | undefined) =>
          files?.filter((file) => file.file_id !== payload.file_id),
        );
        queryClient.invalidateQueries([QueryKeys.files]);
        queryClient.invalidateQueries([QueryKeys.projectFiles, payload.projectId]);
      },
    },
  );
};
// End [knauf]

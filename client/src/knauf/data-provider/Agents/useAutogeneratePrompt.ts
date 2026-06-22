/** React-query mutation around POST /api/knauf/autogenerate-prompt. */
import { useMutation } from '@tanstack/react-query';
import {
  postAutogeneratePrompt,
  type AutogeneratePromptRequest,
  type AutogeneratePromptResponse,
} from '~/knauf/data-provider/data-service';

export const useAutogeneratePrompt = (key?: string) =>
  useMutation<AutogeneratePromptResponse, Error, AutogeneratePromptRequest>({
    mutationKey: key ? ['knauf-autogenerate', key] : undefined,
    mutationFn: postAutogeneratePrompt,
  });

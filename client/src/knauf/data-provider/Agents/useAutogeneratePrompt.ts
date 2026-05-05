/** React-query mutation around POST /api/knauf/autogenerate-prompt. */
import { useMutation } from '@tanstack/react-query';
import {
  postAutogeneratePrompt,
  type AutogeneratePromptRequest,
  type AutogeneratePromptResponse,
} from '~/knauf/data-provider/data-service';

export const useAutogeneratePrompt = () =>
  useMutation<AutogeneratePromptResponse, Error, AutogeneratePromptRequest>({
    mutationFn: postAutogeneratePrompt,
  });

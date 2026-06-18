/** React-query hook for GET /api/knauf/prompt-templates. */
import { useQuery } from '@tanstack/react-query';
import {
  getPromptTemplates,
  type PromptTemplatesResponse,
} from '~/knauf/data-provider/data-service';

export const usePromptTemplates = () =>
  useQuery<PromptTemplatesResponse>({
    queryKey: ['knauf-prompt-templates'],
    queryFn: getPromptTemplates,
    staleTime: 5 * 60 * 1000, // templates rarely change, cache 5 min
    retry: 1, // non-critical — one retry is enough
  });

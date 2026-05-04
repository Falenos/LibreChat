/**
 * React-query mutation around POST /api/knauf/autogenerate-prompt.
 *
 * Layered on top of `dataService.postAutogeneratePrompt` so this file
 * stays pure react-query glue. The consumer-facing input is flat for
 * caller ergonomics; the transform to the nested wire shape (agent
 * context vs. textarea draft) happens here.
 */
import { useMutation } from '@tanstack/react-query';
import {
  postAutogeneratePrompt,
  type AutogeneratePromptRequest,
  type AutogeneratePromptResponse,
} from '~/knauf/data-provider/data-service';
import type { KnaufPersonality } from '~/knauf/common/agents-types';

export interface AutogeneratePromptInput {
  name: string;
  description: string;
  personality?: KnaufPersonality;
  /** Friendly capability labels visible to the user, e.g. "Browse the internet" */
  capabilityLabels: string[];
  knowledgeFileCount: number;
  currentDraft: string;
  /** Display names of regular tools the agent has selected. */
  tools: string[];
  /** MCP server names the agent has connected. */
  mcpServers: string[];
}

function toRequestBody(input: AutogeneratePromptInput): AutogeneratePromptRequest {
  return {
    agent: {
      name: input.name,
      description: input.description,
      personality: {
        label: input.personality?.label ?? '',
        description: input.personality?.description ?? '',
      },
      capabilities: input.capabilityLabels,
      knowledgeFileCount: input.knowledgeFileCount,
      tools: input.tools,
      mcpServers: input.mcpServers,
    },
    currentDraft: input.currentDraft,
  };
}

export function useAutogeneratePrompt() {
  return useMutation<AutogeneratePromptResponse, Error, AutogeneratePromptInput>({
    mutationFn: (input) => postAutogeneratePrompt(toRequestBody(input)),
  });
}

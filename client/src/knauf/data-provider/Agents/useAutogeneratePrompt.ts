/**
 * Calls POST /api/knauf/autogenerate-prompt to draft or polish the agent's
 * system instructions from the current builder context.
 *
 * Uses the same axios singleton as upstream's `dataService` so the
 * Authorization Bearer token (set by
 * packages/data-provider/src/headers-helpers.ts) flows through. A bare
 * `fetch` would skip that header and 401 against `requireJwtAuth`.
 */
import axios from 'axios';
import { useMutation } from '@tanstack/react-query';
import { KNAUF_AUTOGENERATE_ENDPOINT } from '~/knauf/common/constants';
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

interface AutogeneratePromptResponse {
  text: string;
}

/**
 * Wire-format request body. Nested under `agent` so the agent context is
 * one object and the user's textarea draft is its own top-level field —
 * mirrors how the server thinks about them ("polish this draft, given
 * what we know about the agent").
 */
interface RequestBody {
  agent: {
    name: string;
    description: string;
    personality: { label: string; description: string };
    capabilities: string[];
    knowledgeFileCount: number;
    tools: string[];
    mcpServers: string[];
  };
  currentDraft: string;
}

async function postAutogeneratePrompt(
  input: AutogeneratePromptInput,
): Promise<AutogeneratePromptResponse> {
  const body: RequestBody = {
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

  const { data } = await axios.post<AutogeneratePromptResponse>(
    KNAUF_AUTOGENERATE_ENDPOINT,
    body,
  );
  return data;
}

export function useAutogeneratePrompt() {
  return useMutation<AutogeneratePromptResponse, Error, AutogeneratePromptInput>({
    mutationFn: postAutogeneratePrompt,
  });
}

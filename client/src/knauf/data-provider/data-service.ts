/**
 * Going through `request` keeps these calls on the same
 * 401-refresh interceptor, JSON content-type handling, and Authorization
 * header that upstream's dataService relies on.
 */
import { request } from 'librechat-data-provider';
import * as endpoints from './api-endpoints';

export interface AutogeneratePromptRequest {
  agent: {
    name: string;
    description: string;
    category: string;
    personality: { label: string; description: string };
    capabilities: string[];
    knowledgeFileCount: number;
    tools: string[];
    mcpServers: string[];
  };
  currentDraft: string;
}

export interface AutogeneratePromptResponse {
  text: string;
}

export function postAutogeneratePrompt(
  body: AutogeneratePromptRequest,
): Promise<AutogeneratePromptResponse> {
  return request.post(endpoints.autogeneratePrompt(), body);
}

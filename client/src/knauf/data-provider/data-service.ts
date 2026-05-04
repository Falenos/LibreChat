/**
 * Thin HTTP wrappers for Knauf-only routes. Mirrors upstream's
 * packages/data-provider/src/data-service.ts: each export combines an
 * `endpoints.*` URL builder with the shared `request` module so we
 * inherit the JSON content-type handling, the 401-refresh interceptor,
 * and the auth header set on the axios singleton.
 *
 * Wire-format types live here (alongside the call that owns them) so
 * the react-query hook becomes pure glue and consumers above it never
 * need to know how the body is shaped.
 */
import { request } from 'librechat-data-provider';
import * as endpoints from './api-endpoints';

export interface AutogeneratePromptRequest {
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

export interface AutogeneratePromptResponse {
  text: string;
}

export function postAutogeneratePrompt(
  body: AutogeneratePromptRequest,
): Promise<AutogeneratePromptResponse> {
  return request.post(endpoints.autogeneratePrompt(), body);
}

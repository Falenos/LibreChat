/**
 * Going through `request` keeps these calls on the same
 * 401-refresh interceptor, JSON content-type handling, and Authorization
 * header that upstream's dataService relies on.
 */
import { request, type TMarketplaceCategory } from 'librechat-data-provider';
import * as endpoints from './api-endpoints';

export function postAgentCategory(body: { label: string }): Promise<TMarketplaceCategory> {
  return request.post(endpoints.agentCategories(), body);
}

export function deleteAgentCategory(value: string): Promise<void> {
  return request.delete(endpoints.agentCategory(value));
}

export interface AutogeneratePromptRequest {
  agent: {
    name: string;
    description: string;
    category: string;
    personality: { label: string; description: string };
    capabilities: string[];
    knowledgeFiles: Array<{ name: string; type: string }>;
    tools: string[];
    mcpServers: string[];
  };
  currentDraft: string;
  sourceTemplate?: string;
}

export interface AutogeneratePromptResponse {
  text: string;
}

export function postAutogeneratePrompt(
  body: AutogeneratePromptRequest,
): Promise<AutogeneratePromptResponse> {
  return request.post(endpoints.autogeneratePrompt(), body);
}

export interface ConversationCostSummary {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  unsupportedTokens: number;
  hasUnsupported: boolean;
  isEstimated?: boolean;
  estimateReason?: string | null;
}

export type MessageCostSummary = ConversationCostSummary;

export interface ConversationCostsResponse {
  currency: 'EUR';
  source: string;
  rates: Record<
    string,
    {
      inputPerMillion?: number;
      outputPerMillion?: number;
      cachedInputPerMillion?: number;
    }
  >;
  conversation: ConversationCostSummary;
  messages: Record<string, MessageCostSummary>;
}

export function getConversationCosts(conversationId: string): Promise<ConversationCostsResponse> {
  return request.get(endpoints.conversationCosts(conversationId));
}

export interface PromptTemplate {
  id: string;
  label: string;
  description: string;
  content: string;
}

export interface PromptTemplatesResponse {
  templates: PromptTemplate[];
}

export function getPromptTemplates(): Promise<PromptTemplatesResponse> {
  return request.get(endpoints.promptTemplates());
}

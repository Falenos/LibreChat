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

export interface CostSummary {
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

export interface ModelCostSummary extends CostSummary {
  returnedModel: string;
  requestedModel: string | null;
  pricingModel: string;
}

export interface ConversationCostSummary extends CostSummary {
  models?: ModelCostSummary[];
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

// KK20-195 WP5 — async file-indexing status + retry (plan §6.3/§6.4).
import type { KnaufFileIndexing } from '~/knauf/common/fileIndexing';

export interface FileIndexStatusResponse {
  file_id: string;
  indexing: KnaufFileIndexing;
}

export interface BatchIndexStatusResponse {
  batch_id: string;
  total: number;
  terminal: boolean;
  counts: Record<'uploading' | 'queued' | 'processing' | 'ready' | 'failed', number>;
  failures: Array<{ file_id: string; error_code: string | null; retryable: boolean }>;
}

export function getFileIndexStatus(fileId: string): Promise<FileIndexStatusResponse> {
  return request.get(endpoints.fileIndexStatus(fileId));
}

export function getBatchIndexStatus(batchId: string): Promise<BatchIndexStatusResponse> {
  return request.get(endpoints.batchIndexStatus(batchId));
}

export function postRetryFileIndex(fileId: string): Promise<FileIndexStatusResponse> {
  return request.post(endpoints.retryFileIndex(fileId), {});
}

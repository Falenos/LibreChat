/**
 * Going through `request` keeps these calls on the same
 * 401-refresh interceptor, JSON content-type handling, and Authorization
 * header that upstream's dataService relies on. Blob export uses that same
 * Axios singleton directly because `request.post` does not accept response options.
 */
import axios from 'axios';
import {
  request,
  type TConversation,
  type TMarketplaceCategory,
  type TMessage,
} from 'librechat-data-provider';
import * as endpoints from './api-endpoints';
import type {
  CreateSchedule,
  Schedule,
  ScheduleRunNowResponse,
  SchedulesResponse,
  UpdateSchedule,
} from '~/knauf/common/schedules';

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

export interface ArtifactExportSnapshot {
  title: string;
  type?: string;
  content: string;
  language?: string;
}

class ArtifactExportRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ArtifactExportRequestError';
  }
}

const parseArtifactExportErrorPayload = async (
  error: unknown,
): Promise<{ message?: unknown; code?: unknown; details?: unknown } | null> => {
  const data = axios.isAxiosError(error) ? error.response?.data : undefined;
  if (!(data instanceof Blob) || !data.type.includes('json')) {
    return null;
  }
  try {
    return JSON.parse(await data.text()) as {
      message?: unknown;
      code?: unknown;
      details?: unknown;
    };
  } catch {
    return null;
  }
};

const toArtifactExportRequestError = (payload: {
  message?: unknown;
  code?: unknown;
  details?: unknown;
}) =>
  new ArtifactExportRequestError(
    typeof payload.message === 'string' ? payload.message : 'Artifact export failed',
    typeof payload.code === 'string' ? payload.code : undefined,
    payload.details != null && typeof payload.details === 'object'
      ? (payload.details as Record<string, unknown>)
      : undefined,
  );

export async function postArtifactExport(
  artifact: ArtifactExportSnapshot,
  format: 'png' | 'pdf',
  shareId?: string,
): Promise<Blob> {
  try {
    const response = await axios.post(
      endpoints.artifactExport(shareId),
      shareId ? { format } : { artifact, format },
      { responseType: 'blob' },
    );
    return response.data;
  } catch (error) {
    const payload = await parseArtifactExportErrorPayload(error);
    if (payload != null) {
      throw toArtifactExportRequestError(payload);
    }
    throw error;
  }
}

export interface SharedArtifactContinuationResponse {
  conversation: TConversation;
  messages: TMessage[];
  artifactId: string;
}

export function postSharedArtifactContinuation(
  shareId: string,
  conversation: TConversation,
): Promise<SharedArtifactContinuationResponse> {
  return request.post(endpoints.artifactContinuation(shareId), { conversation });
}

export interface ArtifactRevisionSnapshot extends ArtifactExportSnapshot {
  type: string;
  version: number;
}

export type ArtifactRevisionHistoryItem =
  | {
      title: string;
      type: string;
      language?: string;
      version: number;
      available: true;
    }
  | { version: number; available: false };

export interface ArtifactRevisionHistory {
  currentVersion: number;
  revisions: ArtifactRevisionHistoryItem[];
}

export function getArtifactRevision(params: {
  messageId: string;
  identifier: string;
  version: number;
}): Promise<ArtifactRevisionSnapshot> {
  return request.get(endpoints.artifactRevision(params));
}

export function getArtifactRevisionHistory(params: {
  messageId: string;
  identifier: string;
}): Promise<ArtifactRevisionHistory> {
  return request.get(endpoints.artifactRevisionHistory(params));
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

export function getSchedules(): Promise<SchedulesResponse> {
  return request.get(endpoints.schedules());
}

export function postSchedule(payload: CreateSchedule): Promise<Schedule> {
  return request.post(endpoints.schedules(), payload);
}

export function updateSchedule(id: string, payload: UpdateSchedule): Promise<Schedule> {
  return request.patch(endpoints.schedule(id), payload);
}

export function deleteSchedule(id: string): Promise<void> {
  return request.delete(endpoints.schedule(id));
}

export function postScheduleRun(id: string): Promise<ScheduleRunNowResponse> {
  return request.post(endpoints.scheduleRun(id), {});
}

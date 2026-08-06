// [knauf] KK20-248 — project-scoped knowledge source document types.
import type { Document, Types } from 'mongoose';

export type ChatProjectSourceStatus = 'uploading' | 'processing' | 'ready' | 'failed';
export type ChatProjectSourceType = 'file';

export interface IChatProjectSource {
  _id?: Types.ObjectId;
  projectId: string;
  file_id: string;
  sourceType: ChatProjectSourceType;
  user: string;
  status: ChatProjectSourceStatus;
  error?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IChatProjectSourceDocument
  extends Omit<IChatProjectSource, '_id'>,
    Document {}
// End [knauf]

import type { Document, Types } from 'mongoose';

export interface IChatProject {
  _id?: Types.ObjectId;
  name: string;
  description?: string;
  // [knauf] KK20-248 — project-level instructions shared by project chats.
  instructions?: string;
  // End [knauf]
  user: string;
  conversationCount: number;
  lastConversationAt?: Date | null;
  lastConversationId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IChatProjectDocument extends Omit<IChatProject, '_id'>, Document {}

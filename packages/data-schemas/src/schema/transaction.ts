import mongoose, { Schema, Document, Types } from 'mongoose';

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  // [knauf] Persist cost provenance resolved by the Knauf conversation-cost service. KK20-227.
  knauf_costEstimated?: boolean;
  knauf_costEstimateReason?: string | null;
  knauf_costRateSource?: string;
  knauf_pricingMatch?: 'exact-version' | 'model-family' | 'router-fallback' | 'unknown';
  // End [knauf]
}

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    context: {
      type: String,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    tenantId: {
      type: String,
      index: true,
    },
    // [knauf] Keep exact/family/router pricing provenance on each transaction. KK20-227.
    knauf_costEstimated: { type: Boolean },
    knauf_costEstimateReason: { type: String, default: null },
    knauf_costRateSource: { type: String },
    knauf_pricingMatch: {
      type: String,
      enum: ['exact-version', 'model-family', 'router-fallback', 'unknown'],
    },
    // End [knauf]
  },
  {
    timestamps: true,
  },
);

// [knauf] Cost monitoring reads conversation ledgers by user + conversationId and checks
// the latest transaction for cache invalidation, so keep lookup + sort on one index.
transactionSchema.index(
  { user: 1, conversationId: 1, updatedAt: -1, _id: -1 },
  { name: 'knauf_cost_user_conversation_updatedAt_id' },
);
// End [knauf]

export default transactionSchema;

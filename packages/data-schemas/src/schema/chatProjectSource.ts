// [knauf] KK20-248 — project-scoped knowledge source schema.
import { Schema } from 'mongoose';
import type { IChatProjectSourceDocument } from '~/types';

const chatProjectSourceSchema: Schema<IChatProjectSourceDocument> =
  new Schema<IChatProjectSourceDocument>(
    {
      projectId: {
        type: String,
        required: true,
        index: true,
      },
      file_id: {
        type: String,
        required: true,
        index: true,
      },
      sourceType: {
        type: String,
        required: true,
        enum: ['file'],
        default: 'file',
        index: true,
      },
      user: {
        type: String,
        required: true,
        index: true,
      },
      status: {
        type: String,
        required: true,
        enum: ['uploading', 'processing', 'ready', 'failed'],
        default: 'uploading',
        index: true,
      },
      error: {
        type: String,
        default: null,
        maxlength: 2000,
      },
      tenantId: {
        type: String,
        index: true,
      },
    },
    { timestamps: true },
  );

chatProjectSourceSchema.index({ user: 1, projectId: 1, sourceType: 1, createdAt: -1, _id: -1 });
chatProjectSourceSchema.index(
  { user: 1, projectId: 1, sourceType: 1, file_id: 1 },
  { unique: true },
);
chatProjectSourceSchema.index({ projectId: 1, sourceType: 1, status: 1 });

export default chatProjectSourceSchema;
// End [knauf]

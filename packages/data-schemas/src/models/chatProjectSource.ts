// [knauf] KK20-248 — project-scoped knowledge source model registration.
import type { Model } from 'mongoose';
import type { IChatProjectSourceDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import chatProjectSourceSchema from '~/schema/chatProjectSource';

export function createChatProjectSourceModel(
  mongoose: typeof import('mongoose'),
): Model<IChatProjectSourceDocument> {
  applyTenantIsolation(chatProjectSourceSchema);
  return (
    mongoose.models.ChatProjectSource ||
    mongoose.model<IChatProjectSourceDocument>(
      'ChatProjectSource',
      chatProjectSourceSchema,
      'chatprojectsources',
    )
  );
}
// End [knauf]

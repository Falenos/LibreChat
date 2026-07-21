// [knauf] KK20-195 WP2 — model factory for the physical FileAsset aggregate.
// Tenant-isolated like `File`: assets hold per-user/per-agent content and the
// worker reads them under runAsSystem with per-asset scope re-established.
import type { Model } from 'mongoose';
import type { IKnaufFileAsset } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import fileAssetSchema from '~/schema/fileAsset';

export function createFileAssetModel(mongoose: typeof import('mongoose')): Model<IKnaufFileAsset> {
  applyTenantIsolation(fileAssetSchema);
  return (
    mongoose.models.KnaufFileAsset ||
    mongoose.model<IKnaufFileAsset>('KnaufFileAsset', fileAssetSchema)
  );
}
// End [knauf]

// [knauf] Model factory for the migration allowlist collection.
import migrationAllowlistSchema from '~/schema/migrationAllowlist';
import type { IMigrationAllowlist } from '~/types';

export function createMigrationAllowlistModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.MigrationAllowlist ||
    mongoose.model<IMigrationAllowlist>('MigrationAllowlist', migrationAllowlistSchema)
  );
}
// End [knauf]

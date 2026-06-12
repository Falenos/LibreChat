// [knauf] Migration access allowlist — one document per allowed user (keyed by normalised email).
// Whoever is in this collection may log in; everyone else sees the "not yet enabled" screen.
import { Schema } from 'mongoose';
import type { IMigrationAllowlist } from '~/types';

const migrationAllowlistSchema: Schema<IMigrationAllowlist> = new Schema(
  {
    emailNormalized: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: { unique: true },
    },
  },
  { timestamps: true },
);

export default migrationAllowlistSchema;
// End [knauf]

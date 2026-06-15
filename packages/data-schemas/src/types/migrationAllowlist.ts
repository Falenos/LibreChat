// [knauf] Type for the migration allowlist document.
import type { Document } from 'mongoose';

export interface IMigrationAllowlist extends Document {
  emailNormalized: string;
  createdAt: Date;
  updatedAt: Date;
}
// End [knauf]

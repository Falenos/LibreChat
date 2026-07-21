/**
 * URL builders for Knauf-only HTTP routes.
 *
 * `apiBaseUrl()` is read once at module load so a `<base href>` subpath
 * deploy works the same as for upstream routes. Path strings here are
 * intentionally duplicated with api/server/routes/knauf/index.js
 */
import { apiBaseUrl } from 'librechat-data-provider';

const knaufBase = `${apiBaseUrl()}/api/knauf`;

export const autogeneratePrompt = () => `${knaufBase}/autogenerate-prompt`;
export const conversationCosts = (conversationId: string) =>
  `${knaufBase}/costs/conversations/${encodeURIComponent(conversationId)}`;
export const promptTemplates = () => `${knaufBase}/prompt-templates`;

// KK20-195 WP5 — async-indexing status/retry. These live under upstream's
// /api/files (Knauf [knauf]-seamed routes in api/server/routes/files/files.js),
// not /api/knauf: they are per-file resources behind the upstream fileAccess ACL.
const filesBase = `${apiBaseUrl()}/api/files`;
export const fileIndexStatus = (fileId: string) =>
  `${filesBase}/${encodeURIComponent(fileId)}/index-status`;
export const batchIndexStatus = (batchId: string) =>
  `${filesBase}/index-status?batch_id=${encodeURIComponent(batchId)}`;
export const retryFileIndex = (fileId: string) =>
  `${filesBase}/${encodeURIComponent(fileId)}/index/retry`;

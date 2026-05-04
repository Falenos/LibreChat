/**
 * URL builders for Knauf-only HTTP routes. Mirrors upstream's
 * packages/data-provider/src/api-endpoints.ts shape: every export is a
 * function returning a string, prefixed with `apiBaseUrl()` so a `<base
 * href>` subpath deploy works the same as upstream routes do.
 *
 * Server side mounts these under `/api/knauf` (api/server/index.js) and
 * dispatches them in api/server/routes/knauf/index.js. Path strings here
 * are intentionally duplicated with that router; the runtimes do not
 * share TypeScript and a `packages/knauf/` workspace does not exist yet.
 */
import { apiBaseUrl } from 'librechat-data-provider';

const knaufBase = () => `${apiBaseUrl()}/api/knauf`;

export const autogeneratePrompt = () => `${knaufBase()}/autogenerate-prompt`;

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

/**
 * Single home for Knauf-overlay magic strings. Importing from here keeps
 * the agents/ folder readable and means renaming a YAML key (modelSpec
 * name, route path) is one-file work.
 *
 * Server-side mirrors of these strings (e.g. SPEC_NAME in
 * api/server/routes/knauf/autogeneratePrompt.js) are duplicated by hand —
 * the runtimes don't share TypeScript and we don't have a Knauf workspace
 * package yet to host shared constants. Worth that migration once the
 * `packages/knauf/` workspace lands (see CUSTOMIZATION_STRATEGY Tier 4).
 */

/** Prefix for personality modelSpecs in librechat.yaml `modelSpecs.list`. */
export const KARL_PERSONALITY_PREFIX = 'karl-personality-';

/** Default personality if none is selected and no model is loaded yet. */
export const KARL_DEFAULT_PERSONALITY_NAME = 'karl-personality-balanced';

/** ModelSpec name that drives the ✦ Autogenerate Prompt button. */
export const KARL_AUTOGENERATE_SPEC_NAME = 'karl-autogenerate-prompt';

/** Base path for Knauf-only Express routes mounted under /api/knauf. */
export const KNAUF_API_BASE = '/api/knauf';

/** Path for the ✦ Autogenerate Prompt route (inside KNAUF_API_BASE). */
export const KNAUF_AUTOGENERATE_ENDPOINT = `${KNAUF_API_BASE}/autogenerate-prompt`;

/**
 * Single home for Knauf-overlay magic strings tied to librechat.yaml.
 * Renaming a YAML key (modelSpec name, prefix) is one-file work here.
 *
 * Server-side mirrors of these strings (e.g. SPEC_NAME in
 * api/server/routes/knauf/autogeneratePrompt.js) are duplicated by hand —
 * the runtimes don't share TypeScript and we don't have a Knauf workspace
 * package yet to host shared constants. Worth that migration once the
 * `packages/knauf/` workspace lands.
 */

/** Prefix for personality modelSpecs in librechat.yaml `modelSpecs.list`. */
export const KARL_PERSONALITY_PREFIX = 'karl-personality-';

/** Default Karl modelSpec name in librechat.yaml `modelSpecs.list`. */
export const KARL_DEFAULT_SPEC_NAME = 'karl';

/** Default personality if none is selected and no model is loaded yet. */
export const KARL_DEFAULT_PERSONALITY_NAME = 'karl-personality-balanced';

/** ModelSpec name that drives the ✦ Autogenerate Prompt button. */
export const KARL_AUTOGENERATE_SPEC_NAME = 'karl-autogenerate-prompt';

/** Visible assistant name for the default Karl chat experience. */
export const KARL_CHAT_ASSISTANT_NAME = 'Karl';

/** Knauf logo used when Karl or a new no-avatar agent needs a fallback icon. */
export const KNAUF_LOGO_ICON_URL = '/assets/knauf-logo.png';

/**
 * Mirrors librechat.yaml `modelSpecs.list[name=karl].preset.model`.
 * Prefer the modelSpec name when available; this is a legacy fallback for
 * message/composer paths that only receive a model string.
 */
export const KARL_DEFAULT_MODEL = 'gpt-5.4';
export const KARL_DEFAULT_MODEL_LABEL = KARL_DEFAULT_MODEL.toUpperCase();
const KARL_MODEL_ALIASES = new Set([KARL_DEFAULT_MODEL, 'gpt-54']);

export const normalizeKarlLabel = (value?: string | null) => value?.trim().toLowerCase() ?? '';

export const isKarlSpecName = (spec?: string | null) =>
  spec === KARL_DEFAULT_SPEC_NAME || spec?.startsWith(KARL_PERSONALITY_PREFIX) === true;

export const isKarlModelName = (model?: string | null) =>
  KARL_MODEL_ALIASES.has(normalizeKarlLabel(model));

export const getKarlModelLabel = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const label = value?.trim();
    if (!label || normalizeKarlLabel(label) === normalizeKarlLabel(KARL_CHAT_ASSISTANT_NAME)) {
      continue;
    }

    return isKarlModelName(label) ? KARL_DEFAULT_MODEL_LABEL : label;
  }

  return KARL_DEFAULT_MODEL_LABEL;
};

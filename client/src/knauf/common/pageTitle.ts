/**
 * Shared helper for `document.title` writes across the app (KK20-159).
 *
 * The product brand has two forms:
 *   - **Full**: "KARL | Knauf AI Platform" — used as the initial / fallback
 *     page title (returned by `appTitle` from the startup config, sourced
 *     from `process.env.APP_TITLE`).
 *   - **Short**: "KARL" — used as the suffix in per-conversation page
 *     titles (e.g. "My research chat | KARL"), mirroring the pattern
 *     `ShareView.tsx` already uses for shared-conversation views.
 *
 * Keep `BRAND_SHORT` here as the source of truth for the short brand —
 * don't parse it out of `appTitle` (consumers would couple to the `' | '`
 * delimiter assumption).
 */

export const BRAND_SHORT = 'KARL';
const BRAND_FULL_FALLBACK = 'KARL | Knauf AI Platform';

/**
 * Build a `document.title` value.
 *
 * - With `chatTitle`: returns `${chatTitle} | ${BRAND_SHORT}` — the
 *   subtitle pattern used inside conversations.
 * - Without `chatTitle`: returns `appTitle` (the full brand from startup
 *   config) when provided, otherwise the hard-coded full fallback.
 *
 * Empty / whitespace-only `chatTitle` is treated as no title so we don't
 * emit a leading separator.
 */
export function buildPageTitle(chatTitle?: string | null, appTitle?: string | null): string {
  const trimmed = chatTitle?.trim();
  if (trimmed) {
    return `${trimmed} | ${BRAND_SHORT}`;
  }
  return appTitle?.trim() || BRAND_FULL_FALLBACK;
}

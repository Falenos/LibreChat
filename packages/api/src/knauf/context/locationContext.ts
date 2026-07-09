/**
 * KK20-201 — deterministic, low-PII location context for LLM prompts.
 *
 * Root cause: agent reasoning defaulted to assuming a US user (visible in the
 * "Thoughts" output) because no locale/timezone signal was ever passed into
 * the prompt — there was no hardcoded default anywhere, just an absence of
 * grounded context that let the model's own training bias fill the gap.
 *
 * This module derives a coarse, standard-headers-only signal:
 * - `Accept-Language` — sent automatically by every browser on every
 *   request, requires no client change.
 * - An optional client-sent IANA timezone header (`X-User-Timezone`), for
 *   callers that have wired it up.
 *
 * It never falls back to a specific country/region — absence of signal is
 * represented by `UNKNOWN_LOCATION_CONTEXT`, which explicitly instructs the
 * model not to assume a location.
 */

export const UNKNOWN_LOCATION_CONTEXT =
  'unknown (no locale/timezone signal available — do not assume any specific country or region)';

/** Header name a client may optionally set with `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
export const USER_TIMEZONE_HEADER = 'x-user-timezone';

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue> | undefined | null;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() !== '' ? first : undefined;
}

/** Parses the highest-priority locale tag out of a raw `Accept-Language` header value. */
export function parsePrimaryLocale(acceptLanguage?: string): string | undefined {
  if (!acceptLanguage) {
    return undefined;
  }
  const primary = acceptLanguage.split(',')[0]?.split(';')[0]?.trim();
  return primary && primary !== '*' ? primary : undefined;
}

/**
 * Resolves a deterministic, human-readable location context string from
 * request headers, suitable for direct inclusion in a system/tool prompt.
 * Always returns a string (never a raw, unsubstituted value) so callers
 * never leak an empty/ambiguous signal into the prompt.
 */
export function resolveUserLocationContext(headers: HeaderBag): string {
  const locale = parsePrimaryLocale(getHeader(headers, 'accept-language'));
  const timezone = getHeader(headers, USER_TIMEZONE_HEADER);

  const parts: string[] = [];
  if (locale) {
    parts.push(`Locale: ${locale}`);
  }
  if (timezone) {
    parts.push(`Timezone: ${timezone}`);
  }

  return parts.length > 0 ? parts.join(', ') : UNKNOWN_LOCATION_CONTEXT;
}

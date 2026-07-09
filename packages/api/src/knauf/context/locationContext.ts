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
 * Both header values are fully client-controlled (any HTTP client, not just
 * a real browser, can set them to arbitrary text), and this string is
 * spliced directly into a prompt sent to the LLM. To avoid a prompt-
 * injection surface, values are validated against BCP-47 / IANA-timezone-
 * shaped patterns and length-capped; anything that doesn't look like a
 * real locale/timezone is dropped rather than passed through.
 *
 * It never falls back to a specific country/region — absence of signal (or
 * rejection of a malformed/suspicious value) is represented by
 * `UNKNOWN_LOCATION_CONTEXT`, which explicitly instructs the model not to
 * assume a location.
 */
import { UNKNOWN_LOCATION_CONTEXT } from 'librechat-data-provider';

export { UNKNOWN_LOCATION_CONTEXT };

/** Header name a client may optionally set with `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
export const USER_TIMEZONE_HEADER = 'x-user-timezone';

/** Conservative upper bound — real locale/timezone tags are always far shorter than this. */
const MAX_TOKEN_LENGTH = 40;
/** BCP-47-ish: `en`, `en-US`, `zh-Hans-CN`, etc. Rejects anything with spaces, punctuation, or script-tag payloads. */
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8}){0,3}$/;
/** IANA zone shape: `UTC`, `Europe/Berlin`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`. */
const TIMEZONE_PATTERN = /^[A-Za-z]+([_+-][A-Za-z0-9]+)*(\/[A-Za-z]+([_+-][A-Za-z0-9]+)*){0,2}$/;

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue> | undefined | null;

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() !== '' ? first : undefined;
}

/** Rejects anything that isn't shaped like the expected token — the whole point is to never forward arbitrary client-controlled text into a prompt. */
function sanitizeToken(value: string | undefined, pattern: RegExp): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  return pattern.test(trimmed) ? trimmed : undefined;
}

/** Parses the highest-priority locale tag out of a raw `Accept-Language` header value. */
export function parsePrimaryLocale(acceptLanguage?: string): string | undefined {
  if (!acceptLanguage) {
    return undefined;
  }
  const primary = acceptLanguage.split(',')[0]?.split(';')[0]?.trim();
  if (!primary || primary === '*') {
    return undefined;
  }
  return sanitizeToken(primary, LOCALE_PATTERN);
}

/**
 * Resolves a deterministic, human-readable location context string from
 * request headers, suitable for direct inclusion in a system/tool prompt.
 * Always returns a string (never a raw, unsubstituted value) so callers
 * never leak an empty/ambiguous signal into the prompt.
 */
export function resolveUserLocationContext(headers: HeaderBag): string {
  const locale = parsePrimaryLocale(getHeader(headers, 'accept-language'));
  const timezone = sanitizeToken(getHeader(headers, USER_TIMEZONE_HEADER), TIMEZONE_PATTERN);

  const parts: string[] = [];
  if (locale) {
    parts.push(`Locale: ${locale}`);
  }
  if (timezone) {
    parts.push(`Timezone: ${timezone}`);
  }

  return parts.length > 0 ? parts.join(', ') : UNKNOWN_LOCATION_CONTEXT;
}

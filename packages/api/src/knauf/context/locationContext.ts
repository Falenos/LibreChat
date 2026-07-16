/**
 * KK20-201 — deterministic, low-PII location context for LLM prompts.
 *
 * Root cause: agent reasoning defaulted to assuming a US user (visible in the
 * "Thoughts" output) because no locale/timezone signal was ever passed into
 * the prompt — there was no hardcoded default anywhere, just an absence of
 * grounded context that let the model's own training bias fill the gap.
 *
 * This module derives a coarse signal from, in priority order:
 * - `req.body.timezone` — the browser's real `Intl`-resolved IANA timezone,
 *   sent on every chat request by upstream's time-variable resolution (see
 *   `resolveTimezone` below). This is the strongest signal available and is
 *   what actually reaches production, since no client currently sends the
 *   `X-User-Timezone` header.
 * - `X-User-Timezone` header — kept as a fallback for callers that have
 *   wired a client to send it.
 * - `Accept-Language` — sent automatically by every browser on every
 *   request, requires no client change, but is a *language* preference, not
 *   a location signal (an `en-US` browser is common outside the US).
 *
 * Header/body values are fully client-controlled (any HTTP client, not just
 * a real browser, can set them to arbitrary text), and this string is
 * spliced directly into a prompt sent to the LLM. To avoid a prompt-
 * injection surface, timezone candidates must both match an IANA-timezone-
 * shaped pattern *and* be a zone the runtime actually recognizes, and locale
 * candidates must match a BCP-47-shaped pattern; both are length-capped.
 * Anything that doesn't look like (and resolve as) a real locale/timezone is
 * dropped rather than passed through.
 *
 * It never falls back to a specific country/region — absence of signal (or
 * rejection of a malformed/suspicious value) is represented by
 * `UNKNOWN_LOCATION_CONTEXT`. When a signal *is* present, the composed
 * string is still framed as a hint ("Location hint only, not a confirmed
 * physical location or country") rather than proof, since locale reflects
 * language preference and even a real timezone only narrows a region.
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

/**
 * Confirms a shape-valid candidate is an IANA zone the runtime actually
 * recognizes (rejects plausible-looking fakes like `Europe/Faketown`).
 * `Intl.DateTimeFormat` throws `RangeError` for unknown zone identifiers.
 */
function isRecognizedIanaTimeZone(candidate: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

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

/** Resolves the first valid timezone, preferring the browser request body. */
export function resolveUserTimezone(headers: HeaderBag, bodyTimezone?: string): string | undefined {
  for (const value of [bodyTimezone, getHeader(headers, USER_TIMEZONE_HEADER)]) {
    const candidate = sanitizeToken(value, TIMEZONE_PATTERN);
    if (candidate && isRecognizedIanaTimeZone(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves a deterministic, human-readable location context string from
 * request headers plus (when available) the request body's browser-supplied
 * timezone, suitable for direct inclusion in a system/tool prompt. Always
 * returns a string (never a raw, unsubstituted value) so callers never leak
 * an empty/ambiguous signal into the prompt.
 *
 * Deliberately phrased as a hint, never as proof of physical country:
 * `Accept-Language` reflects a browser/OS *language* preference (a German
 * employee using an `en-US` browser is common and does not mean they are in
 * the US), and even a real IANA timezone only narrows a region, not a
 * country with certainty (VPNs, travel, shared devices). Callers must not
 * strip this framing when splicing the result into a prompt.
 */
export function resolveUserLocationContext(headers: HeaderBag, bodyTimezone?: string): string {
  const locale = parsePrimaryLocale(getHeader(headers, 'accept-language'));
  const timezone = resolveUserTimezone(headers, bodyTimezone);

  const parts: string[] = [];
  if (locale) {
    parts.push(`Locale: ${locale}`);
  }
  if (timezone) {
    parts.push(`Timezone: ${timezone}`);
  }

  if (parts.length === 0) {
    return UNKNOWN_LOCATION_CONTEXT;
  }

  return `Location hint only, not a confirmed physical location or country (${parts.join(', ')})`;
}

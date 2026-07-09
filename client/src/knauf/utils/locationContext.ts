/**
 * KK20-201 — client-side counterpart to
 * `packages/api/src/knauf/context/locationContext.ts`.
 *
 * The server-side resolver only sees the `Accept-Language` header, which
 * covers the Agents-endpoint tool/instruction paths. The *client-side*
 * `replaceSpecialVars` call sites (`useChatFunctions.ts`'s `promptPrefix`
 * substitution, `useSubmitMessage.ts`'s Prompts-library submission) run
 * entirely in the browser and never round-trip through a header — so they
 * get their own resolver using `Intl`, which is both more precise (real
 * IANA timezone, not just an `Accept-Language` guess) and requires no
 * network round trip.
 *
 * Kept intentionally symmetrical with the server helper's output format
 * (`Locale: xx-XX, Timezone: Region/City`) so both surfaces read the same
 * way if ever compared/logged, and so the same neutral-fallback wording is
 * used consistently: this must never resolve to a hardcoded country.
 */
import { UNKNOWN_LOCATION_CONTEXT } from 'librechat-data-provider';

export { UNKNOWN_LOCATION_CONTEXT };

/** Resolves a deterministic, human-readable location context string from the browser's own `Intl` APIs. */
export function resolveBrowserLocationContext(): string {
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    const parts: string[] = [];
    if (options.locale) {
      parts.push(`Locale: ${options.locale}`);
    }
    if (options.timeZone) {
      parts.push(`Timezone: ${options.timeZone}`);
    }
    return parts.length > 0 ? parts.join(', ') : UNKNOWN_LOCATION_CONTEXT;
  } catch {
    return UNKNOWN_LOCATION_CONTEXT;
  }
}

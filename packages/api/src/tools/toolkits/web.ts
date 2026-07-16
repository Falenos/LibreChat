import { Tools, replaceSpecialVars } from 'librechat-data-provider';
// [knauf] KK20-201 — deterministic location context so the model never has
// to assume/guess a user's location (see locationContext.ts for root cause).
import { UNKNOWN_LOCATION_CONTEXT } from '../../knauf/context/locationContext';
// End [knauf]

/** Builds the web search tool context with citation format instructions. */
export function buildWebSearchContext(
  // [knauf] KK20-201 — `location` param threaded in from callers that have
  // access to the request headers (ToolService.js, handleTools.js).
  location?: string,
  // End [knauf]
): string {
  return `# \`${Tools.web_search}\`:
Current User Location: ${location ?? UNKNOWN_LOCATION_CONTEXT}

**Execute immediately without preface.** After search, provide a brief summary addressing the query directly, then structure your response with clear Markdown formatting (## headers, lists, tables). Cite sources properly, tailor tone to query type, and provide comprehensive details.

Use the conversation date/time from the dynamic runtime context when recency matters.

**CITATION FORMAT - UNICODE ESCAPE SEQUENCES ONLY:**
Use these EXACT escape sequences (copy verbatim): \\ue202 (before each anchor), \\ue200 (group start), \\ue201 (group end), \\ue203 (highlight start), \\ue204 (highlight end)

Anchor pattern: \\ue202turn{N}{type}{index} where N=turn number, type=search|news|image|ref, index=0,1,2...

**Examples (copy these exactly):**
- Single: "Statement.\\ue202turn0search0"
- Multiple: "Statement.\\ue202turn0search0\\ue202turn0news1"
- Group: "Statement. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Highlight: "\\ue203Cited text.\\ue204\\ue202turn0search0"
- Image: "See photo\\ue202turn0image0."

**CRITICAL:** Output escape sequences EXACTLY as shown. Do NOT substitute with † or other symbols. Place anchors AFTER punctuation. Cite every non-obvious fact/quote. NEVER use markdown links, [1], footnotes, or HTML tags.`.trim();
}

// [knauf] KK20-201 — current request time prevents stale live-search context.
/** Builds dynamic web search context scoped to the current request time. */
export function buildWebSearchDynamicContext(now?: string | number | Date): string {
  return `# \`${Tools.web_search}\` Runtime Context
Request Date & Time: ${replaceSpecialVars({ text: '{{iso_datetime}}', now })}`.trim();
}
// End [knauf]

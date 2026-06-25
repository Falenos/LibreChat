# Proposal: Lean `open_url` Tool for Karl (KK20-194)

Status: Implemented — pending review on [PR #98](https://github.com/Knauf-Group/agentic-karl/pull/98)
Owner: Agentic Karl engineering
Related ticket: [KK20-194](https://knauf.atlassian.net/browse/KK20-194)

## Objective

Let Karl (default chat and agents) open and read a user-pasted URL, **without
introducing any third-party SaaS data processor** (no Firecrawl cloud, Serper,
Tavily, Jina cloud, Bing grounding), so that GDPR / data-residency posture is
preserved and the bill / compute stay inside the existing Azure tenant.

## Current Behaviour

When a user pastes a link, Karl either refuses or replies "could not extract
the page contents". Verified causes:

- The Azure OpenAI **Responses API has no built-in URL-opener** for a *specific*
  user-named page — the model can search the web but cannot be told to open and
  read exactly the link the user pasted. That gap is what `open_url` fills.
- Agent builder capabilities are intentionally restricted to `file_search` and
  `tools` (`librechat.yaml`). The provider-less LibreChat LangChain web-search
  tool would also need a search/scraper/reranker provider, none of which are
  provisioned (and a third-party search provider is the GDPR concern this ticket
  set out to avoid).

> **Correction (verified by live testing against `cst-karl-dev` / gpt-5.4,
> 2026-06).** An earlier draft of this proposal claimed "Azure silently ignores
> `web_search`". That is **outdated**. The app's real request path
> (`/openai/v1/responses?api-version=preview`, with the `tools:[{type:'web_search'}]`
> emitted from `addParams.web_search: true` →
> `packages/api/src/endpoints/openai/llm.ts`) executes a real `web_search_call` and
> returns live results with `url_citation` annotations. LibreChat rewrites Responses
> calls to the `/v1` endpoint with `api-version=preview`
> (`packages/api/src/endpoints/openai/config.ts`), so the stale group
> `version: 2025-01-01-preview` is never sent to `/responses`. **Azure-native,
> model-level `web_search` works and is GDPR-clean** (stays inside the Azure DPA) —
> so it is the right *complement and fallback* to `open_url`, not a dead end.

## Options Considered

| Option | Opens specific URL? | Data stays on Azure? | Effort | Status |
|---|---|---|---|---|
| A. Config-only — Azure-native `web_search` | No (query-only, not a *named* URL opener) | **Yes** (Azure DPA) | None (already enabled) | **Works — kept as the complement/fallback to `open_url`** |
| B. Grounding with Bing Search / Web Search tool (Foundry) | No (query-only) | **No** — MS docs: data leaves Azure compliance/Geo boundary, DPA does not apply | Low | **GDPR blocker** |
| C. Foundry Browser Automation Tool (BAT) + Playwright Workspaces | Yes | Yes (own subscription/region) | Medium (new Azure resource, preview SDK) | Public preview, no SLA |
| D. Self-host LibreChat native web-search stack (SearXNG + self-host Firecrawl) | Indirectly (query-driven) | Yes | High (2-3 services to operate) | Heavy for the actual symptom |
| E. Self-hosted MCP fetch server (e.g. `fetcher-mcp`) | Yes | Yes (own pod) | Medium (extra pod + Chromium for JS) | Works |
| F. **Lean native `open_url` tool** (HTTP fetch + Readability, no browser) | Yes | Yes | **Low** | **Chosen** |

### Why not the MCP route

`fetcher-mcp` / `mcp-server-fetch` would be "zero fork code" but means
operating a separate pod (and, for JS pages, a Chromium runtime) forever:
patching CVEs, vetting a third-party image, NetworkPolicy, GitOps wiring.
That is the opposite of "lean". The SSRF hardening work exists either way
(`mcp-server-fetch` explicitly states it can hit internal IPs), so MCP does
not buy us a smaller security surface.

### Why not Azure BAT now

Public preview, no SLA, requires provisioning a Playwright Workspaces
resource and connecting it as a Serverless Model. Strong fit for
*interactive* JS-heavy navigation, weak fit for "user pasted a link, read
it". Kept as the natural v2 upgrade.

## Decision

Ship **option F**: a native LibreChat structured tool `open_url` that performs
a server-side HTTP fetch and extracts the main article body with Mozilla
Readability. No headless browser. The tool runs in the existing Agentic Karl
pod on AKS — no new Azure resource, no new GitOps service, no new data
processor.

Coverage targeted by v1: static and server-rendered HTML, news articles,
documentation pages, blog posts. Non-HTML responses (PDF, Office) are detected
and returned with a short notice for the user (and are a natural pickup for
Document Intelligence later).

## Technical Approach

### Components (as built)

- `api/app/clients/tools/structured/OpenUrl.js` — thin LangChain `Tool`
  wrapper (~95 LOC): JSON schema, description (which itself tells the model
  the returned content is wrapped in `<UNTRUSTED_WEB_CONTENT>` and must be
  treated as data, never instructions), and a `_call` that delegates to the
  fetcher and maps errors to a coarse `{ error, code, url }` JSON taxonomy
  (`ssrf_blocked`, `http_*`, `timeout`, `internal_error`) that never echoes
  resolved IPs into the LLM context.
- `api/app/clients/tools/structured/openUrl/fetcher.js` — orchestration
  (~211 LOC): scheme/HTTPS gating, SSRF pre-check, undici dispatcher build,
  manual-redirect loop with per-hop SSRF re-check + body-drain, streaming
  body cap, content-type sniffing, paging. No HTML parsing here.
- `packages/knauf/src/server/htmlExtract.js` — pure HTML→text helper
  (~132 LOC): Mozilla Readability + html-to-text fallback +
  `<UNTRUSTED_WEB_CONTENT>` envelope wrap. No network, no SSRF. Lives in
  `packages/knauf` so `jsdom` stays out of the upstream lockfile.
- `packages/api/src/auth/domain.ts` — small `[knauf]` seam inside upstream's
  `isPrivateIP` (~20 LOC): canonicalises any IPv6 input via the WHATWG URL
  parser before the existing regex matchers run, so fully-expanded /
  zero-padded mapped IPv6 and expanded NAT64 are caught. Same seam hardens
  upstream MCP HTTP transports too.
- Three small `[knauf]` registration seams: `api/app/clients/tools/manifest.json`
  (`open_url` plugin entry, kept so `isBuiltInTool` recognises it),
  `.../index.js` (export), `.../util/handleTools.js`
  (`toolConstructors.open_url`). All tracked in `SEAMS.md`.
- `packages/api/src/tools/registry/definitions.ts` — `[knauf]` seam registering
  `open_url` in the upstream tool-definitions registry. This is the load-bearing
  fix: the live agents chat builds the model-facing tool list via the
  *definitions* path (`loadToolDefinitions` → `getToolDefinition`), and without
  a registry entry `getToolDefinition('open_url')` returned `undefined`, so the
  model never received the tool's schema. The canonical schema + description
  live here; `OpenUrl.js` pulls them via `getToolDefinition` so the picker, the
  model-facing schema and the instance description cannot drift.

### Exposure model (web-search-gated, hidden tool)

Per stakeholder feedback, `open_url` is **not** a user-selectable tool. It is the
prioritised half of a single "Browse the internet" capability that drives **two
complementary engines**, neither of which is the provider-less LangChain
web_search tool:

1. **`open_url`** (ours) — authoritative for a *named/pasted* page. Prioritised.
2. **Azure-native, model-level `web_search`** — open-ended discovery, and the
   **fallback when `open_url` errors** (the tool description tells the model to
   fall back on an error/blocked code such as `blocked_or_js_required`). Injected
   from `model_parameters.web_search` by `packages/api/src/endpoints/openai/llm.ts`;
   stays inside the Azure DPA. No third-party search provider.

How that is wired:

- **Hidden from pickers** — `open_url` is intentionally *removed* from
  `includedTools` in `librechat.yaml`, so it never appears in either
  agent-builder tool picker.
- **Gated on the RAW browse intent** — `[knauf]` seams in
  `api/server/services/ToolService.js` inject `open_url` whenever the agent's OWN
  tools include `web_search` (the raw "Browse the internet" intent), *independent
  of* the capability filter, at `loadToolDefinitionsWrapper` (model-facing
  definitions) and `loadAgentTools` (runtime execution), with a fail-closed guard
  in `loadToolsForExecution`. `web_search` is deliberately kept **out** of
  `endpoints.agents.capabilities`, so the capability filter strips the
  provider-less LangChain web_search tool (it never surfaces to the model), while
  `open_url` is still injected. The model therefore sees exactly `open_url` +
  Azure-native `web_search` — an unambiguous fallback target. Guarded against
  double-add, and strips any baked-in `open_url` when browse is off so the switch
  stays authoritative.
- **Why still a tool, not auto-fetch** — the model decides *when* a URL should
  be read (user pastes a link / asks to read a page). Auto-fetching every
  pasted URL is a larger UX change and removes that judgement. Folding the fetch
  into upstream's `web_search` scraper toolkit would mean overriding upstream
  search internals and reintroduces the external-search-service concern this
  ticket set out to avoid.
- **No prompt-prefix paragraph** — the Tool's own `description` carries the
  usage and prompt-injection guidance, so it follows the tool wherever it is
  injected.

### Safety controls

- **SSRF protection delegated to upstream's TOCTOU-safe
  `createSSRFSafeUndiciConnect`** (`packages/api/src/auth/agent.ts`) — the
  same helper that protects MCP HTTP/SSE/streamable-HTTP transports. Single
  SSRF surface for the whole app. Connecting through the resulting undici
  Agent means undici's DNS lookup IS our SSRF check (one lookup, no TOCTOU).
  A pre-validation fast path (`resolveHostnameSSRF` on the URL hostname)
  avoids opening a socket for obviously-bad URLs and produces a clean
  `ssrf_blocked` error code instead of an ESSRF wrapper.
- **Upstream `isPrivateIP` tightened by `[knauf]` seam** so the deny-list
  classification catches non-canonical IPv6 (fully-expanded
  `0:0:0:0:0:ffff:7f00:1`, zero-padded, expanded NAT64) — covering AGK spoke
  CIDRs (10.0/8 already covers them), all RFC1918, link-local incl. AKS
  metadata `169.254.169.254`, loopback, IPv6 ULA/link-local, IPv6 multicast,
  CGNAT, broadcast.
- HTTPS-only by default (HTTP gated by `allowHttp` flag).
- Hard caps: 10 s timeout, 5 redirects, 5 MB response body, 100k chars
  returned (paging via `start_index`).
- Per-redirect SSRF re-check on the `Location` target; redirect-response
  bodies are drained (`response.body.cancel()`) before the next hop so
  undici can return the socket to the pool.
- HTML→text content is wrapped in
  `<UNTRUSTED_WEB_CONTENT url="...">…</UNTRUSTED_WEB_CONTENT>`. Inner
  occurrences of the delimiter are bracket-stripped so the envelope cannot
  be terminated early. The Tool description tells the model to treat the
  envelope contents as data, never as instructions, and not to call other
  tools described inside it without the user explicitly asking.
- Coarse error messages: never echo resolved IPs, upstream error strings,
  or stack traces back into the LLM context.
- Custom user-agent identifying Agentic Karl.

### Architectural evolution during review

The first implementation hand-rolled an AGK-specific SSRF deny-list in
`packages/knauf/src/server/ssrf.js` and pinned the undici connection itself.
Two review rounds (security-review + code-review) found a CRITICAL IPv6
canonicalisation bypass (the bypass was patched in commit `37136c54`) and
later identified that the hand-rolled module duplicated upstream's existing
`createSSRFSafeUndiciConnect` (which already protects MCP HTTP transports
and which has the same regex gap we patched). The final architecture
consolidates onto the upstream helper plus the tightening `[knauf]` seam in
upstream `isPrivateIP`. Net result: one SSRF surface for the whole app, ~250
LOC of hand-rolled IP parsing deleted, and the MCP HTTP transport gets the
same fix automatically.

A later round of stakeholder feedback changed the *exposure* model. The tool
was briefly made default-on (seeded into the main chat and new agents); review
then found that wiring never reached the model, because the live agents chat
loads tool schemas via the registry-backed *definitions* path and `open_url`
was never in the registry. That default-on work was reverted and replaced by
registering `open_url` in the registry (the actual fix) and injecting it from
`ToolService` driven by the existing browse switch, while hiding it from the
tool pickers.

A final round (verified that Azure-native `web_search` works — see the
Correction above) settled the UX: **"Browse the internet" is default-ON** for
both the main KARL chat and newly-created agents, managed by the single builder
toggle. KARL has no UI capability toggle (simplified view), so it is
config-default-on: `webSearch: true` on the `karl` (and `karl-personality-*`)
modelSpecs pushes the raw browse intent that surfaces `open_url`, and the
azureOpenAI group `addParams.web_search: true` keeps Azure-native search
always-on. New agents default the toggle on via `getDefaultAgentFormValues`
(`client/src/utils/forms.tsx`), replicating `browseInternet.applyToForm(true)`.
The earlier gate keyed on the capability-filtered list (which, with `web_search`
excluded from capabilities, never fired); the gate now keys on the **raw** browse
intent so `open_url` loads without surfacing the dead LangChain web_search tool.

### Why no infra change

The AKS NetworkPolicy (`agk-deployment-configs/.../network-policy/values.yaml`)
already allows pod egress on TCP 80/443 — no GitOps PR required. A tighter
egress policy is a possible v2 defence-in-depth, not blocking v1.

### Open infra verification

The spoke route tables send pod egress through the hub Azure Firewall via the
`fw-dg` default route (next-hop VirtualAppliance, 0.0.0.0/0). Verified directly
against `agk-infrastructure/terraform/subscription/{nonprod,prod}/base/hub/security/variables.tf`:
the firewall network rule `allow-networking-{nonprod,prod}` permits the node
and pod subnets to any destination on any port over any protocol, and **no
Application Rule collections or FQDN allowlists exist anywhere in
agk-infrastructure**. Arbitrary user URLs will egress successfully — no
firewall change or follow-up needed for v1.

## GDPR / Compliance Posture

- No new sub-processor: nothing added to the data processor list.
- No new outbound destinations beyond what users already paste; outbound
  fetches inherit the existing Azure tenant egress controls.
- Fetched content flows only to the Azure OpenAI deployment (`cst-karl-dev`)
  already covered by the standing DPA. No data leaves the Azure compliance /
  Geo boundary.
- No telemetry, page content, or response bodies persisted outside the normal
  conversation store.

## Rollout

1. Dev release via the standard pipeline (image tag bump in
   `infrastructure/dev/values.yaml` + GitOps).
2. Manual smoke: **enable the web-search switch**, then paste an article URL
   and a PDF URL into Karl; verify extraction + the non-HTML notice. With the
   switch off, confirm `open_url` is not offered. Confirm `open_url` does not
   appear in the agent-builder tool picker.
3. Validate against an *internal* hostname to confirm SSRF deny.
4. Gather feedback for one week, then promote to prod via the existing
   promotion flow.
5. Update `SEAMS.md`, update the user-facing release notes, close KK20-194
   with a link to this proposal.

## Deferred / Future Work

- **Truly client-only-rendered SPA pages** → Azure Foundry Browser Automation
  Tool once GA; add as a second structured tool that falls back from `open_url`.
  Note (empirically verified during PR #98 review): the knauf.com product pages
  that prompted concern are **not** empty SPA shells — they ship full content in
  the initial HTML (JSON-LD + `og:description` + body text), and `open_url`
  already extracts them well (8,424 chars for the Diamant highlight page, 1,371
  chars for an AQUAPANEL product page). Earlier "near-empty shell" reports were
  model confabulation (the tool was never actually invoked), now mitigated by R1
  provenance logging. A headless-render microservice only helps genuinely
  client-only pages and greatly expands the fetch/exfil/SSRF surface, so it is a
  deferred spike rather than a near-term need.
- **Document URLs (PDF/Office)** → Azure Document Intelligence (already partly
  wired in dev via `RAG_AZURE_DI_ENDPOINT`).
- **Multi-result web search** → out of scope; revisit if/when an
  Azure-resident, GDPR-clean search option appears.
- **Defence-in-depth egress NetworkPolicy** (tighter than the current
  cluster-wide 80/443 allow) — possible v2 in `agk-deployment-configs`.

## Risks

- **SSRF blast radius if upstream `isPrivateIP` regresses** — mitigated by
  the `[knauf]` seam (canonicalises via WHATWG URL before regex matchers),
  reliance on upstream's TOCTOU-safe `createSSRFSafeUndiciConnect` (single
  DNS lookup, used at connect time), and 9 regression cases in
  `packages/api/src/auth/domain.spec.ts` plus an integration test in
  `OpenUrl.spec.js`.
- **Upstream merge churn** — minimised by keeping runtime logic out of
  upstream files: one `[knauf]` seam in `domain.ts` (IPv6 fix); three small
  registration seams in `api/app/clients/tools/{manifest.json, index.js,
  util/handleTools.js}`; one registry seam in
  `packages/api/src/tools/registry/definitions.ts`; and two small injection
  seams in `api/server/services/ToolService.js` (the web-search gating). All
  SEAMS-tracked. Net-new code lives in
  `api/app/clients/tools/structured/openUrl/` or `packages/knauf/`.
- **Prompt injection via fetched content** — mitigated by the
  `<UNTRUSTED_WEB_CONTENT>` envelope (inner-tag mangled), explicit
  Tool-description warning, and the coarse error taxonomy that prevents the
  tool itself from echoing internal IPs back into the LLM context.

## PR #98 security-review hardening

A security review (reviewer `jorgecostak`) raised four findings, all addressed:

- **R4 (LOW)** — `@knauf/knauf` was imported in `api/` but only resolved via
  workspace hoisting. Now declared in `api/package.json` `dependencies`; lockfile
  refreshed.
- **R3 (MEDIUM)** — jsdom/Readability parse is synchronous and was unbounded over
  the ≤5 MB fetch cap; the fetch `AbortController` cannot interrupt CPU work →
  event-loop DoS risk. `htmlExtract.js` now enforces a 2 MB `MAX_PARSE_BYTES`
  ceiling; oversized bodies skip the DOM parse and route through the existing
  notice envelope (`outcome: 'too_large'`, never paged).
- **R2 (MED-HIGH)** — low-content/challenge bodies were logged but still returned
  to the model. (a) `OpenUrl._call` now maps the extractor `outcome: 'low'` to a
  `{ error, code: 'blocked_or_js_required', url }` result instead of a blank
  envelope; (b) `fetcher.js` detects anti-bot/JS-challenge markers
  (Cloudflare / DataDome / PerimeterX) on the raw HTML **before** extraction and
  throws `blocked_or_js_required`.
- **R1 + Residual A (HIGH, log-only Phase 1)** — `open_url` migrated from
  `toolConstructors` to the request-scoped `customConstructors` map (mirrors
  `image_gen_oai`) so the instance can read the current request. It derives the
  set of URLs the user pasted in the current message and **logs a metric** (never
  blocks) when the fetched host wasn't user-provided, or when a fetched URL on a
  user-provided host carries query params absent from the pasted URLs. Phase-2
  enforcement and full-history host-set are deferred to a follow-up ticket.

**Structured-data fallback (boost, zero new deps):** when Readability + html-to-text
yield below `LOW_YIELD_CHARS`, `htmlExtract.js` backstops thin/marketing pages by
extracting from JSON-LD (`Product`/`Article`), `og:description`, the meta
description, and `<title>` before `'low'` is declared. This improves resilience on
thin pages and provides a high-quality backstop on the knauf.com product pages
(see Deferred / Future Work for the empirical finding that those pages are not
empty shells).

## References

- `packages/api/src/endpoints/openai/llm.ts` (181-274) — emits the Azure-native
  `web_search` hosted tool from `model_parameters.web_search` (works on gpt-5.4 —
  see the Correction in Current Behaviour).
- `packages/api/src/endpoints/openai/config.ts` (150-174) — `constructAzureResponsesApi`
  rewrites Responses calls to `/openai/v1` with `api-version=preview`, so the stale
  group version never reaches `/responses`.
- `packages/api/src/auth/agent.ts` — upstream `createSSRFSafeUndiciConnect`
  that `open_url` (and MCP HTTP/SSE/streamable-HTTP transports) use.
- `packages/api/src/auth/domain.ts` — `isPrivateIP` with the `[knauf]`
  IPv6 canonicalisation seam.
- `packages/api/src/tools/registry/definitions.ts` — `[knauf]` `open_url`
  registry entry (canonical schema + description).
- `api/server/services/ToolService.js` — `[knauf]` web-search-gated injection
  in `loadToolDefinitionsWrapper` (definitions) and `loadAgentTools` (execution).
- `librechat.yaml` — `endpoints.agents.capabilities`, `addParams.web_search`,
  `includedTools` (note: `open_url` is deliberately absent — it rides the
  web-search switch instead).
- `agk-deployment-configs/agentic-karl/{dev,prod}/network-policy/values.yaml`
  — current egress posture.
- `knauf/docs/reference/agentic-karl-architecture.md` § Networking — hub/spoke
  CIDRs and egress rules.
- Microsoft Learn: *Browser Automation Tool* (preview, 2026-06-05); *Function
  calling with Azure OpenAI* (GA, 2026-05-13); *Grounding with Bing* (data
  boundary note).

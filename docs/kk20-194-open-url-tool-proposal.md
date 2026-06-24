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

- The Azure OpenAI **Responses API has no built-in `web_search` / URL-opener
  tool**. Our config currently passes `addParams.web_search: true`, which
  `packages/api/src/endpoints/openai/llm.ts` translates into
  `tools: [{ type: 'web_search' }]`. Azure silently ignores it.
- Agent builder capabilities are intentionally restricted to `file_search` and
  `tools` (`librechat.yaml`). Native LibreChat web search would also need a
  search/scraper/reranker provider, none of which are provisioned.

## Options Considered

| Option | Opens specific URL? | Data stays on Azure? | Effort | Status |
|---|---|---|---|---|
| A. Config-only ("tell Azure to view the link") | No | n/a | n/a | Not possible — tool does not exist on Azure |
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
  (`open_url` plugin entry), `.../index.js` (export), `.../util/handleTools.js`
  (`toolConstructors.open_url`). All tracked in `SEAMS.md`.
- `librechat.yaml` — add `open_url` to `includedTools`. **No prompt-prefix
  paragraph** — the Tool's own `description` carries the usage and
  prompt-injection guidance, so it follows the tool to any future agent.

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
2. Manual smoke: paste an article URL and a PDF URL into Karl; verify
   extraction + the non-HTML notice.
3. Validate against an *internal* hostname to confirm SSRF deny.
4. Gather feedback for one week, then promote to prod via the existing
   promotion flow.
5. Update `SEAMS.md`, update the user-facing release notes, close KK20-194
   with a link to this proposal.

## Deferred / Future Work

- **JS-heavy SPA pages** → Azure Foundry Browser Automation Tool once GA;
  add as a second structured tool that falls back from `open_url`.
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
  upstream files (one `[knauf]` seam in `domain.ts` for the IPv6 fix; three
  small registration seams in `api/app/clients/tools/{manifest.json,
  index.js, util/handleTools.js}`; all SEAMS-tracked). All net-new code
  lives in `api/app/clients/tools/structured/openUrl/` or `packages/knauf/`.
- **Prompt injection via fetched content** — mitigated by the
  `<UNTRUSTED_WEB_CONTENT>` envelope (inner-tag mangled), explicit
  Tool-description warning, and the coarse error taxonomy that prevents the
  tool itself from echoing internal IPs back into the LLM context.

## References

- `packages/api/src/endpoints/openai/llm.ts` (271-274) — current `web_search`
  tool emission that Azure OpenAI silently ignores.
- `packages/api/src/auth/agent.ts` — upstream `createSSRFSafeUndiciConnect`
  that `open_url` (and MCP HTTP/SSE/streamable-HTTP transports) use.
- `packages/api/src/auth/domain.ts` — `isPrivateIP` with the `[knauf]`
  IPv6 canonicalisation seam.
- `librechat.yaml` — `endpoints.agents.capabilities`, `addParams.web_search`,
  `includedTools`.
- `agk-deployment-configs/agentic-karl/{dev,prod}/network-policy/values.yaml`
  — current egress posture.
- `knauf/docs/reference/agentic-karl-architecture.md` § Networking — hub/spoke
  CIDRs and egress rules.
- Microsoft Learn: *Browser Automation Tool* (preview, 2026-06-05); *Function
  calling with Azure OpenAI* (GA, 2026-05-13); *Grounding with Bing* (data
  boundary note).

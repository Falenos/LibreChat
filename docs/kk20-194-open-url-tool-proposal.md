# Proposal: Lean `open_url` Tool for Karl (KK20-194)

Status: Draft for review
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

### Components

- `packages/knauf` — pure `fetchAndExtract(url, { maxLength, startIndex })`
  function. Dependencies (`@mozilla/readability`, `jsdom`, `html-to-text`)
  isolated to the Knauf workspace per fork rules.
- `api/app/clients/tools/structured/OpenUrl.js` — LangChain structured tool
  (`pluginKey: open_url`) calling `fetchAndExtract`.
- Three small `[knauf]` registration seams:
  `api/app/clients/tools/manifest.json`, `.../util/handleTools.js`,
  `.../index.js`. All tracked in `SEAMS.md`.
- `librechat.yaml` — add `open_url` to `includedTools`; add a one-line prompt
  nudge to the default `karl` `promptPrefix` ("if the user pastes a URL, use
  `open_url` to read it"). Tier 0 change.

### Safety controls (in the tool, not relying on infra)

- **AGK-aware SSRF deny-list** before each request and on every redirect:
  - Spoke CIDRs `10.160.0.0/16` (dev) and `10.161.0.0/16` (prod)
  - All RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
  - Link-local `169.254/16` (including AKS metadata `169.254.169.254`)
  - Loopback / IPv6 ULA / IPv6 link-local
  - Resolve the hostname *after* DNS lookup and re-check on every redirect.
- HTTPS-only with an HTTP allow-list flag (default off).
- Hard caps: request timeout (e.g. 10 s), response size (e.g. 5 MB), max
  redirects (5), single concurrent fetch per call.
- No logging of request body / fetched content; URL logged at info, query
  string stripped.
- Custom user-agent identifying Agentic Karl.

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

- **SSRF blast radius if deny-list is incomplete** — mitigated by explicit
  AGK-CIDR deny + redirect re-check + unit tests asserting blocks for
  representative internal hosts.
- **Hub Azure Firewall FQDN restriction** — could silently break arbitrary
  user URLs; verification action above.
- **Upstream merge churn** — minimised by keeping logic in `packages/knauf`
  and the LibreChat-side seams to three small touchpoints, all SEAMS-tracked.

## References

- `packages/api/src/endpoints/openai/llm.ts` (271-274) — current `web_search`
  tool emission.
- `librechat.yaml` — `endpoints.agents.capabilities`, `addParams.web_search`,
  `includedTools`.
- `agk-deployment-configs/agentic-karl/{dev,prod}/network-policy/values.yaml`
  — current egress posture.
- `knauf/docs/reference/agentic-karl-architecture.md` § Networking — hub/spoke
  CIDRs and egress rules.
- Microsoft Learn: *Browser Automation Tool* (preview, 2026-06-05); *Function
  calling with Azure OpenAI* (GA, 2026-05-13); *Grounding with Bing* (data
  boundary note).

# PII masking & data anonymization for Agentic Karl (KK20-207)

> [!IMPORTANT]
> **This is v1.2 (the 2026-07-06 recheck), restored to `main` on 2026-09-01.** Read it with
> **[workstream.md](./workstream.md)** beside it — that doc's §2 carries the verified delta for the
> ~8 weeks *after* this recheck, and its §5 carries the ticket set that supersedes §9 here.
>
> What this version is good for: §1's data map, §3's strategy and handling matrix, §5's solution
> landscape, §11's claim-by-claim verification log, and §12's future-problem register — the
> analysis that made the strategy defensible.
>
> What it does **not** yet know (all captured in workstream.md §2, pending the v1.3 delta in
> ticket DOC-1):
>
> - **§1.3's "Not yet wired: Langfuse" is false.** Langfuse is live in dev *and* prod, capturing
>   prompts, completions, memory values and feedback. §12.2 listed exactly this as an activation
>   trigger requiring a PII gate first; the gate was skipped.
> - **§2's "LibreChat does not do this OOTB" needs a qualifier** — upstream v0.8.7 shipped
>   `messageFilter.pii`. It is a regex *blocker*, not a masker, so the verdict mostly stands.
> - **§8's Phase 0/1 items are partly shipped**, and Phase 2's `retentionMode` lever turns out to
>   be a data-deleting one-way door rather than the config flip it looks like.
> - Three sinks post-date it entirely: the `auditLog` collection, Azure AI Search as a second
>   vector store, and model **reasoning** content as a data category.

> **Status:** proposal / discovery output. This is the deliverable of **KK20-207**
> ("PII masking and data anonymization", related epic **KK20-80**). It classifies the personal
> data Agentic Karl handles, maps where it lives, proposes a per-category protection strategy
> (mask / pseudonymize / anonymize / exclude / retain-then-delete, differentiated by use case),
> surveys the solution landscape, and lists the risks, stakeholder questions, and follow-up
> implementation tickets. **No masking is implemented by this doc** — it exists so an agreed
> strategy can be turned into scoped tickets. Implementing masking, final legal sign-off, and
> vendor selection are explicitly out of scope (they are the follow-ups in §9).
>
> **Recheck — 2026-07-06 (v1.1):** every code-level claim in §1/§2 was re-verified against
> `main` @ v0.95.0, and the features that landed since the v1 snapshot (Azure AI Search agent
> routing, per-user content-hash dedup, cascade file cleanup, the `open_url` tool, cost
> visibility, the MCP-server config) are folded in. Corrections are applied inline; the
> claim-by-claim audit trail is **§11 (verification log)**, forward-looking risks are
> **§12 (future-problem register)**, and §8 is expanded into a detailed, dependency-mapped
> roadmap. One v1 prediction has already materialized: agent-file cascade deletes skip Azure
> AI Search on `main` today (fix in flight as PR #115) — see §7.1.
>
> **Interactive companion:** removed. It was a v1.0 snapshot whose data-flow map and handling
> matrix showed none of the sinks added since (Langfuse, `auditLog`, Azure AI Search), so it
> misrepresented the system on exactly the tabs people opened it for. This document and
> [workstream.md](./workstream.md) are authoritative.
>
> **Pairs with:** [../future-work/file-management-roadmap.md](../future-work/file-management-roadmap.md)
> (its S6 "DLP" and T3 "90-day retention sweep" rows are refined here into a phased plan),
> [../implementation-plans/adobe-analytics-onetrust.md](../implementation-plans/adobe-analytics-onetrust.md)
> (the analytics consent stack — the fork's one already-shipped privacy control, used here as the
> model pattern), and [../implementation-plans/langfuse-rollout.md](../implementation-plans/langfuse-rollout.md)
> (LLM observability — a future PII surface, flagged in §7).

---

## TL;DR

Agentic Karl handles personal data everywhere a chat assistant does: prompts and responses,
uploaded files and their extracted text, auto-generated titles, long-lived "memories" about
users, search indexes, logs, and identity records. **LibreChat ships no PII masking,
anonymization, or redaction out of the box** — only secrets-only log redaction, content
moderation (not PII), and temporary-chat retention. So whatever protection Knauf wants, Knauf
builds or buys.

**The load-bearing recommendation: protect the durable copies and the logs first; do *not*
mask prompts before the model by default.** The model call itself is the *least* risky hop —
Azure OpenAI runs inside Knauf's own tenancy under Microsoft's no-training terms and the EU Data
Boundary. The real GDPR exposure is the data that *persists without a purpose*: message content
written to debug logs (on today by default), conversations and memories stored forever with no
TTL, a full-text search replica, and publicly-shareable links. Masking `Frau Müller` →
`<PERSON_1>` before the model would wreck the product (a corporate assistant is *supposed* to
reason over names, customers, and projects) and push users back to public ChatGPT — a strictly
worse privacy outcome, and exactly the "strictly opt-in only" line the LibreChat maintainer drew
upstream.

**Recheck delta (2026-07-06):** the strategy holds, but the map moved. Two stores were added —
**Azure AI Search** (chunks + embeddings when `AZURE_SEARCH_ENABLED=true`; intended for agent
knowledge files, but on `main` first-upload personal chat attachments route there too — §1.1 row 4)
and **per-user cost records** (token counts priced in EUR, per conversation/message) — and two
egress surfaces are live that v1 didn't cover: the **`open_url` tool** (server-side page fetches
from hosts named in prompts; SSRF-guarded, provenance-logged) and **user-created MCP servers**
(`mcpServers.create/share/public: true` — currently ungoverned). One predicted risk is now a
confirmed gap: cascade deletion of agent files does not propagate to Azure AI Search (PR #115
fixes it, and also narrows the over-broad upload routing). On the good-news side, the account-deletion cascade turned out to be comprehensive
(23 stores), and Meilisearch *does* have a per-field indexing knob — both v1 claims corrected
in place.

A five-phase roadmap follows the risk, not the hype:

- **Phase 0 — config quick wins (partly shipped; days).** `DEBUG_LOGGING` off in `.env.example`
  (done) and in prod config, land the Azure-Search delete fix (PR #115), decide the MCP-server
  exposure default, document the logging posture, review shared-link defaults, fix the OpenID
  login that logs email/name at info level.
- **Phase 1 — log-layer PII redaction.** Extend the existing secrets-only redactor to scrub
  email / IP / phone / IBAN / ID patterns at *all* log levels.
- **Phase 2 — retention & minimization.** Real TTLs for conversations, memories, shared links,
  and violation records; verify search + storage deletion actually propagates.
- **Phase 3 — a masking *engine*, at persistence chokepoints only.** Prove out an engine (a PoC
  spike is the decision mechanism — see §6) and wire it where masking has clear ROI and no
  streaming problem: shared-agent knowledge-file ingestion and memory writes.
- **Phase 4 — optional, opt-in inline masking.** Only for designated high-risk flows, input-side
  only (streaming makes output-side masking unreliable — §5), and only after a product decision
  that the utility loss is worth it.

**The engine choice is deliberately left open.** Microsoft Presidio (self-hosted, free, strong
German coverage), Azure AI Language PII (managed, container option), a hybrid, or a commercial
tool are all viable; §6 gives the criteria and proposes a PoC to settle it on Knauf data rather
than on vendor claims.

---

## 1. Data classification overview

### 1.1 What personal data Agentic Karl handles, and where it lives

Every path below is repo-relative. "Sensitivity" is a coarse P0/P1/P2 triage, not a formal
Knauf data class — mapping to the official scheme is a DPO follow-up (§7).

| # | Data category | Where it lives (file / store) | What it can contain | Sens. | Current control |
|---|---|---|---|---|---|
| 1 | Prompts & responses | Mongo `messages.text` / `content[]` (`packages/data-schemas/src/schema/message.ts`) | Anything a user types or the model returns — names, emails, customer data, health, opinions | P0 | None (stored verbatim, indefinitely) |
| 2 | Conversation titles | Mongo `convos.title` | Auto-generated *from* message content → same class as #1 | P0 | None |
| 3 | Search index | Meilisearch (`packages/data-schemas/src/models/plugins/mongoMeili.ts`) | Full-text **replica** of message text + titles | P0 | Temp chats excluded; per-field `meiliIndex` flags exist (only `user` filterable); delete hooks verified |
| 4 | File bytes, text & embeddings | Azure Blob (bytes); pgvector via the now-external `rag_api`; **Azure AI Search** when `AZURE_SEARCH_ENABLED=true` (intended: agent files; on `main` the `entity_id`-keyed routing sweeps in first-upload chat attachments too — PR #115 narrows it via `isAgentFile`); Mongo `files` (metadata + dedup fields — `text` mostly unpopulated on file-search paths) | Extracted/OCR'd chunks + vectors (extraction happens inside `rag_api` / Azure DI) | P0 | Per-user dedup (KK20-204); cascade delete (KK20-203) — **Azure-Search leg missing on `main`, fix = PR #115** |
| 5 | Memories | Mongo `memory.value` (`packages/data-schemas/src/schema/memory.ts`) | LLM-written personal facts about the user (profiling-grade) | P0 | Per-user on/off toggle; **no TTL** |
| 6 | User identity | Mongo `users` | Email, name, username, OAuth subject IDs (incl. Entra `idOnTheSource`), avatar, 2FA secrets, refresh tokens | P0 | Auth-scoped; tenant isolation |
| 7 | Logs | winston → `api/logs/*.log` (`api/config/winston.js`, `parsers.js`) | Message content when `DEBUG_LOGGING=true`; email/name at login; client IP | P1 | Secrets-only redaction; **JS copy redacts error+warn, TS copy error-only (diverged)**; 14d rotation |
| 8 | Analytics | `client/src/knauf/analytics/` (Adobe + OneTrust + Datadog) | Page views, interactions | P2 | **Already PII-minimized by design** (see §1.2) |
| 9 | Shared links | Mongo `sharedLink` (`share.ts`) | Public snapshot of a conversation's title + messages | P1 | `isPublic` default **true**, no TTL |
| 10 | Exports | Client-side (`useExportConversation.ts`) | Full conversation to user's disk | P1 | User-initiated |
| 11 | Feedback | Mongo `message.feedback.text` | Free-text thumbs-up/down comments | P1 | None |
| 12 | Violation / ban records | Redis (`api/cache/logViolation.js`, `banViolation.js`) | `userId` + IP address | P1 | Security-scoped; **ban entries expire with `BAN_DURATION`; general violation log unbounded**; ban events also log IP at info level |
| 13 | Outbound calls | Azure OpenAI, Azure Document Intelligence, MS Graph, **+ `open_url` page fetches to arbitrary hosts named in prompts** | Prompts, memory, titles, file bytes, avatar/group lookups; fetched page content enters the conversation | P0 | In-tenancy + EU Data Boundary + DPA for Azure/Graph; `open_url` is SSRF-checked + provenance-logged, gated on browse mode |
| 14 | Secrets at rest *(adjacent, not PII)* | `action.metadata`, `pluginAuth.value`, `key.value` | Third-party OAuth secrets / API keys | P1 | None — flagged for a security ticket |
| 15 | Cost / usage records *(new, KK20 cost visibility)* | Mongo `transactions` (`packages/data-schemas/src/schema/transaction.ts`) + 1-day summary cache | Per-user, per-conversation, per-message token counts priced in EUR | P2 | User-scoped, access-controlled; **per-employee usage metering → works-council relevance (§12)** |
| 16 | MCP servers *(user-created)* | `librechat.yaml` `mcpServers` (`use/create/share/public: true`); payloads go to whatever endpoint the user configures | Tool arguments — which can carry message content — sent to third-party servers | P0 (potential) | **No catalogue, DPA review, or governance yet** — flagged §7/§12; agent *actions* remain disabled |

### 1.2 Data-flow narrative

A user's message enters through the KARL API (`api/server`). From there it fans out to:
**Azure OpenAI** (the completion, plus title generation, the memory agent, and native web
search); **Azure Document Intelligence** for uploaded-file OCR (now invoked inside the external
`rag_api` service); and **Microsoft Graph** for avatar and group resolution at login. It is
persisted to **MongoDB** (messages, conversations, memories, files, users, transactions),
**replicated to Meilisearch** for search, **embedded by `rag_api`** into **pgvector** — or into
**Azure AI Search** when `AZURE_SEARCH_ENABLED=true` (agent knowledge files by intent; on `main`
first-upload chat attachments as well, until PR #115's `isAgentFile` routing lands) — and, for
uploaded bytes, stored in **Azure Blob** behind short-TTL SAS URLs (per-user content-hash dedup
means one blob + one embedding set per `(user, hash)`). Cross-cutting: **winston logs** to disk,
**Redis** holds violation/ban records and caches, and the **client analytics** stack emits
consent-gated events (including a Datadog RUM/browser-logs channel). The SERPER / Tavily /
Firecrawl web-search pipeline remains dormant (verified — keys unset), but two non-Azure egress
paths now exist: the **`open_url` tool** fetches pages from hosts named in user prompts
(server-side, SSRF-checked, provenance-logged, gated on browse mode), and users can currently
**create and share MCP servers**, whose tool calls would carry content to third-party endpoints.

### 1.3 What already exists in this fork

The fork is not starting from zero. These controls are in place and inform the strategy:

- **Log secret-redaction** — winston's `redactMessage` (`api/config/parsers.js` and its duplicate
  `packages/data-schemas/src/config/parsers.ts`) scrubs `sk-…`, `Bearer …`, `api-key`, and
  `key=` tokens. **Secrets only — and the two copies have already diverged**: the JS copy
  redacts at error+warn, the TS copy at error only. Debug level is never redacted in either.
- **File-lifecycle controls (shipped since v1)** — per-user content-hash dedup (KK20-204:
  `knauf_content_hash` / `knauf_asset_id` / `knauf_dedup_owner` on the File schema; strictly
  `(user, hash)`-scoped, so no cross-user sharing) and cascade file cleanup on conversation
  delete (KK20-203: Mongo rows + blob + pgvector via `cascadeDeleteConvoFiles`, with a two-stage
  dedup-aware GC). These are the file-management roadmap's T1/T2 rows, now real. **Known gap:**
  the cascade misses Azure AI Search on `main` (deletes reach Azure only for `context === 'agents'`,
  so mis-routed chat-attachment embeddings are orphaned outright); PR #115 routes agent-file
  deletes to `/agent/documents/{file_id}`, narrows upload routing via `isAgentFile`, and must land
  before Azure Search rollout widens.
- **`open_url` guardrails (KK20-194)** — the page-fetch tool is SSRF-hardened (private-IP
  blocks, per-redirect re-checks), hidden from tool pickers, gated on the browse toggle, and
  logs a provenance warning when a fetched URL was not pasted by the user or carries novel
  query parameters — a useful early-warning signal for prompt-injected exfiltration.
- **PII-minimized analytics** — the Adobe Analytics + OneTrust + Datadog RUM stack
  (`client/src/knauf/analytics/`) is already designed for minimization: masked page paths
  (`/c/:conversationId`), query-string *keys only*, a random per-session id, Datadog
  `defaultPrivacyLevel: 'mask-user-input'` with session replay off, all consent-gated, no user
  identity attached. **This is the model pattern for every future data-emitting feature.**
- **Sanitized diagnostics endpoint** — `api/server/routes/knauf/analyticsDiagnostics.js`
  allow-lists event names and caps strings at 160 chars.
- **Short-TTL SAS blob URLs** (KK20-167 / KK20-199) — private-by-default containers, signed URLs
  expiring in ~5–10 min, now with clock-skew backdating and just-in-time re-signing on download
  and on the agent send path (KK20-199).
- **Account-deletion cascade — verified comprehensive.** `UserController.js:325-379` deletes 23
  stores on account deletion (messages, convos, files + vectors, memories, shared links, presets,
  tokens, ACL entries, …). The v1 open question "is upstream's deletion fix present?" is answered
  at code level; what remains is a staging-level verification recipe (§8 Ph2), including the
  Azure-Search leg.
- **Tenant isolation** — `packages/data-schemas/src/models/plugins/tenantIsolation.ts` scopes
  every document by `tenantId` (queries, updates, saves, aggregations).
- **GDPR-aware EULA** — the `interface.modalContent` in `librechat.yaml` cites the user's GDPR
  rights (Art. 13, 15–18, 20, 7(3)).
- **Retention primitives** — temporary chats (`interface.temporaryChat`, TTL via `expiredAt`
  with Mongo `expireAfterSeconds` indexes on convos *and* messages, excluded from Meilisearch)
  exist upstream and are available to turn on. Verified **not enabled** in `librechat.yaml` today.
- **Not yet wired: Langfuse** — all three `LANGFUSE_*` keys are commented out in `.env.example`
  (verified); the integration is not active. If switched on it would capture prompts and
  completions verbatim → a future PII gate (§7, §12).
- **New since v1, needs review: Datadog browser logs** — `api/server/routes/knauf/datadogConfig.js`
  serves the client a RUM **and browser-logs** configuration. Session replay is off, input is
  masked, it is consent-gated, and forwarding is limited to `console.error` plus uncaught errors
  (`forwardConsoleLogs: ['error']` in `client/src/knauf/analytics/datadog/config.ts`) behind a
  `logsBeforeSend` noise filter — but those error payloads are **not PII-scrubbed** before leaving
  for a third-party cloud. Flagged as a Ph1 review item (§8).
- **New since v1: cost visibility** — per-message/per-conversation token counts priced in EUR,
  stored per user in Mongo `transactions` and surfaced in the chat UI. Not message content, but
  it *is* per-employee usage metering — see §12 for the works-council angle.

---

## 2. Does LibreChat do this out of the box? No.

We checked the official docs and the upstream repo. The verdict for the specific question —
"does LibreChat mask / anonymize / redact PII in prompts, responses, or files?" — is **no**, and
the privacy-adjacent features it *does* have are different things:

- **PII masking is an unmerged community request, not a feature.** The canonical thread is
  [Discussion #12370 "PII Anonymization Layer for File Uploads"](https://github.com/danny-avila/LibreChat/discussions/12370)
  — it proposes `@redactpii/node` or a **Presidio sidecar**. The maintainer's stated position is
  that it must be **strictly opt-in** ("if it's not explicitly configured, it shouldn't exist as
  far as the core code is concerned"); a draft exists on a contributor branch, nothing is
  released. This directly validates our §3 stance against default masking.
- **Log redaction covers secrets, not PII.** The winston redactor scrubs API keys and bearer
  tokens ([PR #13561](https://github.com/danny-avila/LibreChat/pull/13561),
  [PR #12737](https://github.com/danny-avila/LibreChat/pull/12737)); message content — including
  any PII — still reaches debug logs. `DEBUG_LOGGING` defaults **on** in code
  (`api/config/winston.js:41`); this fork's `.env.example` now ships it **off**, but the deployed
  value lives in `ct-shared-deployment-configs` and still needs explicit verification (§7.2).
- **Moderation ≠ PII.** `OPENAI_MODERATION` and the `BAN_VIOLATIONS` scoring system
  ([mod docs](https://www.librechat.ai/docs/configuration/mod_system)) handle content policy and
  abuse — no PII capability. (`OPENAI_MODERATION` is `false` in this fork anyway.)
- **Retention is partial.** Temporary chats auto-delete and are search-excluded
  ([temp-chat docs](https://www.librechat.ai/docs/features/temporary_chat)); **normal
  conversations are stored indefinitely** with no built-in TTL and there is **no data-export /
  portability endpoint**. Account deletion historically left orphaned metadata
  ([Issue #10540](https://github.com/danny-avila/LibreChat/issues/10540), fixed by PR #10534) —
  **recheck result: the fix is present**; our baseline's deletion cascade covers 23 stores
  (§1.3). Remaining verification is behavioral (staging recipe, §8 Ph2), not code archaeology.
- **RAG ingests verbatim.** [`rag_api`](https://github.com/danny-avila/rag_api) chunks and embeds
  document text with no PII handling.
- **No prompt-preprocessing hook.** `librechat.yaml`'s interface object has no filter / DLP /
  transform surface — masking cannot be turned on by configuration; it needs a code seam or an
  external layer.

---

## 3. Protection strategy

### 3.1 The core argument: protect data at rest and in logs, not the model call

Four steps, each grounded in the findings above:

1. **The model call is the least risky hop.** Azure OpenAI (`cst-karl-dev`), Azure Document
   Intelligence, and Microsoft Graph all run inside Knauf's tenancy, under Microsoft's product
   terms (no training on Knauf data, no third-party sharing) and the EU Data Boundary. Legally
   this is processing within the existing controller→processor chain — the same category as email
   in Exchange Online. *(One caveat that must be verified — Azure OpenAI abuse-monitoring may
   retain prompts up to 30 days unless the tenant has the modified-abuse-monitoring opt-out. This
   is the single strongest counter-argument to this whole position and is the first open question
   in §7.)*
2. **Inline masking destroys the product.** A corporate assistant's core jobs — "draft an email
   to Frau Müller about the Iphofen order", "summarize this customer complaint" — are inherently
   PII-laden. Replacing entities with placeholders before the model produces useless output and
   drives users to unsanctioned tools. This is also exactly why upstream will only accept masking
   as opt-in (§2).
3. **The durable copies are the real GDPR risk.** Art. 5(1)(c) (minimization) and 5(1)(e)
   (storage limitation) bite where data persists *without a purpose*: messages and memories with
   no TTL, a full-text Meilisearch replica, debug logs receiving content, publicly-shareable
   links. **None of these is fixed by an LLM gateway; all are fixed by redaction-at-the-sink and
   retention.**
4. **Therefore the priority order is:** (1) logs / observability, (2) retention / TTL,
   (3) analytics — *already done*, keep it as the pattern, (4) *optional, opt-in* inline masking
   for designated high-risk flows only.

### 3.2 Design tensions, resolved

- **Masking vs utility** — rejected as a default (step 2). Reserved as opt-in per model-spec /
  agent for designated high-risk flows (e.g. an HR or legal agent, or shared knowledge bases),
  input-side only.
- **Streaming** — output-side masking of a live token stream is an unsolved problem (a placeholder
  can split across chunks; gateways commonly skip output guards on streamed responses — see §5).
  **Every masking point we recommend is non-streamed**: log formatters, RAG ingestion, memory
  writes, title generation. Masking live chat *output* is out of scope for all phases.
- **German & multilingual** — Knauf operates in ~90 countries; German is non-negotiable. This
  materially shapes the engine choice (§6): Azure's *conversational* PII is German-preview-only,
  while Presidio ships a German model plus German national-ID recognizers with no preview caveat.

### 3.3 The per-category handling matrix

Legend: **AS** as-is · **M** mask (one-way) · **P** pseudonymize (reversible placeholder) ·
**AN** anonymize / aggregate · **X** exclude · **TTL** retain-then-delete · **—** N/A.
Phase tags (Ph0–Ph4) reference the roadmap in §8.

| # | Category | Runtime→LLM | Persistence | Analytics | Observability | Debug/Support | Reporting | Retention |
|---|---|---|---|---|---|---|---|---|
| 1 | Prompts/responses | AS | AS | X (done) | **X** (Ph0/1) | P-view | AN | **TTL** (Ph2) |
| 2 | Conversation titles | AS | AS | X | X | P-view | AN | TTL w/ convo |
| 3 | Meilisearch index | — | AS | X | X | restricted | — | **TTL** (Ph2) |
| 4 | File text + pgvector | AS | AS private; **M/flag** shared (Ph3) | X | X | restricted | — | TTL sweep |
| 5 | Memories | AS (read) | **P/M on write** (Ph3) | X | X | X | — | **TTL** (Ph2) |
| 6 | User identity | — | AS | P (done) | **X** (Ph0) | P-view | AN | lifecycle |
| 7 | Logs | — | — | — | **X content (Ph0) + M patterns (Ph1)** | M | — | 14d rotation |
| 8 | Analytics | — | — | **AS (already clean)** | — | — | AN | consent-gated |
| 9 | Shared links | — | AS + **review default** (Ph0) | X | X | — | — | **TTL** (Ph2) |
| 10 | Exports | — | AS (user-owned) | X | X | — | — | user-owned |
| 11 | Feedback | — | AS | X | X | P-view | **AN** | TTL w/ convo |
| 12 | Violation/ban (IP) | — | AS (security) | X | M (Ph1) | restricted | AN | ban=`BAN_DURATION`; **TTL for the rest** (Ph2) |
| 13 | Outbound Azure/Graph + `open_url` | AS* | — | — | X (never log payloads) | — | — | MS terms; `open_url` provenance-monitored (Ph1) |
| 14 | Secrets at rest | — | security ticket | — | X | — | — | — |
| 15 | Cost/usage records | — | AS (user-scoped) | X | X | restricted | **AN only** | align with convo TTL (Ph2) |
| 16 | MCP servers (user-created) | **gate** (Ph0 decision) | — | X | X (never log payloads) | — | — | catalogue + DPA per server (§12) |

Row-by-row rationale:

1. **Prompts/responses** — the utility argument (§3.1). Risk is concentrated at rest and in logs,
   not in the in-tenancy call, so the levers are log-exclusion and a retention TTL (period set by
   the DPO), not pre-model masking.
2. **Titles** — derived from content, so same class as #1. Title generation is non-streamed, so
   it's a *candidate* for optional masking later, not a priority.
3. **Meilisearch** — a second full-text copy of all conversation content. *Correction from the
   recheck:* `mongoMeili` **does** have a per-field knob — only fields flagged `meiliIndex: true`
   are replicated — so field minimization is a Tier-5 schema edit, not an upstream feature
   request (it is still upstream-sync-sensitive). Only `user` is filterable; delete hooks
   (single + `deleteMany`) are present. Near-term control stays TTL synced with Mongo plus a
   staging delete-propagation check.
4. **File bytes/text + vectors** — private chat files stay as-is; the ROI case is **shared-agent
   knowledge files**, whose embeddings are exposed to *other* users — the one persistence flow
   where scanning/flagging/masking before embed clearly pays off (Ph3). *Recheck:* those agent
   files now land in **Azure AI Search** when enabled (on `main` the routing is over-broad and
   also embeds first-upload private chat attachments — PR #115 narrows it), which (a) adds a store the delete cascade
   must reach — the missing leg is exactly what PR #115 fixes — and (b) means the Ph3 ingest
   chokepoint sits in front of *two* vector sinks, so mask-before-embed covers both at once.
   Extraction itself happens inside the external `rag_api`; `files.text` in Mongo is mostly
   unpopulated on these paths.
5. **Memories** — LLM-written personal facts are profiling-grade and have no TTL today. The
   memory-agent write is a backend, non-streamed chokepoint — the *ideal first* place to apply
   pseudonymization (Ph3) — plus a staleness/TTL purge (Ph2).
6. **User identity** — needed as-is for auth; the fix is removing it from logs (the OpenID
   info-level leak, Ph0) and verifying deletion completeness.
7. **Logs** — the biggest quick win: stop writing content (Ph0), then redact PII patterns at all
   levels (Ph1).
8. **Analytics** — already minimized; the rule is that *new* events must pass the same review.
9. **Shared links** — an exposure surface, not a masking problem: review the `isPublic` default
   (Ph0) and add expiry (Ph2).
10. **Exports** — a user-initiated portability feature; DLP-at-egress is a separate security
    concern, out of scope here.
11. **Feedback** — free-text; only reaches reporting in aggregate.
12. **Violation/ban** — security is a legitimate-interest purpose. *Recheck nuance:* ban entries
    already expire with `BAN_DURATION`; it's the general violation log that is unbounded — bound
    it (Ph2) — and ban events write the raw IP to the info log (Ph1 redaction).
13. **Outbound** — as-is into the in-tenancy services (*verify abuse-monitoring opt-out); never
    log the payloads; optional opt-in masking for designated flows in Ph4. `open_url` is the one
    non-Azure content flow: fetched pages enter the conversation and the requested URL leaves the
    tenancy — keep the SSRF + provenance guardrails, monitor their warnings (Ph1), and revisit an
    allowlist if warnings recur.
14. **Secrets at rest** — adjacent, non-PII; folded into a security-hardening ticket.
15. **Cost/usage records** — token counts, not content, and access-controlled — but they meter
    individual employees' AI usage. Keep them user-scoped, aggregate-only in any report, align
    retention with conversations (Ph2), and clear the works-council question (§12) before any
    manager-facing view is even discussed.
16. **MCP servers** — the config currently lets any user create and publicly share a server;
    every tool call ships its arguments to that endpoint. Until a curated catalogue with per-server
    DPA/ToS review exists, the default should be decided deliberately (Ph0 decision): at minimum
    `public/share: false`, plausibly `create: false` outside a pilot group. This is the largest
    *ungoverned* egress surface found by the recheck.

**Debug/support doctrine** (a process rule for the DPO section, not code): support staff never
read raw production content; debugging uses redacted log views; any raw-data access is
purpose-logged and time-boxed.

---

## 4. Context-specific rules

Normative rules the follow-up work should encode, grouped by the ticket's use-case contexts:

- **Runtime (processing to the model)**
  - **R1** — Content sent to *in-tenancy* Azure services (OpenAI, Document Intelligence, Graph) is
    **not masked by default**; utility wins, and the DPA + EU Data Boundary carry the lawful basis.
  - **R2** — Inline masking is **opt-in per model-spec / agent**, input-side only, for designated
    high-risk flows.
- **Persistence**
  - **R3** — Anything stored MUST have a defined retention period and a delete path that cascades
    to *every* copy (Mongo + Meilisearch + pgvector + Azure AI Search + Blob).
  - **R4** — Memories are profiling data: pseudonymize on write and purge on staleness.
- **Analytics**
  - **R5** — New analytics events MUST match the existing Adobe/OneTrust pattern: no message
    content, no raw identity, consent-gated. This is reviewed, not assumed.
- **Observability / logs**
  - **R6** — **No message/prompt content at any log level in production.**
  - **R7** — Identifiers (email, IP, phone, IBAN, national IDs) are redacted by pattern at *all*
    levels, not just error/warn.
- **Debugging / support**
  - **R8** — Support reads redacted views; raw-content access is exceptional, authorized, logged,
    time-boxed.
- **Reporting**
  - **R9** — Reporting is aggregate-only; no row-level PII leaves for BI/reporting. This includes
    cost/usage records: per-user metering never feeds a manager-facing or performance view.
- **Third-party egress (new in v1.1)**
  - **R10** — Content may flow to a non-Azure third-party endpoint only via an approved catalogue
    entry with a recorded DPA/ToS review. User-created MCP servers and future agent actions
    default to disabled-or-private until that catalogue exists; `open_url` stays inside its SSRF +
    provenance guardrails.
- **Change management (new in v1.1)**
  - **R11** — Every upstream merge and every new fork feature runs a **PII-regression checklist**
    (new log sinks? new env-gated egress? new stores? redaction seams intact? — see §12.1). The
    JS/TS redactor divergence and the Azure-Search delete gap both slipped in exactly this way.

---

## 5. Solution landscape

No single recommendation is made here (see §6); this is the neutral comparison. Every factual
claim is sourced.

| Solution | Deployment | German / multilingual | Cost | Streaming | EU residency |
|---|---|---|---|---|---|
| **Microsoft Presidio** ([repo](https://github.com/microsoft/presidio)) | Self-host Docker / **AKS**; REST (Node-callable) | German model + DE national-ID recognizers; many langs via spaCy/transformers | **Free / OSS** (infra only) | Input-side fine; output re-hydration DIY & hard | Full — in-cluster |
| **Azure AI Language PII** ([docs](https://learn.microsoft.com/azure/ai-services/language-service/personally-identifiable-information/overview)) | Azure SaaS **or** connected / **disconnected container** | ~77 langs; German **text=GA**, **conversational=preview-only** | Per 1k text records (rate TBD) | Request/response API | EU regions; container = data never sent to MS |
| **Azure OpenAI PII content filter** ([docs](https://learn.microsoft.com/azure/ai-services/openai/concepts/content-filter-personal-information)) | Managed with the deployment | Advanced guardrails **English-only** | Included | Output-filter streaming mode exists | EU with EU deployment |
| **LLM-based redactor** (e.g. OpenAI Privacy Filter) | Self-host (open weights) or API | Multilingual (model-dependent) | Per-token / infra | Poor as an output guard | EU only if self-hosted |
| **LLM Guard** ([docs](https://protectai.github.io/llm-guard/)) | Self-host Docker HTTP API | **English-focused** | Free / OSS | Vault + Deanonymize scanners | Full — self-hosted |
| **Private AI / Limina** ([site](https://www.private-ai.com/)) | Container in VPC / marketplace | **52 langs incl. German** | Commercial (custom) | Reversible masking supported | Full — self-hosted |
| **Skyflow LLM Privacy Vault** | Managed vault / residency regions | Multilingual (verify DE) | Usage-based | Detokenize-on-response | GDPR residency |
| **AWS Comprehend PII** | AWS SaaS | **EN + ES only** | Per-unit | Req/response | Non-Azure → ruled out |

Key nuances for the doc's readers:

- **Azure OpenAI's content filter *does* have a PII option, but it is output-only** (it inspects
  completions, blocks/annotates, is not reversible, and its advanced guardrails are English-only).
  It is not a masking layer — worth enabling for output *annotation*, not a substitute for the
  strategy here.
- **The notable 2026 entrant is model-based redaction** (OpenAI Privacy Filter — open-weight,
  ~96% F1) — but non-determinism, over-redaction, and prompt-injection risk mean it must be
  self-hosted and treated cautiously.

### 5.1 Integration patterns

- **(a) LLM gateway** — LiteLLM proxy has native Presidio guardrails (`pre_call` MASK/BLOCK,
  `output_parse_pii`, `presidio_language: de`) and can sit in front of Azure OpenAI *without app
  changes* ([docs](https://docs.litellm.ai/docs/proxy/guardrails/pii_masking_v2)). But it masks at
  LLM egress — the wrong place, given we're *not* masking prompts by default — and its output
  re-hydration on streamed responses has an open bug.
- **(b) Chokepoint sidecar** — a Presidio (or equivalent) service called by specific app-side
  chokepoints (log formatter, RAG ingest, memory write). This matches the strategy: those flows
  are non-streamed and a gateway can't see them anyway.
- **(c) Reference: Microsoft "PII Shield"** — a stateless FastAPI proxy wrapping Presidio with
  `/anonymize` + `/deanonymize` session endpoints; a useful blueprint for the Ph4 opt-in flow.
- Mature deployments **split by PII class**: a gateway for uniform egress enforcement, app-layer
  where context is needed. Latency budget: regex < 2 ms, in-cluster NER ~35–70 ms, external API
  180–400 ms (a synchronous guard adds directly to time-to-first-token).

### 5.2 The streaming constraint

KARL streams responses token-by-token. Output-side masking on a stream is the hard, largely
**unsolved** problem: you either buffer the whole response before releasing it (losing the
streaming benefit) or scan chunks and risk a PII span splitting across a chunk boundary after it
has already been sent. Input-side masking has no such problem (the prompt is complete before the
call), which is another reason the strategy stays on input-side and persistence chokepoints.

---

## 6. Decision framework (engine choice left open)

This is a discovery deliverable; the engine/vendor decision belongs to legal + security +
architecture together, made on Knauf data rather than vendor claims. The shortlist:

- **Option A — Presidio, self-hosted on AKS (Tier 3).** Free; EU-resident by construction (data
  never leaves the cluster); strong German; deployable via the existing `agk-deployment-configs`
  ArgoCD pattern (same shape as the Langfuse rollout). Caveats: NER accuracy below managed
  services; the project's governance recently moved to a `data-privacy-stack` org — verify before
  standardizing.
- **Option B — Azure AI Language PII (container).** Managed accuracy, ~77 languages, data-residency
  via the disconnected container. Caveats: per-1k-record cost at chat volume (rate to confirm),
  German *conversational* PII is preview-only, higher call latency.
- **Option C — Hybrid.** Presidio as the orchestrator with Azure AI Language plugged in as a
  *remote recognizer* for hard entities. Keeps a single integration surface while buying managed
  accuracy where it matters. Choosing A does not foreclose this.
- **Option D — Commercial (Private AI / Skyflow).** Best-in-class language coverage and reversible
  tokenization out of the box, at licensing cost — the fallback if A/B accuracy fails the PoC.

**Decision criteria:** German + multilingual accuracy on *Knauf* sample data; EU residency; cost
model at real volume; operational burden; fit to the fork's tier ladder.

**The decision mechanism is a PoC spike** (ticketed in §9): stand up Presidio *and* the Azure
container, measure DE+EN precision/recall and latency against a labeled Knauf sample, and verify
Presidio's governance status. The spike's output *is* this decision.

---

## 7. Risks, compliance & open questions

### 7.1 Risk register

| Risk | Impact | Note |
|---|---|---|
| Azure OpenAI abuse-monitoring retention | Prompts (with PII) retained up to 30d unless opted out | **Verify first** — undercuts the §3 "least risky hop" claim if not opted out |
| Over-redaction (if masking is over-applied) | Product utility loss, user flight to shadow IT | The reason masking is opt-in, not default |
| Under-detection / false confidence | "We mask PII" claimed but NER misses entities | Set expectations; measure recall in the PoC |
| German NER accuracy | Weak masking on the primary language | Drives engine choice (§6) |
| Streaming output gap | Live responses can't be reliably masked | Scope limited to input-side/persistence |
| Meilisearch replica drift | Deleted content lingers in search | Delete hooks verified in code; staging check remains (Ph2) |
| Shared-link exposure | Public conversation content | Review default + TTL (Ph0/Ph2) |
| Memory profiling | Durable personal-fact store, no TTL | Pseudonymize + purge (Ph2/Ph3) |
| **Azure AI Search delete gap** *(confirmed live)* | Agent-file **and mis-routed chat-attachment** embeddings orphaned in the index after delete | Merge PR #115 (delete routing + `isAgentFile` upload fix) + a delete-verification recipe (Ph0) |
| **User-created MCP servers** *(new)* | Message-derived content sent to arbitrary third-party endpoints, unreviewed | Governance decision on `mcpServers` defaults (Ph0); catalogue + DPA process (§12) |
| **`open_url` as exfil channel** *(new)* | Prompt-injected URLs can smuggle context into query strings of attacker hosts | Guardrails exist; monitor provenance warnings (Ph1); allowlist if they recur |
| **Datadog browser logs** *(new)* | Forwarded `console.error` / uncaught-error payloads may carry PII (noise-filtered, not scrubbed) | Review forwarded content + scrub config (Ph1) |
| **Cost records as employee metering** *(new)* | Per-user usage data read as performance monitoring | Aggregate-only reporting (R9); works-council question (§7.2, §12) |
| **Fork/upstream drift** *(observed)* | Privacy seams silently diverge on merges (JS/TS redactor levels already did) | R11 checklist wired into the upstream-sync ritual (Ph1) |

### 7.2 Open questions by owner

- **DPO / Legal**
  - Retention periods per category (messages, memories, logs, violation records)?
  - Lawful basis for the memory feature's *profiling* of users — is a specific notice/consent
    needed beyond the EULA?
  - **Works council / Betriebsrat**: does anything here read as employee monitoring and require
    co-determination sign-off? *Recheck sharpened this:* the cost-visibility feature meters
    per-employee usage — even though it's user-scoped today, it is the closest thing the fork has
    to a monitoring surface and should be named explicitly in that conversation.
  - DSAR readiness (Art. 15 access / Art. 17 erasure) — today there is **no export endpoint**;
    deletion is code-verified as comprehensive (§1.3) but needs a staging-level erasure recipe.
- **Security**
  - Who can read production logs, and are those views redacted?
  - Retention/TTL for the general Redis violation log (ban entries already expire with
    `BAN_DURATION`)?
  - Shared-link policy — should `isPublic` default to false?
  - **MCP exposure** — should `mcpServers.create/share/public` stay `true` before a catalogue +
    per-server DPA review exists? (Recommended: no — see §3.3 row 16.)
  - **Datadog browser logs** — what exactly is forwarded, and does it need a scrubber?
- **Engineering / Platform**
  - What is `DEBUG_LOGGING` set to in production? (Config lives in the SAML-gated
    `ct-shared-deployment-configs` repo — **not verifiable from this repo**.)
  - Is the Azure OpenAI modified-abuse-monitoring opt-out in place?
  - ~~Is upstream's deletion-completeness fix (PR #10534) present on our v0.8.5 baseline?~~
    **Answered by the recheck: yes** — 23-store cascade verified at code level (§1.3); a staging
    erasure recipe remains (Ph2).
  - When does PR #115 (Azure-Search delete propagation) land, and what is the verification
    recipe for the index after deletes?
  - Is `AZURE_SEARCH_ENABLED` on in any deployed environment yet? (Determines the urgency of the
    two items above.)
  - Presidio governance transition; Azure AI Language exact pricing; LiteLLM streaming re-hydration
    status.

---

## 8. Implementation guidance & detailed roadmap *(expanded in v1.1)*

Principles carried over from v1: **Phases 0–2 remove the most risk for the least cost and are
engine-independent; the engine enters only at Phase 3; nothing, in any phase, masks the live
model call by default.** New in v1.1: per-item tables with owner, effort, dependencies and
acceptance; explicit decision gates; shipped-status tracking; a sequencing map; and the triggers
that legitimately reorder the plan. The v1 fork-tier labels (upstream-sync sensitivity) stay on
each phase heading.

Effort classes: **S** ≤ 2 days · **M** ≤ 1 sprint · **L** 1–2 sprints.
Owners: **Eng** (fork engineering) · **Plat** (platform / deployment repos) · **Sec** (security)
· **DPO** (data protection / legal) · **Prod** (product).

### Phase 0 — config quick wins & exposure decisions *(now → ~2 weeks · Tier 0 + one Tier-5 seam fix, 0.5)*

Goal: stop the cheapest leaks and make the two exposure defaults (MCP, shared links) deliberate
decisions instead of accidents. No engine, no schema changes.

| # | Item | Owner | Effort | Depends on | Status / acceptance |
|---|---|---|---|---|---|
| 0.1 | `DEBUG_LOGGING=false` in `.env.example` | Eng | S | — | ✅ **shipped** (commit `3abf925f2`, PR #114) |
| 0.2 | Set + verify prod `DEBUG_LOGGING=false` in `ct-shared-deployment-configs` | Plat | S | cross-repo access | ☐ verified off in prod; posture documented |
| 0.3 | **Land & verify PR #115** — Azure-Search delete propagation + `isAgentFile` upload routing | Eng | S | review | ☐ merged; staging recipe: upload agent file *and* chat attachment → delete → index returns nothing |
| 0.4 | **MCP exposure decision** — keep `mcpServers.create/share/public: true`? | Prod + Sec | S (decision) | — | ☐ decision recorded; recommended minimum: `public/share: false` until a catalogue exists (R10) |
| 0.5 | OpenID info-level PII fix (`openidStrategy.js:699` logs email/name) | Eng | S | — | ☐ no email/name at info; login traceable by opaque id; upstream PR considered |
| 0.6 | Shared-link audit + `isPublic` default decision | Eng + Sec | S | — | ☐ existing links reviewed; default decision recorded |
| 0.7 | Logging-posture one-pager (what is logged where, at which level, who reads it) | Eng | S | 0.1–0.2 | ☐ doc merged next to this one |

**Definition of done:** no message content reaches prod logs by configuration; agent-file deletes
propagate to every vector store; MCP and shared-link exposure are recorded decisions.

### Phase 1 — log & telemetry hygiene *(~1 sprint; can overlap Phase 0 · Tier-5 seam work, upstream candidates)*

Goal: make logs and client telemetry structurally unable to carry raw identifiers, and make that
property survive future merges.

| # | Item | Owner | Effort | Depends on | Acceptance |
|---|---|---|---|---|---|
| 1.1 | **Unify the redactor** — dedupe `api/config/parsers.js` / `packages/data-schemas/src/config/parsers.ts` and fix the already-observed divergence (JS: error+warn, TS: error-only) | Eng | M | — | one implementation; tests pin the levels |
| 1.2 | **PII patterns at all levels** — email / IP / phone / IBAN / national-ID regexes applied at every level incl. `debugTraverse` | Eng | M | 1.1 | seeded-fixture test: no raw email/IP/phone in any log file; upstream-contribution candidate |
| 1.3 | IP handling — redact/pseudonymize IP in `banViolation.js` info log and review `logHeaders.js` | Eng | S | 1.2 | ban events log a truncated/hashed IP |
| 1.4 | **Datadog browser-logs review** — inspect what the client forwards; add scrubbers or disable log forwarding | Eng + Sec | S | — | forwarded-content review recorded; scrub config applied |
| 1.5 | `open_url` provenance monitoring — surface the existing warnings (dashboard/alert) | Plat | S | — | warnings visible; alert on recurrence |
| 1.6 | **R11 PII-regression checklist** added to the upstream-sync ritual (`knauf/docs/contributing/upstream-sync.md`) and to the fork's PR template for new features | Eng | S | — | checklist merged; §12.1 is its content |
| 1.7 | Confirm prod log rotation (14d) + who has log access | Plat + Sec | S | — | documented in the 0.7 one-pager |

**Definition of done:** a grep across a week of production logs finds zero raw emails, IPs, or
message content; every subsequent upstream merge runs the checklist.

### Phase 2 — retention & minimization *(1–2 sprints of eng work; DPO decisions start during Ph0/1 · Tier 0/4c/5 mix)*

Goal: every stored category has an enforced retention period and a verified erasure path. The
DPO retention matrix (2.1) is the long pole — start it immediately, it gates the rest.

| # | Item | Owner | Effort | Depends on | Acceptance |
|---|---|---|---|---|---|
| 2.1 | **DPO retention matrix** — periods for messages, memories, shared links, violation log, cost records | DPO | S (decision) | — | periods recorded per category |
| 2.2 | **Conversation/message TTL sweep** — k8s CronJob (file-roadmap T3 direction); cascades to Meilisearch + pgvector + Azure Search + Blob; respects KK20-204 dedup ref-counts | Eng + Plat | L | 2.1; KK20-203/204 (✅ shipped) | sweep deletes all copies; dry-run mode; deletion metrics emitted |
| 2.3 | Memory TTL / staleness purge + user-facing transparency (view & clear) | Eng | M | 2.1 | purge live; memories visible/clearable by the user |
| 2.4 | Shared-link expiry | Eng | M | 0.6 decision | expired links 404; TTL configurable |
| 2.5 | General violation-log TTL (ban entries already expire via `BAN_DURATION`) | Eng | S | — | violation namespace bounded |
| 2.6 | Cost-record retention aligned with conversation TTL | Eng | S | 2.1 | `transactions` rows age out with their conversation |
| 2.7 | **Staging erasure recipe** — account delete + convo delete → verify Mongo, Meilisearch, pgvector, Azure AI Search, Blob are all clean | Eng + Sec | M | 0.3 | recipe documented and run green; becomes the DSAR erasure evidence |
| 2.8 | Meilisearch field-minimization assessment using the (verified) `meiliIndex` flags | Eng | S | — | decision recorded: which fields stay indexed |

**Definition of done:** nothing personal persists without a defined period; the erasure recipe
passes end-to-end including both vector stores.

### Phase 3 — engine PoC + persistence-chokepoint masking *(PoC ~2 weeks; then 1–2 sprints; independent of Ph1/2 · Tier 3)*

**Gate G3:** the §6 PoC — Presidio vs Azure AI Language container, DE+EN precision/recall and
latency on a labeled Knauf sample — produces a recorded engine decision. No masking code is
written before G3 passes.

| # | Item | Owner | Effort | Depends on | Acceptance |
|---|---|---|---|---|---|
| 3.1 | PoC spike (both engines via `agk-deployment-configs`, same pattern as the Langfuse rollout) | Eng + Plat | M | — | metrics on Knauf data; recommendation recorded; Presidio governance verified |
| 3.2 | **RAG-ingest scan/flag/mask for shared-agent knowledge files** — one chokepoint now covers *both* vector sinks (pgvector and Azure AI Search) | Eng | L | G3 | shared-agent ingest scanned; policy (flag vs mask) applied; file owner sees flags |
| 3.3 | **Memory-write pseudonymization** (non-streamed backend chokepoint) | Eng | M | G3 | memory values pseudonymized at write; round-trip preserved for the user |
| 3.4 | *(stretch)* Title-generation masking assessment (non-streamed, low priority) | Eng | S | G3 | do/don't decision recorded |

**Definition of done:** the engine decision is evidence-based; the two highest-ROI persistence
flows are protected; no user-visible utility loss in normal chat.

### Phase 4 — opt-in inline input masking *(decision-gated; unscheduled)*

**Gate G4:** a *named* high-risk flow exists (e.g. an HR or legal agent) **and** product signs
off that its utility loss is acceptable. Without G4, this phase intentionally never starts.

| # | Item | Owner | Effort | Depends on | Acceptance |
|---|---|---|---|---|---|
| 4.1 | Design: opt-in, per-model-spec/agent, input-side masking with re-hydration (PII-Shield session pattern) | Eng + Prod | M | G3 engine | design doc reviewed by Sec + DPO |
| 4.2 | Implementation for the designated flow(s) | Eng | L | G4, 4.1 | masking measurably applied; opt-in surface documented; streamed *output* remains untouched (§5.2) |

### Sequencing & triggers

```
Ph0 (quick wins + decisions) ──▶ Ph1 (log hygiene) ──▶ Ph2 (retention) ──▶ steady state
      │ 0.3 #115                       │ 1.6 checklist          ▲
      │ 0.4 MCP decision               │                        │ 2.1 DPO matrix
      └────────────────────────────────┴── (2.1 starts during Ph0/1) ──┘

Ph3: PoC ──▶ G3 engine decision ──▶ 3.2 RAG-ingest + 3.3 memory-write
     (independent of Ph1/2; needs only agk-deployment-configs)          ──▶ G4? ──▶ Ph4
```

Events that legitimately reorder the plan:

- **`AZURE_SEARCH_ENABLED` turned on in prod** → 0.3 and 2.7 become immediate blockers.
- **Langfuse activation requested** → its PII gate (§9 P3 ticket) jumps to the front; nothing
  ships to Langfuse before masking/sampling config is reviewed.
- **An MCP catalogue ships** → R10 per-server DPA review process must exist first (§12.2).
- **A works-council inquiry arrives** → the cost-visibility and memory briefings (§12.4) happen
  on their timeline, not ours.

### Suggested calendar (assuming Phase 0 starts July 2026)

| Window | Focus |
|---|---|
| **Q3 2026** | Phase 0 complete; Phase 1 complete; DPO retention matrix (2.1) agreed |
| **Q4 2026** | Phase 2 lands (TTL sweep, purges, erasure recipe); Ph3 PoC scheduled |
| **Q1 2027** | Phase 3: PoC → G3 decision → RAG-ingest + memory-write chokepoints |
| **Q2 2027+** | Phase 4 only if G4 is ever met; otherwise steady-state (checklist + annual re-audit, §12.5) |

---

## 9. Follow-up implementation tickets

Paste-ready drafts, in priority order. File these in the KK20 project; they are the concrete
output this discovery exists to produce.

### P0 — quick wins

**Title:** Land & verify Azure AI Search delete propagation (PR #115)
**Type:** Bug
**Summary:** On `main`, cascade deletion of agent knowledge files cleans Mongo + blob + pgvector
but never notifies Azure AI Search — the embedding stays indexed. Upload routing is also
over-broad (keyed on `entity_id`, so first-upload chat attachments embed into the index with no
delete leg at all). PR #115 (`fix/azure-search-delete-cleanup`) routes agent-context deletes to
`/agent/documents/{file_id}` and narrows uploads via `isAgentFile`.
**AC:** [ ] PR #115 merged · [ ] staging recipe: upload agent file *and* chat attachment → delete
→ index query returns nothing · [ ] recipe folded into the Ph2 erasure recipe.

**Title:** Decide MCP-server exposure defaults
**Type:** Decision / Task
**Summary:** `librechat.yaml` currently sets `mcpServers.use/create/share/public: true` — any
user can wire a third-party endpoint that receives tool arguments (which can carry message
content), with no catalogue or DPA review. Decide the default posture (recommended minimum:
`public/share: false`) and the criteria for a future curated catalogue (R10).
**AC:** [ ] decision recorded · [ ] `librechat.yaml` updated if restricted · [ ] catalogue/DPA
process sketched for §12.2.

**Title:** Default `DEBUG_LOGGING` off in production
**Type:** Task
**Summary:** Debug logging writes prompt/response content to logs. `.env.example` is defaulted off
since PR #114 (commit `3abf925f2`); production is configured in `ct-shared-deployment-configs` and
must be set explicitly.
**AC:** [ ] prod `DEBUG_LOGGING=false` · [ ] logging posture documented · [ ] verified no content
in prod debug logs.

**Title:** OpenID login logs email/name at info level — demote & redact
**Type:** Bug
**Summary:** `api/strategies/openidStrategy.js` logs `email | username | name` at info on every
login (unredacted). Demote to debug and/or redact. Upstream-contribution candidate.
**AC:** [ ] no email/name at info level · [ ] login still traceable by opaque id · [ ] considered
for upstream PR.

**Title:** Audit shared links and decide `isPublic` default
**Type:** Task
**Summary:** `sharedLink.isPublic` defaults true with no expiry. Audit existing links; decide
whether the default should be false.
**AC:** [ ] existing links reviewed · [ ] default decision recorded · [ ] follow-up cut if change
needed.

### P1 — logs & retention

**Title:** Extend log redaction with PII patterns at all levels
**Type:** Task
**Summary:** Add email/IP/phone/IBAN/ID patterns to `redactMessage` at all log levels incl.
`debugTraverse`; dedupe the JS/TS parser copies — **which have already diverged** (JS redacts
error+warn, TS error-only), proving the duplication is actively dangerous. Upstream-contribution
candidate.
**AC:** [ ] patterns redacted at every level · [ ] single redactor implementation, levels pinned
by tests · [ ] seeded-fixture test proves no raw email/IP in any log file.

**Title:** Datadog browser-logs PII review
**Type:** Task
**Summary:** `datadogConfig.js` provisions client-side Datadog RUM **and browser-log
forwarding**. Session replay is off, input is masked, and forwarding is limited to
`console.error` + uncaught errors behind a `logsBeforeSend` noise filter — but those error
payloads are not PII-scrubbed before reaching a third-party cloud. Review what is forwarded;
add scrubbers or disable log forwarding.
**AC:** [ ] forwarded content reviewed · [ ] scrub/disable decision applied · [ ] posture added
to the logging one-pager.

**Title:** Add PII-regression checklist to the upstream-sync ritual
**Type:** Task
**Summary:** Fork/upstream drift has already produced two silent privacy regressions (JS/TS
redactor divergence; Azure-Search delete gap). Add the §12.1 checklist to
`knauf/docs/contributing/upstream-sync.md` and the feature-PR template.
**AC:** [ ] checklist merged into the ritual · [ ] referenced from the PR template · [ ] first
post-merge run recorded.

**Title:** Conversation & message retention policy + TTL sweep
**Type:** Story
**Summary:** Define retention periods (DPO) and implement a TTL sweep (align with the roadmap's T3
CronJob), cascading to Meilisearch, pgvector, Azure AI Search, and Blob, and respecting the
KK20-204 dedup ref-counts (§8 item 2.2).
**AC:** [ ] periods agreed · [ ] sweep deletes all copies incl. Azure AI Search · [ ] dedup
ref-counts respected · [ ] verification recipe.

**Title:** Memory entries — add TTL / staleness purge
**Type:** Task
**Summary:** `memory.value` has no TTL. Add staleness/TTL purge and a user-transparency review.
**AC:** [ ] TTL/purge implemented · [ ] user can see/clear memories.

**Title:** Staging erasure-verification recipe (account + conversation delete)
**Type:** Task
**Summary:** Code-level verification is done (v1.1 recheck: 23-store cascade in
`UserController.js:325-379`; Meilisearch delete hooks present). What remains is behavioral proof:
a staging recipe that deletes an account and a conversation, then verifies Mongo, Meilisearch,
pgvector, **Azure AI Search**, and Blob are clean. Becomes the standing DSAR erasure evidence.
**AC:** [ ] recipe documented · [ ] run green in staging incl. both vector stores · [ ] rerun
scheduled after PR #115 and after the Ph2 TTL sweep land.

**Title:** Works-council briefing — cost visibility & memories
**Type:** Task (process, DPO-led)
**Summary:** Two features plausibly read as employee monitoring/profiling: per-user cost/usage
records (Mongo `transactions`, EUR-priced per message) and LLM-written memories. Prepare the
co-determination briefing before either grows a reporting or admin surface.
**AC:** [ ] briefing prepared · [ ] works-council position recorded · [ ] any constraints fed
back into §3.3 rows 5/15.

**Title:** Shared-link expiry (TTL)
**Type:** Task
**Summary:** Add optional/enforced expiry to shared links.
**AC:** [ ] links can expire · [ ] expired links 404.

### P2 — engine & deeper minimization

**Title:** PII engine PoC spike (Presidio vs Azure AI Language)
**Type:** Spike
**Summary:** Deploy Presidio and the Azure AI Language container via `agk-deployment-configs`;
measure DE/EN precision/recall + latency on a labeled Knauf sample; verify Presidio governance.
Output = the §6 engine decision.
**AC:** [ ] both stood up · [ ] metrics on Knauf data · [ ] recommendation recorded.

**Title:** RAG-ingest PII scan/flag for shared-agent knowledge files
**Type:** Task (gated on PoC)
**Summary:** Scan/flag/mask PII in files ingested into shared-agent knowledge bases before embed.
**AC:** [ ] shared-agent ingest scanned · [ ] policy applied.

**Title:** Memory-write pseudonymization
**Type:** Task (gated on PoC)
**Summary:** Pseudonymize PII in memory values at write time (non-streamed chokepoint).
**AC:** [ ] memory writes pseudonymized · [ ] round-trip preserved for the user.

**Title:** Meilisearch field minimization (per-field `meiliIndex` flags)
**Type:** Task
**Summary:** v1.1 recheck verified the delete hooks in code (`postRemove` + `pre('deleteMany')`)
and corrected v1: per-field control **exists** via `meiliIndex: true` schema flags (Tier-5 edit,
upstream-sync-sensitive). The staging delete-propagation check is owned by the P1 erasure-recipe
ticket (§8 item 2.7) and is not duplicated here — this ticket is the field-minimization decision
only (§8 item 2.8).
**AC:** [ ] field-minimization decision recorded (which fields stay indexed).

**Title:** Redis violation/ban TTL + IP-logging review
**Type:** Task
**Summary:** Bound retention of the general violation log (§8 item 2.5; ban entries already expire
via `BAN_DURATION`). Note: the ban-event info-log IP redaction itself is Phase 1 work (§8 item
1.3, alongside the redactor tickets); this ticket covers the TTL half plus the
`logHeaders.js`/`banViolation.js` review.
**AC:** [ ] TTL set · [ ] IP logging minimized (1.3 acceptance: truncated/hashed IP).

**Title:** Secrets-at-rest review (`action.metadata`, `pluginAuth.value`, `key.value`)
**Type:** Task
**Summary:** Adjacent (non-PII) hardening — review encryption/handling of stored third-party
secrets.
**AC:** [ ] handling reviewed · [ ] hardening cut if needed.

### P3 — optional / gated

**Title:** Decision + design: opt-in inline input-masking for high-risk flows
**Type:** Story (decision-gated)
**Summary:** Design opt-in, input-side masking per model-spec/agent for designated flows, with
re-hydration.
**AC:** [ ] product decision recorded · [ ] design documented.

**Title:** Langfuse activation PII gate
**Type:** Task
**Summary:** Before wiring the existing Langfuse env URL, require a PII review + masking config
(it would capture prompts/completions).
**AC:** [ ] PII gate defined before activation.

---

## 10. Acceptance-criteria mapping

| KK20-207 acceptance criterion | Where addressed |
|---|---|
| A written PII masking & anonymization assessment exists | This document |
| Relevant data categories & system touchpoints identified | §1 — extended to 16 categories in v1.1 (the demo's data-flow map still shows the v1 scope; see the header note) |
| Defines what to mask / anonymize / pseudonymize / exclude | §3 matrix + §4 rules (R1–R11) |
| Highlights risks, open questions, stakeholder dependencies | §7 + §12 |
| Provides a clear basis for engineering implementation tickets | §8 (detailed roadmap) + §9 |
| *(v1.1)* Claims re-verified against the current codebase | §11 verification log |

---

## 11. Verification log — 2026-07-06 recheck

Every code-level claim in v1 was re-verified against `main` @ v0.95.0 (commit `e5351cfc4` era,
post KK20-203/204/188/199, Azure-Search routing, `open_url`, cost visibility). Legend:
✅ confirmed as written · 🟡 true but needed sharpening · ❌ corrected in place · ➕ new fact v1
did not know.

| # | v1 claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `DEBUG_LOGGING` defaults on in code | ✅ (code default `true`, `winston.js:41`) — `.env.example` now ships `false`; prod value still unverified | `api/config/winston.js:41`, `.env.example:71` |
| 2 | Log redaction is secrets-only at error/warn | 🟡 secrets-only ✅; **but the duplicate copies diverged**: JS redacts error+warn, TS error-only; debug never redacted | `api/config/parsers.js:56-66`, `packages/data-schemas/src/config/parsers.ts:62-76` |
| 3 | OpenID login logs email/name at info | ✅ | `api/strategies/openidStrategy.js:699-709` |
| 4 | Violation/ban records have no TTL | 🟡 ban entries expire with `BAN_DURATION`; the general violation log is unbounded; ban events log raw IP at info | `api/cache/getLogStores.js:28-32`, `banViolation.js:67-78`, `logViolation.js:22-26` |
| 5 | 14-day log rotation | ✅ | `api/config/winston.js:88-110` (`maxFiles: '14d'`) |
| 6 | Shared links: `isPublic` default true, no expiry | ✅ | `packages/data-schemas/src/schema/share.ts:40-42` |
| 7 | Memories have no TTL | ✅ (deleted only with the account) | `packages/data-schemas/src/schema/memory.ts` |
| 8 | Convos/messages indefinite; temp chats TTL via `expiredAt` | ✅ (TTL indexes on convos *and* messages; 30d default) | `convo.ts:36-47`, `message.ts:147-162` |
| 9 | Temp chats excluded from Meilisearch | ✅ (only `expiredAt: null` indexed) | `mongoMeili.ts:155-200` |
| 10 | Meilisearch: full-text replica, **no field-exclusion knob** | ❌ **knob exists** — only `meiliIndex: true` fields replicate (Tier-5 edit); `user` is the only filterable; delete hooks (single + `deleteMany`) present | `mongoMeili.ts:254-256, 526-535, 623-625, 663-715` |
| 11 | File text lives in Mongo `files.text` + pgvector | ❌ extraction happens inside the (now-external) `rag_api`; chunks+vectors live in pgvector **or Azure AI Search** when enabled (agent files by intent — on `main` the `entity_id`-keyed routing also embeds first-upload chat attachments; PR #115 narrows it via `isAgentFile`); `files.text` mostly unpopulated on these paths | `VectorDB/crud.js:113-150`, `process.js:705`, `file.ts:54-56`, `rag.yml` |
| 12 | "No non-Azure content flows are active" | ❌ **stale** — `open_url` fetches arbitrary pages (SSRF-checked, provenance-logged, browse-gated); MCP servers are user-creatable/shareable; SERPER/Tavily/Firecrawl remain dormant ✅ | `OpenUrl.js`, `ToolService.js:516-530`, `librechat.yaml:383-387`, `.env.example:362,888,891` |
| 13 | Langfuse present but inactive | ✅ (all keys commented) | `.env.example:111-113` |
| 14 | Account-deletion completeness "unverified" | ➕ **now verified**: 23-store cascade incl. files+vectors, memories, shared links, tokens, ACL | `api/server/controllers/UserController.js:325-379` |
| 15 | Tenant isolation plugin scopes by `tenantId` | ✅ (queries, updates, saves, aggregates) | `tenantIsolation.ts:93-189` |
| 16 | Analytics posture (masked paths, consent-gated, replay off) | ✅ | `datadog/config.ts:26-31`, `consent.ts:45-46`, `analyticsDiagnostics.js:7-14` |
| 17 | Temp chat available to enable; EULA cites GDPR | ✅ (not enabled today — no `temporaryChat` key; EULA cites Art. 13, 15–18, 20, 7(3)) | `librechat.yaml:88-128` |
| 18 | Short-TTL SAS blob URLs | ✅ + hardened since (clock-skew backdating, JIT re-sign) | `Azure/crud.js:68-91, 532-542` |
| 19 | *(new)* Azure-Search delete gap | ➕ cascade delete targets pgvector only on `main` (Azure deletes fire only for `context === 'agents'`, so mis-routed chat-attachment embeddings are orphaned); PR #115 adds `deleteVectorsForFiles` routing to `/agent/documents/{file_id}` and `isAgentFile` upload routing | `cascadeDeleteConvoFiles.js`, `VectorDB/crud.js:82,135`, branch `fix/azure-search-delete-cleanup` (`850aa4d37`) |
| 20 | *(new)* Content-hash dedup is strictly per-user | ➕ lookup key is `(user, knauf_content_hash)`; no cross-user blob/vector sharing | `contentDedup.js:45-62`, `file.ts:85-108`, `process.js:653-773` |

---

## 12. Future-problem register *(new in v1.1)*

Forward-looking risks, grouped by what triggers them. Each row: the trigger that makes it real,
the problem, and the pre-emptive move — most of which are cheap *if done before the trigger*.

### 12.1 Change-driven: the fork will drift

The recheck found two silent privacy regressions introduced by normal development (JS/TS
redactor divergence; Azure-Search delete gap). This is structural: the fork merges upstream
regularly and ships features weekly, and each change can add a log line, a store, or an egress
path. The mitigation is the **R11 checklist**, run on every upstream merge and feature PR:

1. New log statements — do any write identifiers or content? At which level?
2. New env-gated integrations — what leaves the tenancy when the flag flips?
3. New collections/indexes/caches — added to the §1 data map with a retention answer?
4. Redaction seams intact — do the parser tests still pin levels and patterns?
5. Delete cascades — does every new store have a delete leg (the PR #115 lesson)?
6. New third-party endpoints — R10 catalogue/DPA review done?

### 12.2 Activation-gated: dormant today, one flag away

| Trigger | Problem | Pre-emptive move |
|---|---|---|
| Langfuse keys set | Prompts/completions captured verbatim in an observability store | PII gate ticket (§9 P3) is a hard precondition; masking/sampling config reviewed before first trace |
| `AZURE_SEARCH_ENABLED=true` in prod | Second vector store becomes live PII; delete gap becomes a live erasure violation | PR #115 merged + 2.7 erasure recipe green **before** enablement |
| MCP catalogue / `actions.allowedDomains` shipped | Content flows to third parties as a product feature | R10 process (per-server DPA/ToS review) exists first; defaults stay restrictive |
| Web-search providers (SERPER/Tavily/Firecrawl) keyed | Query text (user-derived) to non-Azure SaaS | Same R10 review; prefer the in-tenancy Azure native search that is already active |
| Okta group sync (KK20-198, in-flight branch) | Group/role claims persisted onto user records | Include in the §1 map + deletion cascade when it merges (R11 item 3) |
| Non-Azure model providers added | The §3.1 "least risky hop" argument is tenancy-based and **does not transfer** | Any new provider gets its own DPA + residency review; §3.1 explicitly re-argued per provider |
| Temporary chat enabled | None — this is a *mitigation* | Enable deliberately as part of Ph2 comms ("private mode") |

### 12.3 Scale- and time-driven: fine now, a problem later

| Trigger | Problem | Pre-emptive move |
|---|---|---|
| Memory store grows for years | Profiling-grade dossiers; DSAR answers get long; lawful-basis question sharpens | 2.3 TTL/staleness purge; user-visible memory management; DPO notice review |
| DSAR volume rises | No export endpoint → manual, error-prone fulfilment | Scope an export endpoint after Ph2 (the erasure recipe is the deletion half; export is the access half) |
| TTL sweep at scale | Partial failures / double-runs orphan copies across 5 stores; dedup ref-counts complicate deletes | 2.2 dry-run mode + deletion metrics + idempotency; sweep respects `knauf_asset_id` ref-counts |
| Meilisearch index growth | A widening full-text replica of everything ever said | 2.8 field minimization + TTL sync keeps the replica no broader than Mongo |
| Shared-link sprawl | Old public snapshots outlive their context | 2.4 expiry + periodic audit (0.6) |
| Violation log growth | Unbounded userId+IP history | 2.5 TTL |

### 12.4 Organizational & regulatory horizon

| Trigger | Problem | Pre-emptive move |
|---|---|---|
| Works-council review | Cost metering (row 15) and memories (row 5) read as monitoring/profiling | Proactive briefing (§9 ticket) before any admin/reporting surface exists; R9 aggregate-only rule |
| EU AI Act obligations phase in (GPAI already; high-risk tranches through 2026–27) | Workplace-AI transparency expectations rise; documentation asks arrive | This doc + the §11 log *are* the documentation seed; revisit at each phase boundary |
| Knauf data-classification mapping (open §7 item) | P0/P1/P2 triage here may not match the official scheme | DPO maps §1 categories to the official classes during 2.1 |
| Azure OpenAI abuse-monitoring opt-out still unverified | The §3.1 cornerstone stays an assumption | Close the §7.2 Engineering/Platform abuse-monitoring question (also §7.1's first risk row) — it remains the single highest-leverage verification |

### 12.5 Steady state

Once Ph0–Ph2 land, the standing rhythm is: R11 checklist on every merge; the erasure recipe
re-run after any storage-topology change; and an **annual re-audit of this document** (§11 shows
the half-life of its claims is months, not years — v1 needed corrections after three days).

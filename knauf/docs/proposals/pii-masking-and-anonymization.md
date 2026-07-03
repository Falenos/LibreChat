# PII masking & data anonymization for Agentic Karl (KK20-207)

> **Status:** proposal / discovery output. This is the deliverable of **KK20-207**
> ("PII masking and data anonymization", related epic **KK20-80**). It classifies the personal
> data Agentic Karl handles, maps where it lives, proposes a per-category protection strategy
> (mask / pseudonymize / anonymize / exclude / retain-then-delete, differentiated by use case),
> surveys the solution landscape, and lists the risks, stakeholder questions, and follow-up
> implementation tickets. **No masking is implemented by this doc** — it exists so an agreed
> strategy can be turned into scoped tickets. Implementing masking, final legal sign-off, and
> vendor selection are explicitly out of scope (they are the follow-ups in §9).
>
> **Interactive companion:** a self-contained demo — data-flow map, the handling matrix, the
> options comparison, and a masking playground — lives at
> [assets/pii-masking-demo.html](assets/pii-masking-demo.html) and is published as an Artifact:
> **<https://claude.ai/code/artifact/c48a5593-409e-413f-9fdd-4d3317d775a6>**.
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

A five-phase roadmap follows the risk, not the hype:

- **Phase 0 — config quick wins (this PR + one cross-repo ticket).** Default `DEBUG_LOGGING` off,
  document the logging posture, review shared-link defaults, fix the OpenID login that logs
  email/name at info level.
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
| 3 | Search index | Meilisearch (`packages/data-schemas/src/models/plugins/mongoMeili.ts`) | Full-text **replica** of message text + titles | P0 | Temp chats excluded; no field-exclusion knob |
| 4 | File text & embeddings | Mongo `files.text`; pgvector via `rag_api` | Extracted/OCR'd document body + vector chunks | P0 | None (ingested verbatim) |
| 5 | Memories | Mongo `memory.value` (`packages/data-schemas/src/schema/memory.ts`) | LLM-written personal facts about the user (profiling-grade) | P0 | Per-user on/off toggle; **no TTL** |
| 6 | User identity | Mongo `users` | Email, name, username, OAuth subject IDs (incl. Entra `idOnTheSource`), avatar, 2FA secrets, refresh tokens | P0 | Auth-scoped; tenant isolation |
| 7 | Logs | winston → `api/logs/*.log` (`api/config/winston.js`, `parsers.js`) | Message content when `DEBUG_LOGGING=true`; email/name at login; client IP | P1 | Secrets-only redaction, **error/warn levels only** |
| 8 | Analytics | `client/src/knauf/analytics/` (Adobe + OneTrust + Datadog) | Page views, interactions | P2 | **Already PII-minimized by design** (see §1.2) |
| 9 | Shared links | Mongo `sharedLink` (`share.ts`) | Public snapshot of a conversation's title + messages | P1 | `isPublic` default **true**, no TTL |
| 10 | Exports | Client-side (`useExportConversation.ts`) | Full conversation to user's disk | P1 | User-initiated |
| 11 | Feedback | Mongo `message.feedback.text` | Free-text thumbs-up/down comments | P1 | None |
| 12 | Violation / ban records | Redis (`api/cache/logViolation.js`, `banViolation.js`) | `userId` + IP address | P1 | Security-scoped; no defined TTL |
| 13 | Outbound model calls | Azure OpenAI, Azure Document Intelligence, MS Graph | Prompts, memory, titles, file bytes, avatar/group lookups | P0 | In-tenancy; EU Data Boundary; DPA |
| 14 | Secrets at rest *(adjacent, not PII)* | `action.metadata`, `pluginAuth.value`, `key.value` | Third-party OAuth secrets / API keys | P1 | None — flagged for a security ticket |

### 1.2 Data-flow narrative

A user's message enters through the KARL API (`api/server`). From there it fans out to:
**Azure OpenAI** (the completion, plus title generation, the memory agent, and native web
search); **Azure Document Intelligence** for uploaded-file OCR; and **Microsoft Graph** for
avatar and group resolution at login. It is persisted to **MongoDB** (messages, conversations,
memories, files, users), **replicated to Meilisearch** for search, **embedded into pgvector**
(via `rag_api`) for file search, and — for uploaded bytes — stored in **Azure Blob** behind
short-TTL SAS URLs. Cross-cutting: **winston logs** to disk, **Redis** holds violation/ban
records and caches, and the **client analytics** stack emits consent-gated events. No non-Azure
content flows are active today (the SERPER / Tavily / Firecrawl web-search pipeline is dormant).

### 1.3 What already exists in this fork

The fork is not starting from zero. These controls are in place and inform the strategy:

- **Log secret-redaction** — winston's `redactMessage` (`api/config/parsers.js` and its duplicate
  `packages/data-schemas/src/config/parsers.ts`) scrubs `sk-…`, `Bearer …`, `api-key`, and
  `key=` tokens. **Secrets only, and only at error/warn levels.**
- **PII-minimized analytics** — the Adobe Analytics + OneTrust + Datadog RUM stack
  (`client/src/knauf/analytics/`) is already designed for minimization: masked page paths
  (`/c/:conversationId`), query-string *keys only*, a random per-session id, Datadog
  `defaultPrivacyLevel: 'mask-user-input'` with session replay off, all consent-gated, no user
  identity attached. **This is the model pattern for every future data-emitting feature.**
- **Sanitized diagnostics endpoint** — `api/server/routes/knauf/analyticsDiagnostics.js`
  allow-lists event names and caps strings at 160 chars.
- **Short-TTL SAS blob URLs** (KK20-167 / KK20-199) — private-by-default containers, signed URLs
  expiring in 300 s.
- **Tenant isolation** — `packages/data-schemas/src/models/plugins/tenantIsolation.ts` scopes
  every document by `tenantId`.
- **GDPR-aware EULA** — the `interface.modalContent` in `librechat.yaml` already cites GDPR
  Art. 15.
- **Retention primitives** — temporary chats (`interface.temporaryChat`, TTL via `expiredAt`,
  excluded from search) exist upstream and are available to turn on.
- **Not yet wired: Langfuse** — an env URL is present but the integration is not active. If
  switched on it would capture prompts and completions verbatim → a future PII gate (§7).

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
  (`api/config/winston.js`).
- **Moderation ≠ PII.** `OPENAI_MODERATION` and the `BAN_VIOLATIONS` scoring system
  ([mod docs](https://www.librechat.ai/docs/configuration/mod_system)) handle content policy and
  abuse — no PII capability. (`OPENAI_MODERATION` is `false` in this fork anyway.)
- **Retention is partial.** Temporary chats auto-delete and are search-excluded
  ([temp-chat docs](https://www.librechat.ai/docs/features/temporary_chat)); **normal
  conversations are stored indefinitely** with no built-in TTL and there is **no data-export /
  portability endpoint**. Account deletion historically left orphaned metadata
  ([Issue #10540](https://github.com/danny-avila/LibreChat/issues/10540), fixed by PR #10534) —
  we should verify the fix is present on our v0.8.5 baseline.
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
| 12 | Violation/ban (IP) | — | AS (security) | X | M (Ph1) | restricted | AN | **TTL** (Ph2) |
| 13 | Outbound Azure/Graph | AS* | — | — | X (never log payloads) | — | — | MS terms |
| 14 | Secrets at rest | — | security ticket | — | X | — | — | — |

Row-by-row rationale:

1. **Prompts/responses** — the utility argument (§3.1). Risk is concentrated at rest and in logs,
   not in the in-tenancy call, so the levers are log-exclusion and a retention TTL (period set by
   the DPO), not pre-model masking.
2. **Titles** — derived from content, so same class as #1. Title generation is non-streamed, so
   it's a *candidate* for optional masking later, not a priority.
3. **Meilisearch** — a second full-text copy of all conversation content. `mongoMeili` has no
   per-field exclusion knob (only `user` is filterable), so field minimization would be an
   upstream / Tier-5 change; the near-term control is TTL synced with Mongo plus verifying delete
   propagation.
4. **File text + pgvector** — private chat files stay as-is; the ROI case is **shared-agent
   knowledge files**, whose embeddings are exposed to *other* users — the one persistence flow
   where scanning/flagging/masking before embed clearly pays off (Ph3).
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
12. **Violation/ban** — security is a legitimate-interest purpose, but `userId`+IP needs a bounded
    Redis TTL and IP should be redacted from logs (Ph1).
13. **Outbound** — as-is into the in-tenancy services (*verify abuse-monitoring opt-out); never
    log the payloads; optional opt-in masking for designated flows in Ph4.
14. **Secrets at rest** — adjacent, non-PII; folded into a security-hardening ticket.

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
    to *every* copy (Mongo + Meilisearch + pgvector + Blob).
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
  - **R9** — Reporting is aggregate-only; no row-level PII leaves for BI/reporting.

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
| Meilisearch replica drift | Deleted content lingers in search | Verify delete propagation (Ph2) |
| Shared-link exposure | Public conversation content | Review default + TTL (Ph0/Ph2) |
| Memory profiling | Durable personal-fact store, no TTL | Pseudonymize + purge (Ph2/Ph3) |

### 7.2 Open questions by owner

- **DPO / Legal**
  - Retention periods per category (messages, memories, logs, violation records)?
  - Lawful basis for the memory feature's *profiling* of users — is a specific notice/consent
    needed beyond the EULA?
  - **Works council / Betriebsrat**: does anything here read as employee monitoring and require
    co-determination sign-off?
  - DSAR readiness (Art. 15 access / Art. 17 erasure) — today there is **no export endpoint** and
    deletion completeness is unverified.
- **Security**
  - Who can read production logs, and are those views redacted?
  - Retention/TTL for Redis violation & ban records (currently unbounded)?
  - Shared-link policy — should `isPublic` default to false?
- **Engineering / Platform**
  - What is `DEBUG_LOGGING` set to in production? (Config lives in the SAML-gated
    `ct-shared-deployment-configs` repo — **not verifiable from this repo**.)
  - Is the Azure OpenAI modified-abuse-monitoring opt-out in place?
  - Is upstream's deletion-completeness fix (PR #10534) present on our v0.8.5 baseline?
  - Presidio governance transition; Azure AI Language exact pricing; LiteLLM streaming re-hydration
    status.

---

## 8. Implementation guidance & phased roadmap

Each phase is labeled with its fork tier and effort class. Phases 0–2 remove the most risk for
the least cost and are engine-independent; the engine only enters at Phase 3.

- **Phase 0 — config quick wins (Tier 0 + one trivial fix; days).** *Partly shipped in this PR:*
  default `DEBUG_LOGGING=false` in `.env.example` (safe-by-default template). *Follow-ups:* set the
  prod flag off in `ct-shared-deployment-configs` (cross-repo); document the logging posture;
  audit shared links + decide the `isPublic` default; fix `openidStrategy.js` logging email/name
  at info level (one-line Tier-5 seam, **upstream-contribution candidate**).
- **Phase 1 — log-layer PII redaction (Tier 5 seam; upstream candidate; ~1 sprint).** Extend
  `redactMessage` (dedupe the JS/TS copies) with email / IP / phone / IBAN / ID patterns applied
  at **all** levels including `debugTraverse`; review IP logging in `logHeaders.js` /
  `banViolation.js`; confirm 14-day rotation. *Acceptance:* no raw email/IP in any log file.
- **Phase 2 — retention & minimization (Tier 0/4c/5 + DPO decision; 1–2 sprints).** Conversation /
  message TTL (period from DPO; implementation aligns with the roadmap's T3 CronJob direction);
  memory TTL / staleness purge; shared-link TTL; verify Meilisearch delete propagation; verify
  account-deletion completeness; Redis violation TTL.
- **Phase 3 — engine PoC + targeted persistence masking (Tier 3; PoC spike then 1–2 sprints).**
  Run the §6 PoC → decision. Then wire the two highest-ROI, non-streamed chokepoints: RAG-ingest
  scan/flag/mask for shared-agent knowledge files, and memory-write pseudonymization.
- **Phase 4 — optional inline input-masking (decision-gated; unscheduled).** Opt-in per
  model-spec / agent for designated high-risk flows; input-side only (streaming-safe);
  pseudonymize-with-re-hydration via the PII-Shield session pattern. Requires an explicit product
  decision that the flow's risk outweighs the utility loss.

---

## 9. Follow-up implementation tickets

Paste-ready drafts, in priority order. File these in the KK20 project; they are the concrete
output this discovery exists to produce.

### P0 — quick wins

**Title:** Default `DEBUG_LOGGING` off in production
**Type:** Task
**Summary:** Debug logging writes prompt/response content to logs. `.env.example` is defaulted off
in this PR; production is configured in `ct-shared-deployment-configs` and must be set explicitly.
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
`debugTraverse`; dedupe the JS/TS parser copies. Upstream-contribution candidate.
**AC:** [ ] patterns redacted at every level · [ ] parser duplication resolved · [ ] tests.

**Title:** Conversation & message retention policy + TTL sweep
**Type:** Story
**Summary:** Define retention periods (DPO) and implement a TTL sweep (align with the roadmap's T3
CronJob), cascading to Meilisearch, pgvector, and Blob.
**AC:** [ ] periods agreed · [ ] sweep deletes all copies · [ ] verification recipe.

**Title:** Memory entries — add TTL / staleness purge
**Type:** Task
**Summary:** `memory.value` has no TTL. Add staleness/TTL purge and a user-transparency review.
**AC:** [ ] TTL/purge implemented · [ ] user can see/clear memories.

**Title:** Verify account-deletion completeness on v0.8.5 baseline
**Type:** Task
**Summary:** Upstream Issue #10540 (orphaned metadata on deletion) fixed by PR #10534 — verify it's
present, including Meilisearch + pgvector + Blob cascade.
**AC:** [ ] deletion leaves no orphans across all stores.

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

**Title:** Meilisearch delete-propagation verify + field minimization
**Type:** Task
**Summary:** Verify deletes propagate to the index; assess a field-minimization option in
`mongoMeili` (possible upstream item).
**AC:** [ ] delete propagation verified · [ ] minimization assessed.

**Title:** Redis violation/ban TTL + IP-logging review
**Type:** Task
**Summary:** Bound retention of violation/ban records; review IP logging in
`logHeaders.js`/`banViolation.js`.
**AC:** [ ] TTL set · [ ] IP logging minimized.

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
| Relevant data categories & system touchpoints identified | §1 (+ demo data-flow map) |
| Defines what to mask / anonymize / pseudonymize / exclude | §3 matrix + §4 rules |
| Highlights risks, open questions, stakeholder dependencies | §7 |
| Provides a clear basis for engineering implementation tickets | §8 + §9 |

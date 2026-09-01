# Paste-ready Jira tickets — waves 0 and 1

Copy each block into the **KK20** project as-is. This file is the *filing* format; the analytical
source stays [`workstream.md`](./workstream.md) §5, which carries the evidence, file:line citations
and reasoning behind each one. Where the two differ, workstream.md is authoritative — this is a
transcription for convenience.

**Order to file:** the two code tickets first (they unblock development), then the platform
verifications, then the governance track. Each ticket's wave and necessity class is noted so the
Jira priority can mirror [`workstream.md`](./workstream.md) §4.4 and §6.1.

| # | Ticket | Wave | Class | Owner |
|---|---|---|---|---|
| 1 | Langfuse PII gate — reduce captured content | 1 | Industry standard | Eng |
| 2 | Wire 12-month audit-log retention | 1 | **Mandatory** | Eng |
| 3 | Verify Azure OpenAI modified-abuse-monitoring opt-out | 0 | Industry standard | Eng + Platform |
| 4 | Langfuse platform retention & access | 0→1 | **Mandatory** | Platform |
| 5 | Confirm Microsoft's hosted-grounding search terms | 0 | Industry standard | DPO + Eng |
| 6 | Interim privacy-notice update | 1 | **Mandatory** | Legal/DPO |
| 7 | Manual DSAR runbook, tested once | 1 | **Mandatory** | Eng + DPO |
| 8 | Staging erasure-verification recipe | 1 | **Mandatory** | Eng + Sec |
| 9 | DPIA for Agentic Karl | 0 | **Mandatory** | DPO |
| 10 | Works-council briefing & agreement | 0 | **Mandatory** | DPO + HR |
| 11 | EU AI Act deployer posture | 0 | **Mandatory** | Legal |
| 12 | Art. 30 record of processing | 0 | **Mandatory** | DPO |

---

## 1 · Langfuse PII gate — reduce captured content and open the masking path

**Title:** Langfuse PII gate — reduce captured content and open the masking path

**Type:** Bug

**Summary**
Langfuse went live in dev and prod without the PII gate KK20-207 named as a hard precondition (its
§12.2 lists "Langfuse keys set" as an activation trigger requiring review *before the first
trace*). Traces capture prompts, completions, memory-agent runs and feedback verbatim into a store
the Art. 17 erasure cascade does not reach. Langfuse is self-hosted in Knauf's own AKS, so this is
a retention and minimisation issue, not a data-leaves-the-estate incident. This ticket is
deliberately narrow: it removes only content with low debug value or a redundant copy elsewhere,
and opens the path to proper masking. Bounding the rest is ticket 4.

**Acceptance criteria**
- [ ] Users' free-text feedback no longer reaches Langfuse. `api/server/routes/messages.js:419-433`
      passes `feedback` whole to `sendFeedbackScore`, and `packages/api/src/langfuse/feedback.ts:93`
      joins `[tag, text]` into the score `comment`. Keep `rating` and `tag`; drop `text` — already
      durable in Mongo at `message.feedback.text`, so Langfuse is a redundant second copy of the
      highest-entropy free-text field in the product.
- [ ] Tool outputs are explicitly NOT disabled — record the decision and its reasoning so it is not
      silently reversed. Langfuse's own guidance: "aggressive whole-text scrubbing hurts
      debuggability; prefer targeted redaction plus short retention". Sprint 5 of
      `agent-retrieval-and-langgraph-reliability-plan.md` validates against these traces.
- [ ] Memory-agent trace payloads (`packages/api/src/agents/memory.ts:464-474`) reviewed separately
      — highest sensitivity, lowest marginal debug value.
- [ ] Identity posture pinned by a regression assertion (`userId`/`sessionId` stay pseudonymous
      Mongo ids).
- [ ] `LANGFUSE_SAMPLE_RATE` documented as NOT a privacy control — it is read only by
      `feedback.ts:40`, where `0` disables feedback scores.
- [ ] Upstream path opened: an issue or PR against `@librechat/agents` to forward
      `@langfuse/otel`'s `mask` parameter through `LangfuseConfig`. Never patch `node_modules`.

**Notes / links**
Plan: `knauf/docs/privacy/workstream.md` §5 (P0-1); design rationale §4.3. Precedent for per-run
gating: the existing `[knauf] KK20-199` image-input guard in `buildLangfuseConfig`
(`packages/api/src/agents/run.ts:887-918`). Tests:
`packages/api/src/agents/__tests__/run-summarization.test.ts` ("Langfuse run config") and
`packages/api/src/langfuse/feedback.spec.ts`. SEAMS.md already has a row for
`packages/api/src/agents/run.ts` — append, never edit.

---

## 2 · Wire 12-month audit-log retention and minimise what it captures

**Title:** Wire 12-month audit-log retention and minimise what it captures

**Type:** Task

**Summary**
The `auditLog` collection stores actor name, full client IP, full User-Agent and requestId with
every field `immutable` and a hash chain — append-only by design. It has no retention of any kind,
but the purge mechanism already exists: `purgeAuditLogEntries`
(`packages/data-schemas/src/methods/auditLog.ts:634-704`) is fully built, chain-safe (contiguous
`seq` boundary + checkpoint), requires `confirm: true`, and is wired to nothing. GDPR mandates a
justified, enforced period rather than a specific number; 12 months is the ISO 27001 A.8.15 / SOC 2
auditor convention, double the AI Act Art. 26(6) floor, and matches Microsoft Purview's E5 default
for Knauf's own M365 admin trail. Explicitly NOT the §257 HGB / §147 AO 6–10 year periods — this
log is neither Handelsbuch, Handelsbrief nor Buchungsbeleg, and importing those periods creates an
Art. 5(1)(e) / §26 BDSG problem rather than compliance.

**Acceptance criteria**
- [ ] 12-month rolling purge wired to the existing `purgeAuditLogEntries`, modelled on the
      file-retention sweep (`packages/api/src/files/sweep.ts`, wired at
      `api/server/experimental.js:254-268` on a dedicated cluster worker). Persist the chain
      checkpoint so hash-chain verification of the remainder survives deletion.
- [ ] Ships inert: retention unset ⇒ disabled; dry-run default true (the method's `confirm` flag
      gives this for free). Rollout: dev dry-run → read counts → DPO ratifies the period → enable.
- [ ] Purge iterates per tenant plus the platform chain (`PLATFORM_CHAIN_KEY`) —
      `purgeAuditLogEntries(tenantId, …)` is per-chain.
- [ ] Write-time IP / User-Agent minimisation decided: `buildAuditContext`
      (`packages/api/src/admin/context.ts:12-21`) captures both verbatim, and because the hash
      covers them they can never be truncated retroactively. Minimise at write, or accept in
      writing.
- [ ] `metadata` write-guard: the field is `Schema.Types.Mixed` and the CSV export dumps it
      verbatim as a `Details` column. Today only `{ capability }` lands there. Adopt and enforce
      (write-time allowlist) the rule that no free text, tool arguments, filenames or message
      content may enter audit metadata — entries are immutable and unredactable.
- [ ] `actor.name` fallback reviewed: `user.name || user.username || user.email || userId`
      (`packages/api/src/admin/grants.ts:186`, identically `admin/roles.ts:197`) can immortalise an
      email address in an unredactable record. Prefer opaque id + display name only.
- [ ] The export is itself audited: `GET /api/admin/audit-log/export.csv` (17 columns incl. IP and
      `Details`) is capability-gated but leaves no trail of who exported what, when. Emit an audit
      entry per export; state a handling rule for exported files.
- [ ] Account-deletion position documented: the `UserController` cascade (~25 stores) never touches
      `AuditLog`, so today deletion silently resolves to retain-forever. Record the Art. 17(3)
      position, time-boxed by the 12-month purge.
- [ ] Works-council: this log is squarely a §87(1) Nr. 6 BetrVG system — the purge design goes on
      the co-determination agenda (purpose limited to security/audit, expressly no performance
      monitoring, named-role access).
- [ ] Reviewers told that the taxonomy's `agent_run`/`tool_call`/`mcp`/`auth`/`approval` categories
      are reserved but unwritten — only grant assign/revoke is audited today (3 writers:
      `grants.ts:423-430`, `:495-502`, `roles.ts:199-213`).

**Notes / links**
Plan: `knauf/docs/privacy/workstream.md` §5 (P2-7); retention legal analysis §3.4. Data-safe on day
one: the collection shipped 2026-06-18 (upstream #13087), so a 12-month purge deletes nothing
before ~2027-06 — the wiring can land well ahead of the works agreement. New files under
`packages/api/src/knauf/` need SEAMS.md Net-New rows; the `experimental.js` wiring needs a
`[knauf]` marker plus an Inline row.

---

## 3 · Verify the Azure OpenAI modified-abuse-monitoring opt-out

**Title:** Verify the Azure OpenAI modified-abuse-monitoring opt-out

**Type:** Task

**Summary**
The entire "the model call is the least risky hop" thesis rests on one unverified platform fact:
whether the tenant holds the modified-abuse-monitoring opt-out, without which Azure OpenAI may
retain prompts (with PII) for up to 30 days for human abuse review. This has been the top open
question since the assessment's v1.0 (2026-07-03) and had no ticket until now. Pure verification,
no code.

**Acceptance criteria**
- [ ] Opt-out status confirmed with the Azure subscription owner and evidenced (portal screenshot
      or support case reference).
- [ ] If unanswered after ~5 business days: recorded as escalated-and-pending and work proceeds;
      the DPIA provisionally carries the 30-day Azure retention as a live processing fact.
- [ ] Result recorded in the assessment's §7.1 risk register.
- [ ] If NOT opted out: the assessment's §3 strategy has its first step re-argued, and the DPIA
      carries the retention as a live fact rather than a risk.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (P0-6), wave 0. Blocks nothing mechanically but shapes the
DPIA and the strategy's headline claim.

---

## 4 · Langfuse platform retention, access and EE-licence status

**Title:** Langfuse platform retention, access and EE-licence status

**Type:** Task

**Summary**
Ticket 1 reduces what is written to Langfuse; only platform retention actually deletes it. Because
targeted field-level masking is unreachable today (no `mask` hook forwarded by
`@librechat/agents`; Langfuse's server-side ingestion masking is Enterprise Edition), retention and
access are what actually bound the exposure — and they need no code, no licence and no upstream
change. Short retention is also what makes keeping debuggable payloads defensible. Cross-repo:
`agk-deployment-configs`.

**Acceptance criteria**
- [ ] Documented: which environments send traces, whether prod uses a separate instance from
      `langfuse.agk.dev.knauf.digital`, current retention, and which Okta group can read prod
      traces.
- [ ] Project data-retention period set (from the DPO retention matrix). Highest-value action in
      the Langfuse workstream.
- [ ] ClickHouse / Postgres / MinIO lifecycle aligned with that period — retention the object store
      ignores is not retention.
- [ ] `LANGFUSE_TRACING_ENVIRONMENT` differs dev vs prod so prod can carry a shorter period.
- [ ] Read access reviewed and recorded — trace payloads are message content, so the group that can
      read them can effectively read user conversations.
- [ ] EE licence status confirmed: server-side ingestion masking
      (`LANGFUSE_INGESTION_MASKING_CALLBACK_URL`) is Enterprise-only and determines whether a
      Presidio masking callback is even an option later.
- [ ] Sampling considered if prod volume warrants it — reduces exposure and cost together.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (P0-2), §4.3. Do this ticket's investigation half **before**
ticket 1's code — its answers decide whether ticket 1 is urgent or routine.

---

## 5 · Confirm Microsoft's terms for the hosted grounding search

**Title:** Confirm Microsoft's terms for the Azure OpenAI hosted web_search tool

**Type:** Task

**Summary**
`karl-web`'s native web search is live, so user-derived queries — which can carry the same PII as
the prompt — leave to a search backend that appears in no data map and no processor review. The
mechanism is now identified: it is the Azure OpenAI Responses API's hosted `web_search` tool
(`useResponsesApi: true` + `addParams: { web_search: true }`, KK20-194/KK20-175), so no third-party
key is involved and no query leaves through the app's own HTTP client — Microsoft grounds
server-side. What remains is a terms question, and it is load-bearing.

**Acceptance criteria**
- [x] The mechanism behind `web_search` identified and documented (done 2026-09-01).
- [ ] The residual question answered by DPO/Legal: do Microsoft's terms for hosted grounding search
      carry the same DPA and EU Data Boundary commitments as the completion itself, or separate
      search/grounding terms with different retention and sub-processor handling?
- [ ] Added to the assessment's §1.1 data map and the §3.1 Art. 28 processors row.
- [ ] If outside the boundary: the query-content implications stated and the spec's exposure
      re-argued — it is one `addParams` key, so cheaply reversible.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (P0-7), wave 0.

---

## 6 · Interim privacy-notice update for Langfuse, auditLog and memory

**Title:** Interim privacy-notice update for Langfuse, auditLog and memory

**Type:** Task

**Summary**
The EULA/privacy notice cites GDPR Art. 13, 15–18, 20 and 7(3), but it predates three live
processing activities: Langfuse tracing of prompts and completions, the `auditLog`'s IP and
User-Agent capture, and LLM-written memory profiling. Processing outside the notice is a continuing
Art. 13 gap that accrues daily, so the interim update must not wait for the works agreement — only
the consolidated final text rides with that.

**Acceptance criteria**
- [ ] Interim notice (EULA addendum or intranet privacy-notice revision) covers Langfuse tracing,
      `auditLog` capture and memory profiling, with retention periods where known.
- [ ] Published and users informed by the end of the containment sprint.
- [ ] Consolidated text folded into the works agreement when that lands.
- [ ] A rule recorded that every new data sink triggers a notice re-review — wired into the
      upstream-sync / feature-PR checklist.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (G-5); §3.1's Art. 13/14 row was previously marked "Done" and
is now correctly marked stale.

---

## 7 · Manual DSAR runbook, documented and tested once

**Title:** Manual DSAR runbook, documented and tested once

**Type:** Task

**Summary**
Art. 15 is a live obligation with an Art. 12(3) one-month clock, and today a subject access request
would require manual archaeology across nine sinks. A manual path can satisfy Art. 15 — but only
once it is written down and rehearsed. This is the mandatory half of the data-subject-access work;
the self-service export endpoint is the (later, convention) mechanism.

**Acceptance criteria**
- [ ] A documented runbook covering every sink: Mongo (messages, conversations, memories, files,
      users, feedback), Meilisearch, pgvector, Azure AI Search, Blob, **Langfuse traces**
      (addressable via tenant tags and `librechat.source.message.id` metadata) and the subject's
      **`auditLog` entries**.
- [ ] Rehearsed end-to-end once against a test subject, with elapsed time recorded against the
      one-month clock.
- [ ] Any pending or incoming DSAR promotes this ticket to immediate.
- [ ] Becomes the standing evidence that Art. 15 is answerable pending the endpoint.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (P2-6a, carved out of P2-6's AC). Access mirrors erasure: the
sinks this discloses are the sinks ticket 8 verifies.

---

## 8 · Staging erasure-verification recipe

**Title:** Staging erasure-verification recipe across all sinks

**Type:** Task

**Summary**
Art. 17 requires erasure that demonstrably reaches every copy, and Art. 5(2) requires being able to
show it. The account-deletion cascade covers ~25 stores in code but has never been verified
behaviourally, and it does not reach Langfuse at all. Nothing here needs a retention number, so it
does not wait for the DPO matrix.

**Acceptance criteria**
- [ ] Delete an account and a conversation in staging; verify Mongo, Meilisearch, pgvector, Azure
      AI Search, Blob and Langfuse are clean.
- [ ] A defined Langfuse deletion path for an Art. 17 request arriving inside the retention window
      — retention alone does not answer a live erasure request.
- [ ] Runs green; becomes the standing DSAR erasure evidence.
- [ ] Re-run after the conversation/message retention change lands.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (P2-5). Pulled out of the DPO gate deliberately — it needs no
period, and it is what makes ticket 7's runbook honest.

---

## 9 · DPIA for Agentic Karl

**Title:** Data protection impact assessment for Agentic Karl

**Type:** Task

**Summary**
Art. 35 is engaged: large-scale processing of employee data, profiling-grade memory, and a
workplace context together meet multiple WP248 criteria. No DPIA exists. The KK20-207 assessment
and the privacy workstream plan are the input, not a substitute.

**Acceptance criteria**
- [ ] DPIA completed against the restored assessment v1.2 plus `workstream.md` §2's delta.
- [ ] Covers the sinks that post-date the original assessment: Langfuse, `auditLog`, Azure AI
      Search, model reasoning content, cost/usage records.
- [ ] Carries the Azure abuse-monitoring answer from ticket 3 (or its pending status).
- [ ] Residual-risk position recorded; prior-consultation need assessed.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (G-1) and §3.1.

---

## 10 · Works-council briefing and agreement

**Title:** Works-council briefing and agreement for Agentic Karl

**Type:** Task

**Summary**
BetrVG §87(1) Nr. 6 gives the works council co-determination over technical systems **suited** to
monitor employee behaviour or performance — the test is "suited to", not "intended to". Per-user
cost/usage records, LLM-written memories and the `auditLog` all plausibly qualify. This is the
highest-leverage governance item: a works agreement can settle the Art. 6 basis for memory, the
§87(1) Nr. 6 duty and the retention periods that gate the retention wave, in one conversation.

**Acceptance criteria**
- [ ] Briefing prepared and delivered; the audit-log purge design explicitly on the agenda (purpose
      limited to security/audit, expressly no performance monitoring, named-role access).
- [ ] Works-council position recorded.
- [ ] Retention periods agreed per category, feeding the DPO retention matrix.
- [ ] Any constraints fed back into the handling matrix.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (G-2), §3.3. Longest calendar lead time in the plan — start
in wave 0.

---

## 11 · EU AI Act deployer posture

**Title:** Record the EU AI Act deployer posture for Agentic Karl

**Type:** Task

**Summary**
Knauf is a deployer, not a provider — the GPAI models are Microsoft's/OpenAI's. Two obligations are
live today: Art. 4 AI literacy (in force since 2025-02-02) and Art. 50 user-disclosure
transparency (since 2026-08-02). KARL is probably not Annex III high-risk, but that determination
should be written down along with the triggers that would change it.

**Acceptance criteria**
- [ ] Deployer (not provider) determination recorded and confirmed with Legal.
- [ ] Art. 4 AI literacy evidenced (onboarding material, EULA, internal FAQ).
- [ ] Art. 50 transparency confirmed — users know they are interacting with an AI.
- [ ] The three Annex III.4 drift triggers registered as watch items: per-user cost metering
      growing an employee-comparison surface; memory used beyond its own user; any feature scoring
      or ranking staff output.
- [ ] Position restated if any trigger fires — Art. 26 duties (incl. the ≥6-month log retention and
      Art. 26(7) worker-representative notification) would then attach.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (G-3), §3.2.

---

## 12 · Art. 30 record of processing

**Title:** Create the Art. 30 record of processing for Agentic Karl

**Type:** Task

**Summary**
Art. 30(1) requires a record of processing activities, and the Art. 30(5) small-organisation
exemption is unavailable. The assessment's §1.1 data map is the natural source but is prose, not a
record.

**Acceptance criteria**
- [ ] §1.1's categories promoted into a formal Art. 30 record, incl. purposes, categories of data
      subjects and recipients, transfers and retention periods.
- [ ] Covers the newer sinks: Langfuse, `auditLog`, Azure AI Search, model reasoning, cost records,
      the hosted search hop.
- [ ] Kept current by the PII-regression checklist in the upstream-sync ritual.

**Notes / links**
`knauf/docs/privacy/workstream.md` §5 (G-4).

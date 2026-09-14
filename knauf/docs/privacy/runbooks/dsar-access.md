# DSAR runbook — Art. 15 access request for an Agentic Karl user

**Ticket:** KK20-331 (workstream item **P2-6a**) · **Owner:** Eng + DPO · **Status:** written
2026-09-03, **not yet rehearsed** — the first rehearsal against a test subject, with elapsed time
recorded, is this ticket's remaining acceptance criterion.

This is the manual path. It exists because Art. 15 is a live obligation today and the self-service
export endpoint (P2-6) does not exist yet. A manual path *can* satisfy Art. 15 — but only once it is
written down, covers every copy, and has been run once. That is what this document is for.

> **The clock.** Art. 12(3): respond **within one month of receipt**. Extendable by **two further
> months** where necessary given complexity or volume — but the subject must be told of the
> extension, and why, **within the first month**. Log the receipt date the day it arrives.

---

## 0. Before collecting anything

| Step | What | Basis |
|---|---|---|
| **Receipt** | Record date received, channel, and the requester's stated identity in the DSAR register (§6) | Art. 12(3) clock starts here |
| **Identity** | Confirm the requester is the data subject. Reasonable doubt ⇒ ask for what is needed to confirm, no more. For a KARL employee, an Okta-authenticated request from their own account is sufficient | Art. 12(6) |
| **Scope** | Default is *all* personal data. If the subject narrows it ("just my conversations"), record that in writing | Art. 15(1) |
| **Resolve the subject** | You need the Mongo `users._id`. Resolve from email / `username` / `openidId` via `users`. **Every other sink is keyed by this id** — Langfuse `userId`, Meilisearch `user`, the audit log's `actor.id`/`target.id`, all Mongo `user`/`userId`/`author` fields | — |
| **Pin the tenant** | `email` is unique **only within `(email, tenantId)`** — `userSchema.index({ email: 1, tenantId: 1 }, { unique: true })`. Two tenants can hold the same address. The collector refuses to guess: an email matching more than once exits **3** and names the tenants; re-run with `--tenant <id>`. Record the resolved tenant on the DSAR register row | Art. 5(1)(f) — exporting the wrong person is a breach |

Run the collector in **summary mode** first — it is read-only and prints per-sink counts, which tells
you the size of the job before you commit to it:

```bash
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email>
```

---

## 1. The sinks, and what each one actually holds

The workstream's §1 model has nine places personal data lives; this runbook splits the last of them
in two, because browser telemetry and server logs are one platform but not one legal answer (§1.9 vs
§1.10). A DSAR that covers seven is not compliant; it is a partial answer with a compliance label on
it. For each sink: **what**, **how to get it**, **what to redact**, and the **honest limitation**.

### 1.1 MongoDB — the primary copy (32 stores)

**How this list is kept complete.** It is *not* derived from the account-deletion cascade. The
cascade is not an independent schema inventory — anything it forgets is invisible to a check that
only compares the two. Instead `dsar-collect.spec.js` enumerates the **live model registry**
(`packages/data-schemas/src/models/index.ts`) and fails unless every registered model is either
collected or listed in `NOT_SUBJECT_SCOPED` with a written reason, so a new model cannot land
without someone making a disclosure decision about it. The cascade pin is kept as a second, weaker
check: erasure must never reach a store disclosure does not.

| Collection | Owner field | Contains | Disclose? |
|---|---|---|---|
| `users` | `_id` | Identity record: email, name, username, `openidId`, `idOnTheSource`, avatar, role, provider, terms acceptance, personalization flags | **Yes — redact** `password`, `totpSecret`, `backupCodes`, `refreshToken` (security artefacts, not information about the person) |
| `messages` | `user` | Every prompt and response, incl. **`content[]` think parts** (model reasoning restates the prompt) and **`feedback.text`** (free-text comments) | Yes, in full |
| `conversations` | `user` | Titles (derived from content), model, settings | Yes |
| `memoryentries` | `userId` | LLM-written facts about the user — **profiling-grade**; the most sensitive store here | Yes, in full. Expect the subject to be surprised by it |
| `files` | `user` | Upload metadata: filename, type, size, `filepath`/`storageKey`, `embedded`, `context` | Yes; the **bytes** are in Blob (§1.5) |
| `sharedlinks` | `user` | Public snapshots the subject created | Yes |
| `transactions`, `balances` | `user` | **Per-user cost/usage records** — EUR-priced per message | Yes. Note: these are the Annex III.4 drift-trigger data; their existence is itself something the subject is entitled to know |
| `presets`, `conversationtags`, `toolcalls`, `assistants`, `actions` | `user` | Settings, tags, tool invocations and their arguments/outputs, assistant configs, action configs | Yes (`toolcalls` can carry content — read before releasing) |
| `agents`, `prompts` + `promptgroups`, `skills`, `mcpservers` | `author` | Things the subject authored | Yes |
| `agentapikeys`, `pluginauths`, `keys`, `tokens`, `sessions` | `userId` / `user` | **Credentials and session material** | **Existence + provider + timestamps only.** Never the values — they are encrypted secrets to third-party services and session tokens; disclosing them is a security incident, not compliance |
| `groups` | `memberIds` ∋ **`idOnTheSource \|\| _id`** | Group memberships (incl. Entra/Okta-synced). `userGroup.js` writes `user.idOnTheSource \|\| userId.toString()`, so an OIDC-sourced subject is a member under their **external** id — querying `_id` alone returns zero groups for exactly the users who have them | Yes, **projected**: name/description/source only. `memberIds` is **withheld** — it is every other member's identifier (Art. 15(4)) |
| `aclentries` | `principalId` | What the subject has been granted access to | Yes |
| `chatprojects` | `user` | KK20-248 project workspaces — **`instructions` is subject-authored free text** | Yes, in full |
| `chatprojectsources` | `user` | Project source associations, ingest status and error text | Yes |
| `knauf_file_assets` | `scope_type:'user'` + `scope_id` | **KK20-195 physical ledger** — authoritative for blob path, `vector_backend`, `active_generation`, `stale_generations`, indexing errors. See §1.3/1.4 | Yes |
| `skillfiles` | `author` | Skill file content the subject authored | Yes |
| `skillsyncstatuses` | `owner` | Skill sync state | Yes |
| `configs` | `principalId` | Per-principal config overrides | Yes |
| `systemgrants` | `principalId` | Capabilities the subject holds | Yes — **redact `grantedBy`** (the granting admin is a third party) |
| `skillsynccredentials` | `createdBy` | Sync credentials | **Existence only** |
| `knauf_agent_schedules` (`user`), `knauf_scheduled_agent_runs` (`ownerId`) | — | Scheduled-agent definitions and run history (Knauf-only) | Yes |
| `auditlogs` | `actor.id` **and** `target.id` | See §1.7 — needs Art. 15(4) handling | Yes, redacted |

**Tenant scoping.** Every model is tenant-isolated, and `runAsSystem` sets `SYSTEM_TENANT_ID`, which
makes `applyTenantIsolation` **skip tenant injection entirely** — a system-scoped query sees every
tenant. The collector uses that deliberately, but only for *resolution*, and only to **detect**
ambiguity: it looks across tenants precisely so that an email matching twice is caught rather than
silently resolved to whichever row Mongo happened to return first. Once the subject is resolved, the
whole collection re-runs inside `tenantStorage.run({ tenantId })` pinned to **that subject's own
tenant**, and `manifest.tenant.resolved` records which one. If `--tenant` is passed and disagrees
with the resolved subject, the collector exits **3** rather than proceeding.

### 1.2 Meilisearch — full-text replica

Indexes `messages` and `convos` hold a copy of message text and titles. The **only filterable
attribute is `user`** (`mongoMeili.ts`), which is exactly what a DSAR needs:

```
POST /indexes/messages/search  { "filter": "user = <mongo-id>", "hitsPerPage": 1000, "page": 1 }
POST /indexes/convos/search    { "filter": "user = <mongo-id>", "hitsPerPage": 1000, "page": 1 }
```

**Page to exhaustion — do not use `offset`/`limit`.** A single `{"limit": 1000}` call returns one
page, and offset/limit queries report only `estimatedTotalHits`, so a heavy user is silently
truncated and the step still looks like it succeeded. `page`/`hitsPerPage` returns an exact
`totalHits` and `totalPages`: loop until `page > totalPages`, then reconcile the rows you wrote
against `totalHits` and **fail the collection if they disagree**. `meilisearch.md` in the bundle
carries a ready scripted version that does exactly this and exits non-zero on a mismatch.

**What to disclose:** this is a *derived copy* of §1.1 content — disclose that the replica exists and
attest that its counts match Mongo. Do not hand over the same text twice as if it were different
data. **Limitation:** think parts are indexed too (workstream P1-5), so the replica may hold
reasoning text; it is still the same category.

### 1.3 pgvector and 1.4 Azure AI Search — vector stores (via `rag_api`)

Both hold **embedded chunks of the subject's uploaded files**.

**The logical `file_id` is not the physical key, and `context` is not the backend.** Precisely:

- The id vectors are stored under is **`knauf_asset_id ?? file_id`** — `VectorDB/crud.js` routes on
  exactly that value in both `deleteVectors` and `deleteVectorsForFiles`. After KK20-204 dedup or a
  KK20-195 re-index, a file's vectors do **not** live under its logical `file_id`.
- The backend is recorded on the asset as **`KnaufFileAsset.vector_backend`**. Inferring it from
  `context === 'agents'` also ignores `isAzureSearchEnabledForAgents()`, so with Azure Search off it
  attests Azure for files that are actually in pgvector.
- **`active_generation`** decides which vectors are live, and **`stale_generations`** is cleanup
  debt — generations whose RAG delete failed and which may still hold embeddings.

So the collector **joins `files` to `knauf_file_assets`** and reports the asset's own state. A file
with no asset row (pre-KK20-195 legacy) falls back to the old heuristic and is flagged
`unverified: true` rather than asserted as fact; those appear in `manifest.completeness.warnings`
and the collector exits **4**.

**Limitation, stated plainly:** `rag_api` exposes **no read-back-by-subject endpoint**. `/documents`
and `/agent/documents/{file_id}` are *delete* paths; `/query*` needs a query string. You cannot dump
"all vectors for user X" yourself. What you can — and must — do:

1. Take `vector-inventory-request.json` from the bundle: an exact, tenant-scoped list of **physical**
   vector ids per backend, plus the unverified ones and any stale-generation debt.
2. **Ask the RAG service to confirm it** — which ids exist under this tenant, and their chunk counts.
   That is the step that turns an assertion into an attestation; a count derived from the wrong
   identifier would have been neither.
3. Disclose that embeddings of those files exist in those stores, with the confirmed list.
4. The **content** they were computed from is the source file in Blob (§1.5) — disclose that.

Embeddings of personal data are personal data (workstream A8); the subject is entitled to know
they exist. They are not entitled to a vector dump nobody can read, and the source file is the
faithful copy.

### 1.5 Azure Blob — the file bytes

Container `AZURE_CONTAINER_NAME` (default `files`); key is `files.filepath` / `storageKey`. The
subject's uploads and avatar. **Disclose by providing the files**, via short-TTL SAS URLs from the
existing signer (`api/server/services/Files/Azure/crud.js`) or a bundled download — never by making
the container public.

### 1.6 Langfuse — traces, scores

Self-hosted; traces carry prompts, completions, tool outputs, reasoning, and feedback scores.
`userId` in Langfuse **is the Mongo user id**; `sessionId` is the conversation id; traces carry a
`tenant:<id>` tag and `librechat.source.message.id` metadata (verified by the KK20-327 identity
assertion). The collector emits these commands into `langfuse.sh`:

```bash
# traces incl. input/output payloads and observations (tool outputs, reasoning live in observations)
npx langfuse api traces list --user-id <mongo-id> --fields core,io,observations --limit 100 --page N --json
# feedback scores (tag only since KK20-327; older scores may carry free text)
npx langfuse api scores list --user-id <mongo-id> --fields score,trace --limit 100 --page N --json
```

**Page until the API says it is exhausted — not for a fixed number of pages.** A fixed
`for p in 1 2 3 … 10` loop caps at 1,000 traces and 500 scores and still exits 0, so a heavy account
produces a short bundle that looks successful. Every paginated Langfuse response carries
`meta.totalItems` and `meta.totalPages`, so the generated `langfuse.sh`:

- pages while `page <= meta.totalPages`, under a `MAX_PAGES` circuit-breaker;
- wraps each call in `timeout` with bounded retries and backoff (`LANGFUSE_TIMEOUT`,
  `LANGFUSE_RETRIES`);
- **reconciles** the rows it wrote against `meta.totalItems` and **exits non-zero** on any mismatch,
  on retry exhaustion, or on hitting `MAX_PAGES`.

It runs under `set -euo pipefail`, so a partial run stops rather than continuing past a hole. **A
bundle from a failed run must not be released.**

**Disclose:** trace payloads are the same conversation content as §1.1, held under
a separate retention regime — say so, and state that regime (ticket 4). **Limitation:** scores
created *before* KK20-327 may carry the subject's free-text comment verbatim; the collector flags
any score whose `comment` is not a bare reason key.

### 1.7 `auditlogs` — and the Art. 15(4) rule

The subject appears two ways:

- **As `target.id`** — an admin did something *to* them (a grant assigned/revoked). The row names
  the admin in `actor.name`/`actor.id`. **That admin is a third party.** Art. 15(4): the right to a
  copy "shall not adversely affect the rights and freedoms of others" — **redact the actor** from
  target-rows. The collector does this by default.
- **As `actor.id`** — the subject acted as an admin. They are the actor; disclose in full,
  including the target (their own conduct).

**Finding:** the admin list API (`listAuditLogPage`) filters only by actor/target **name
substring**, not id — it cannot do a reliable by-subject lookup, and name matching would miss
renames and leak lookalikes. The collector reads the collection directly, read-only.

**What exists is bounded** by the 12-month retention (KK20-328) once enabled; say so.

### 1.8 winston server logs — files **only if** `LOG_TO_FILE` is on

`requestContextFormat` attaches **`userId`, `tenantId` and `requestId`** to log records. Those records
are attributable to a named subject — which makes *where they land* the question that matters, and it
is not always `api/logs/`:

| `LOG_TO_FILE` | Where server logs go | How to collect |
|---|---|---|
| `true` (the `.env.example` default; typical local/dev) | `error-%DATE%.log` / `debug-%DATE%.log` under `LIBRECHAT_LOG_DIR`, **14-day** rotation | the commands below, or `--include-logs` |
| `false` | **No files are written at all.** Only the console transport runs — and it carries the same `userId`/`tenantId`/`requestId` via `appendRequestContext`. Container stdout is then collected by whatever ships logs in that environment | **§1.10.** The file path finds nothing, and its silence is not evidence of absence |

**Check the deployed value before trusting this step.** `LOG_TO_FILE` is set by GitOps, not by this
repo, so read it from the running environment rather than from `.env.example`. The collector records
`sinks.winstonLogs.fileLoggingEnabled` in the manifest and raises a completeness warning (exit **4**)
when file logging is off or the directory is missing, precisely so an empty `logs.json` is never
mistaken for "no server logs exist".

```bash
grep -l "<mongo-id>" ${LIBRECHAT_LOG_DIR:-api/logs}/*.log
grep -h "<mongo-id>" ${LIBRECHAT_LOG_DIR:-api/logs}/*.log > logs.jsonl
```

**Disclose:** error events tied to the user within the retention window are personal data. Include
them. If prod log access is restricted (it should be — workstream P0-5), the platform team runs this
step.

### 1.9 Browser analytics — **excluded, with the reason written down**

This covers **client-side** telemetry only: Datadog Browser RUM + Logs
(`client/src/knauf/analytics/datadog/`), Adobe Analytics (`analytics/adobe.ts`), and the OneTrust
consent gate (`analytics/consent.ts`) that fronts both.

The exclusion holds. The specific basis, rather than an assertion:

- **No user identity is ever attached.** `getRumConfig()` / `getLogsConfig()` never call
  `datadogRum.setUser()` — there is no `setUser` call anywhere in the module.
- `defaultPrivacyLevel: 'mask-user-input'`, `sessionReplaySampleRate: 0`, and
  `trackingConsent: 'not-granted'` until OneTrust grants it.
- Adobe's only identifier is `user_session_id`: a **random per-session id** in `sessionStorage`
  (`adobe.ts` → `createSessionId`). It is not derived from the account and does not survive the
  session.

So there is no key by which this data can be attributed to a named subject — it is not retrievable
*for this subject*, and that is what the exclusion rests on. **State the exclusion and its reason in
the response.** Two caveats to keep honest: (1) `forwardConsoleLogs: ['error']` and
`forwardErrorsToLogs: true` mean browser `console.error` payloads are forwarded and are
**unreviewed** (workstream P1-2) — until that review lands, say "we have no means to attribute, and
we are reviewing the payloads"; (2) platform-side retention and region are P1-2's open questions.

### 1.10 Server logs and APM in the log platform — **attributable, so in scope**

This is the sink §1.9 must not be allowed to absorb. Browser RUM being anonymous says nothing about
server-side records, and putting both under one "Datadog — excluded" heading reads as a blanket
exclusion the evidence does not support.

Server logs carry `userId`, `tenantId` and `requestId` on **both** transports (§1.8). Wherever
container stdout is shipped, that destination holds **attributable** server logs about the subject,
and they are in scope for Art. 15.

**Before the first rehearsal, the platform team must confirm and record in §6:**

| Question | Why it matters |
|---|---|
| Is `LOG_TO_FILE=false` in each deployed environment? | Decides whether §1.8 or this section is the real path |
| Which platform receives container stdout, in which region, under which account? | Recipients + transfers, Art. 15(1)(c)/(f) |
| What is the retention period there? | Art. 15(1)(d) |
| Is APM/trace data enabled, and does it carry `userId`/`tenantId` tags? | A second attributable store |
| Who owns and approves an export? | The procedure below needs a named approver |

**Bounded export procedure** — owner-approved, minimised, and logged:

1. **Get written approval** from the log-platform owner, naming the subject, the window and the
   requester. Record it on the DSAR register row.
2. Query by the **`userId` attribute**, not free text — a substring search over log bodies both
   misses records and returns other people's.
3. **Bound the window** to the platform's retention period, and state that period in the response.
4. **Page to exhaustion** and reconcile against the reported total, the same rule as §1.2/§1.6. Fail
   the step rather than release a truncated extract.
5. **Review before release.** Server logs routinely contain other subjects' identifiers in the same
   file, and stack traces that are system information rather than information about the person —
   redact third-party ids (Art. 15(4)) and drop non-personal noise.
6. If the platform cannot answer by `userId`, **say so in the response** as a stated limitation. Do
   not substitute the anonymous-RUM exclusion for an answer about server logs.

**Not verifiable from this repo.** The deployment questions above live in GitOps. Until they are
answered and recorded, treat this section as **open**, not as satisfied.

---

## 2. Collect

```bash
# 1. Summary first — read-only, prints per-sink counts
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email>

# 2. Full bundle
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email> --out ./dsar-<ticket>/ --include-logs
```

The bundle is one JSON file per sink plus:

| File | What it is |
|---|---|
| `manifest.json` | Counts, timestamps, the **resolved tenant**, redactions applied, exclusions and their reasons, and a **`completeness`** block listing anything that could not be established |
| `langfuse.sh` | Executable. Pages to exhaustion, reconciles against `meta.totalItems`, exits non-zero if short (§1.6) |
| `meilisearch.md` | The `page`/`hitsPerPage` recipe, with a scripted version that fails on a count mismatch (§1.2) |
| `vector-inventory-request.json` | Exact **physical** vector ids per backend, for the RAG service to confirm (§1.3/1.4) |

The collector **never writes to Mongo** — it uses `.find().lean()` only, and the spec pins the
redactions and the inventory.

**Exit codes — a non-zero exit means the bundle is not releasable:**

| Code | Meaning |
|---|---|
| `0` | Complete. `manifest.completeness.ok` is `true` |
| `2` | No user matches the reference |
| `3` | **Ambiguous or contradicted subject** — the email matched in more than one tenant, or `--tenant` disagreed with the resolved subject. Re-run with the right `--tenant`; do **not** guess |
| `4` | Collected, but with open completeness warnings (unverified vector backends, logs not collected, a sink whose model is not registered). Read `manifest.completeness.warnings` and resolve each before release |

Then run `langfuse.sh` and the Meilisearch recipe from a host with the credentials, send
`vector-inventory-request.json` to the RAG service, pull the Blob objects for the `files` list, and
complete §1.10 with the platform team. Add their outputs to the bundle.

---

## 3. Review before release

- [ ] **Third-party data** (Art. 15(4)): actor identities redacted on target-rows (§1.7); any other
      person's data inside the subject's messages (colleagues named in prompts) — the subject wrote
      it, it is theirs to receive; do not over-redact the subject's own content.
- [ ] **Secrets stripped** — spot-check `users.json` for `totpSecret`/`backupCodes`/`refreshToken`;
      `keys`/`pluginauths`/`tokens`/`sessions` show existence only.
- [ ] **Derived copies labelled** — Meilisearch and Langfuse presented as copies with their own
      retention, not as new categories.
- [ ] **Group memberships projected** — `groups.json` names the groups but **not** `memberIds`;
      confirm no other member's identifier appears anywhere in the bundle (Art. 15(4)).
- [ ] **Completeness clean** — the collector exited `0` and `manifest.completeness.warnings` is
      empty. If it exited `4`, every warning is resolved and recorded on the register row.
- [ ] **Tenant recorded** — `manifest.tenant.resolved` matches the tenant on the register row.
- [ ] **External sinks proved complete** — `langfuse.sh` printed `OK:` for both resources, the
      Meilisearch counts reconcile against `totalHits`, and the RAG service confirmed the vector
      inventory. A step that was not run is not a step that found nothing.
- [ ] **Exclusions stated** — browser analytics (§1.9), with the reason, and **not** conflated with
      server logs; vector stores attested by **physical** id and confirmed by the RAG service
      (§1.3/1.4).
- [ ] **Server logs addressed** (§1.10) — either exported under approval, or the limitation stated
      in the response. Silence from §1.8 is not an answer.
- [ ] **The Art. 15(1) narrative** written: purposes, categories, recipients (Azure OpenAI, Azure AI
      Search, the hosted search backend, the log platform), retention periods per category (from the
      retention matrix; "not yet set" where true), source of the data, and the existence of
      rights 16–21. Do **not** state "no profiling" — memory is profiling; see G-5.

## 4. Deliver

Art. 15(3): first copy free; electronic if the request was electronic. Use a secure internal
channel (never email attachments of the bundle). Record delivery date in the register.

## 5. If it is an erasure request too

Stop — that is the erasure recipe (P2-5, ticket 8), which this bundle is the "before" evidence for.

## 6. The DSAR register

A private record (not in this repo) with: receipt date, requester, identity-check method, scope,
extension used (Y/N, reason, date notified), collector run id, redactions applied, exclusions
stated, delivery date and channel, elapsed days. This is the Art. 5(2) evidence that Art. 15 is
answerable. Keep it where the DPO can see it.

---

## Rehearsal (the remaining AC)

Run §0–§4 end-to-end against a **test subject** in dev. Record elapsed working time per section.
Anything that took more than an hour is a candidate for the P2-6 endpoint. Record the result in
the workstream implementation log.

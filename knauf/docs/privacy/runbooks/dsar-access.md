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

Run the collector in **summary mode** first — it is read-only and prints per-sink counts, which tells
you the size of the job before you commit to it:

```bash
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email>
```

---

## 1. The nine sinks, and what each one actually holds

The workstream's §1 model has nine places personal data lives. A DSAR that covers seven is not
compliant; it is a partial answer with a compliance label on it. For each sink: **what**, **how to
get it**, **what to redact**, and the **honest limitation**.

### 1.1 MongoDB — the primary copy (25 stores)

The account-deletion cascade in `api/server/controllers/UserController.js` is the authoritative
inventory of everything keyed to a user, because it is what erasure has to reach. Access mirrors
erasure: every store that cascade deletes, this discloses. The collector queries all of them.

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
| `groups` | `memberIds` ∋ id | Group memberships (incl. Okta-synced ones when KK20-198 lands) | Yes |
| `aclentries` | `principalId` | What the subject has been granted access to | Yes |
| `knauf_agent_schedules` (`user`), `knauf_scheduled_agent_runs` (`ownerId`) | — | Scheduled-agent definitions and run history (Knauf-only) | Yes |
| `auditlogs` | `actor.id` **and** `target.id` | See §1.7 — needs Art. 15(4) handling | Yes, redacted |

**Tenant scoping.** Every model is tenant-isolated. The collector runs under `runAsSystem`, the same
privileged frame maintenance scripts and the retention sweep use, so it sees every tenant. If the
subject's tenant is known, pass `--tenant` to narrow it.

### 1.2 Meilisearch — full-text replica

Indexes `messages` and `convos` hold a copy of message text and titles. The **only filterable
attribute is `user`** (`mongoMeili.ts`), which is exactly what a DSAR needs:

```
GET /indexes/messages/search   { "filter": "user = <mongo-id>", "limit": 1000 }
GET /indexes/convos/search     { "filter": "user = <mongo-id>", "limit": 1000 }
```

**What to disclose:** this is a *derived copy* of §1.1 content — disclose that the replica exists and
attest that its counts match Mongo. Do not hand over the same text twice as if it were different
data. **Limitation:** think parts are indexed too (workstream P1-5), so the replica may hold
reasoning text; it is still the same category.

### 1.3 pgvector and 1.4 Azure AI Search — vector stores (via `rag_api`)

Both hold **embedded chunks of the subject's uploaded files**, keyed by `file_id`. Chat-attached
files go to pgvector; agent knowledge files go to Azure AI Search when it is enabled for agents.

**Limitation, stated plainly:** `rag_api` exposes **no read-back-by-subject endpoint**. `/documents`
and `/agent/documents/{file_id}` are *delete* paths; `/query*` needs a query string. You cannot dump
"all vectors for user X". What you can — and must — do:

1. From `files`, list the subject's `file_id`s where `embedded: true`, split by `context`
   (agent files → Azure AI Search, everything else → pgvector).
2. Disclose that embeddings of those files exist in those stores, with the `file_id` list.
3. The **content** they were computed from is the source file in Blob (§1.5) — disclose that.

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
npx langfuse api traces list --user-id <mongo-id> --fields core,io,observations --limit 100 --page 1 --json
# feedback scores (tag only since KK20-327; older scores may carry free text)
npx langfuse api scores list --user-id <mongo-id> --fields score,trace --limit 100 --json
```

Page until empty. **Disclose:** trace payloads are the same conversation content as §1.1, held under
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

### 1.8 winston logs — `api/logs/`

`error-*.log` lines carry `userId` and `requestId` via `requestContextFormat`; debug logs exist only
when `DEBUG_LOGGING=true`. Rotation is **14 days**, so the window is small and closes on its own.

```bash
grep -l "<mongo-id>" ${LIBRECHAT_LOG_DIR:-api/logs}/*.log
grep -h "<mongo-id>" ${LIBRECHAT_LOG_DIR:-api/logs}/*.log > logs.jsonl
```

**Disclose:** error events tied to the user in the last 14 days are personal data. Include them
(the collector does with `--include-logs`). If prod log access is restricted (it should be —
workstream P0-5), the platform team runs this step.

### 1.9 Datadog — **excluded, with the reason written down**

RUM and browser-log forwarding use a **random per-session id**, masked URL paths, and attach **no
user identity** (see `client/src/knauf/analytics/`, and the adobe-analytics-onetrust plan). There is
no key by which Datadog data can be attributed to a named subject, so it is not retrievable *for
this subject* and is excluded — **state that exclusion and its reason in the response.** Two caveats
to keep honest: (1) forwarded `console.error` payloads are unreviewed (workstream P1-2) — until that
review lands, say "we have no means to attribute, and we are reviewing the payloads"; (2)
Datadog-side retention and region are P1-2's open questions.

---

## 2. Collect

```bash
# 1. Summary first — read-only, prints per-sink counts
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email>

# 2. Full bundle
node knauf/scripts/dsar-collect.js --user <mongo-id-or-email> --out ./dsar-<ticket>/ --include-logs
```

The bundle is one JSON file per sink plus `manifest.json` (counts, timestamps, redactions applied,
exclusions and their reasons), `langfuse.sh` (the paged Langfuse commands to run where the CLI has
credentials) and `meilisearch.md` (the two filter queries). The collector **never writes to Mongo**
— it uses `.find().lean()` only, and the spec pins the redactions.

Then run `langfuse.sh` and the Meilisearch queries from a host with the credentials, and pull the
Blob objects for the `files` list. Add their outputs to the bundle.

---

## 3. Review before release

- [ ] **Third-party data** (Art. 15(4)): actor identities redacted on target-rows (§1.7); any other
      person's data inside the subject's messages (colleagues named in prompts) — the subject wrote
      it, it is theirs to receive; do not over-redact the subject's own content.
- [ ] **Secrets stripped** — spot-check `users.json` for `totpSecret`/`backupCodes`/`refreshToken`;
      `keys`/`pluginauths`/`tokens`/`sessions` show existence only.
- [ ] **Derived copies labelled** — Meilisearch and Langfuse presented as copies with their own
      retention, not as new categories.
- [ ] **Exclusions stated** — Datadog (§1.9); vector stores attested by `file_id` (§1.3/1.4).
- [ ] **The Art. 15(1) narrative** written: purposes, categories, recipients (Azure OpenAI, Azure AI
      Search, the hosted search backend, Datadog), retention periods per category (from the
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

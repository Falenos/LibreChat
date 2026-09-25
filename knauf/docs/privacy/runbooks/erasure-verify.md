# Erasure verification — proving an Art. 17 deletion, store by store

**Ticket:** KK20-350 (workstream item **P2-5**) · **Owner:** Eng + DPO · **Status:** written
2026-09-04; reworked 2026-09-24 and 2026-09-25 after the two PR #350 review rounds. **No evidence-grade run is possible yet.**
The environment manifests still hold proposals and open platform facts (§5), and the RAG
verification adapter has to be deployed first (§0). Getting both done, and then running the
first evidence run on staging, is this ticket's remaining acceptance criterion.

Erasure is satisfied only when every copy is gone, or is lawfully somewhere else with a
stated basis. This runbook does not claim how many copies Agentic Karl holds. Each
environment has a **versioned sink manifest**,
[`knauf/docs/privacy/erasure-sinks/<env>.json`](../erasure-sinks/), and in it every store
resolves to exactly one disposition:

| Disposition | Meaning | Resolves the store when |
|---|---|---|
| `deleted` | The product's deletion must empty it | The verifier measured a positive baseline and an exact zero afterwards |
| `eventually-deleted` | It expires by itself (backups, processor retention, TTLs) | A `deadline` and a `basis` are recorded **and approved**; a probed store is still checked against the deadline |
| `retained` | It is kept lawfully (e.g. the audit log, Art. 17(3)) | A `basis` and an `expiry` are recorded **and approved** |
| `externally-controlled` | Another controller or system holds it | The `controller` and the Art. 19 `notification` duty are recorded **and approved** |
| `not-probed` | Nobody can show what happens to it yet | **Never.** It blocks every evidence run until a fact replaces it |

`configured: "unknown"` also blocks. So does `configured: false` when the environment says
otherwise, and so does any probed store the manifest leaves out. The verifier checks the
manifest's `configured` flags against the same environment variables the app reads, so a live
store cannot be declared absent.

> **The clock.** Art. 17(1): erase **without undue delay**. Art. 12(3) applies to the response:
> within one month, extendable by two with notice. Art. 19: tell every recipient the data was
> disclosed to. The manifest's `externally-controlled` entries are where that duty is written down.

---

## 0. Before you start

| Precondition | Why |
|---|---|
| **Staging** for rehearsals, and a dedicated test account (Okta test user) | The recipe deletes the account under test. A prod run happens only for a real request, with the same steps |
| The **manifest for the environment has no preflight blockers** (§5) | An evidence baseline refuses to start otherwise: a run that can never end CLEAN should not cost a deletion first |
| **RAG verification adapter deployed**: an `agentic-karl-rag-api` image with `POST /verification/vectors` and `RAG_VERIFICATION_ENABLED=true` on the RAG service | Without it both vector stores are **NOT PROBED**, never zero (§4.1) |
| The test subject has data in **every mandatory store** the manifest lists: a chat with a **file attachment** (→ pgvector, Blob, Meilisearch), an **agent with a knowledge file** (→ Azure AI Search, asset ledger, ACL entries), a **memory**, a **thumbs-down** (→ Langfuse score), a **shared link**, a **bookmark**, a **project**, a **prompt**, a **skill**, a **code-execution run that writes a file** (→ code-adapter staging), a **translated file** (→ translation jobs), a schedule if the scheduler is on | `before` exits **4 NOT READY** and names every store without a positive baseline, unless the manifest records an **approved**, reason-coded exemption (`FEATURE_DISABLED_IN_ENVIRONMENT`, `NOT_CREATABLE_BY_SUBJECT`, `NOT_SUBJECT_ADDRESSABLE`) |
| `ALLOW_ACCOUNT_DELETION` not `false` on the API | `canDeleteAccount` gates `DELETE /api/user/delete` |
| A shell with the environment's configuration: Mongo, `MEILI_HOST`/`MEILI_MASTER_KEY`, `RAG_API_URL` + `JWT_SECRET`, Azure Blob, `USE_REDIS`/`REDIS_URI`, `LANGFUSE_BASE_URL`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, plus the flags the manifest is checked against (`SEARCH`, `AZURE_SEARCH_ENABLED`, `LOG_TO_FILE`) | The verifier probes each store the way the app reaches it. A missing variable makes that store NOT PROBED, and a flag that contradicts the manifest blocks the run |
| **The same storage for every phase**: the same Mongo hosts and database, Meilisearch endpoint, RAG service and its pgvector/Azure AI Search behind it, Blob account and containers, Redis, and the same Langfuse **project** | Every phase records the non-secret identity of each store (§4.3) and `after` refuses to run against anything else. Deleting in one place and measuring in another would read as CLEAN |
| The subject's **Mongo `users._id` and tenant** (or `none` in a single-tenant deployment) | Evidence runs accept nothing else. Email/OIDC identities are unique only per tenant, and the identity later authorizes the Langfuse deletion |

---

## 1. The deletion paths under test — and the one that is not

The verifier never deletes application data itself. The whole point is to test **what a user
gets**, so deletion runs through the product:

| Path | What it cascades | Where |
|---|---|---|
| **Account:** `DELETE /api/user/delete` (Settings → Delete account) | Mongo stores, sessions, **files via `processDeleteRequest`** (Blob bytes + pgvector `/documents` + Azure AI Search `/agent/documents/{id}`), shared links + ACL grants, scheduler barrier + purge, group membership | `api/server/controllers/UserController.js` `deleteUserController`; route in `api/server/routes/user.js` |
| **One chat:** `DELETE /api/convos` with `arg.conversationId` (the trash icon) | Conversation + messages, **the chat's files** (`deleteConvosWithCleanup`: blobs, rows, embeddings), tool calls, the chat's shared links | `api/server/routes/convos.js` |

Meilisearch is emptied by both because the `mongoMeili` plugin hooks `deleteMany` on
`Conversation`/`Message`. **Langfuse is emptied by neither**, since no application path deletes
traces, so §2 step 4 does it through the public API. **Redis is not cleared either.** Keys
expire by TTL, and `redis:keys` shows which namespaces outlive the deletion.

**`config/delete-user.js` is not erasure-complete and must not be used as the Art. 17 path.** It
raw-`deleteMany`s the Mongo collections and stops. It never calls `processDeleteRequest`, so:

| Copy | Product path | `config/delete-user.js` |
|---|---|---|
| Blob bytes | deleted | **orphaned** (File rows gone, bytes stay) |
| pgvector / Azure AI Search embeddings | deleted | **orphaned** |
| Shared-link ACL grants, agent-file cascade, scheduler purge | deleted | **skipped** |
| Meilisearch | synced via plugin | only if the script's process has `MEILI_*` set, which loads the plugin |

The spec (`knauf/scripts/erasure-verify.spec.js`) pins this: if someone teaches the ops script to
call the cascade, the test fails and this table must be updated. Until then, an admin-driven
deletion is **not** an erasure. A follow-up ticket should either route the script through the
controller's cascade or delete it.

---

## 2. Procedure

```bash
# 1. Baseline, while the subject still exists. Refuses unless the manifest resolves every
#    store (exit 6), and exits 4 NOT READY naming any mandatory store without data.
#    Writes before.json: the verified identity tuple, the inventory the later phases need
#    (physical vector ids, asset ids, authored agent ids, every Blob pointer, Langfuse trace
#    ids), every probe result, the manifest it was taken under and the tool's own sha256.
node knauf/scripts/erasure-verify.js --phase before --env stage \
     --user <users._id> --tenant <tenantId|none> --out ./erasure-<date>/

# 2. Delete ONE conversation through the product first (trash icon on a chat that had a file).
#    Optional but recommended: it exercises the per-chat cascade separately.

# 3. Delete the account through the product: Settings → Data controls → Delete account
#    (or: curl -X DELETE "$API/api/user/delete" -H "Authorization: Bearer <access token>").

# 4. Langfuse, which no product path reaches. Re-confirms the identity tuple, refuses a
#    different Langfuse instance OR project than the baseline probed (rotated keys inside
#    the project are fine), re-lists the subject's traces exactly, refuses a listing that
#    shares no id with the baseline, and deletes those.
node knauf/scripts/erasure-verify.js --phase langfuse-delete --env stage \
     --user <users._id> --tenant <tenantId|none> --out ./erasure-<date>/ --confirm
#    Deletion is ASYNCHRONOUS (Langfuse: "within 15 minutes") and cascades to observations and
#    scores. Do not touch ClickHouse or blob storage directly; that orphans media.

# 5. Re-probe every store with the identifiers from step 1, at least 15 minutes after step 4
#    and within 24 hours of step 1 (an older baseline is STALE), against the same storage
#    (§4.3). Every trace and score id captured at step 1 is also looked up directly.
node knauf/scripts/erasure-verify.js --phase after --env stage --out ./erasure-<date>/
```

Each phase refuses a directory that is a symlink or passes through one, and it re-checks the
baseline's environment, mode and identity. Evidence files are written `0600` and exclusively,
and they are never overwritten: `after-<timestamp>.json`, `report-<timestamp>.md` and
`langfuse-delete-<timestamp>.json`.

**Rehearsal mode.** Use `--mode rehearsal` to exercise the machinery before the manifest is
complete. It accepts an email, username or OIDC id in `--user`, and it refuses an ambiguous
match rather than guessing. It also allows `--skip <mongo,meili,vectors,blob,langfuse,redis,logs>`.
A skipped store is recorded as `skipped`, never left out, and a rehearsal **never** prints
CLEAN. `langfuse-delete` refuses a rehearsal identity.

### Exit codes

| Code | Verdict | Meaning |
|---|---|---|
| 0 | **CLEAN** | Evidence mode, every store resolved, no residual. The only exit 0 |
| 3 | RESIDUALS FOUND | Something the product should have deleted survived. **Stop:** file a defect against the owning module and re-run after the fix |
| 4 | INCOMPLETE / NOT READY | At least one blocker (§3). Nothing is proven either way |
| 5 | NOT EVIDENCE | Rehearsal mode |
| 6 | refused | Preflight blockers in evidence mode, identity/tenant/environment mismatch, ambiguous subject, or tampered baseline |
| 1 / 2 | usage / subject not found | |

---

## 3. Reading the report

`report-<timestamp>.md` binds itself to the run id, the manifest file + revision + sha256, the
identity digest and the tool's sha256. It shows the subject's `_id` and tenant but **not** their
email, which stays in `before.json`. It lists every manifest store:

| Status | Meaning | Blocks CLEAN? |
|---|---|---|
| `DELETED` | Positive baseline, exact zero after | no |
| `N/A — <CODE> (approved)` | Zero before and after, with an approved exemption | no |
| `RETAINED — <basis>; expiry <x>` | Approved retention, count shown | no |
| `EVENTUALLY DELETED — …` | Approved deadline not yet passed, or approved lifecycle classes such as soft-deleted blobs; listed under *Obligations* | no |
| `EXTERNALLY CONTROLLED — <controller>` | Approved; the notification duty is listed under *Obligations* | no |
| `NOT CONFIGURED` | Absent in this environment, and the environment agrees | no |
| `RESIDUAL` | Data survived where it should not, or survived past its deadline | **yes, exit 3** |
| `NO BASELINE` | Before count was 0: the probe never showed it can see this data | **yes** |
| `NOT PROBED — …` | Skipped, absent, unreachable, erroring, inexact, adapter missing, or declared not-probed | **yes** |
| `PENDING — …` | Langfuse inside its 15-minute settle window; re-run after the time shown | **yes** |
| `UNKNOWN — …` | Not in the manifest, `configured: "unknown"`, drift, or a disposition still awaiting approval | **yes** |

Run-level blockers: a baseline older than 24 h, an `after` snapshot from another run, an
environment flag that changed between phases, a store whose physical identity changed between
phases (§4.3), a Langfuse deletion record for another run, identity or project, a
non-evidence-grade identity. The inventory can also prove a store exists that the
manifest omits, for example a File row pointing at local disk or at the code-execution
environment. Each such store needs its own `files:<store>` entry.

---

## 4. How each store is measured

| Store | Probe | Exact because |
|---|---|---|
| Mongo, 33 model stores + `users` + 3 raw collections + `auditlogs` | `countDocuments` with the DSAR collector's `sinkFilter` (group membership by `idOnTheSource`, the email-keyed allowlist, `principalType: 'user'`, assets by the subject's own asset ids), pinned to the subject's tenant | the same filters Art. 15 disclosure uses |
| Meilisearch `messages`, `convos` | `filter user = "<id>"` with `page`/`hitsPerPage` | `totalHits` is exhaustive; `estimatedTotalHits` is refused |
| pgvector, Azure AI Search | `POST /verification/vectors` on the RAG service (§4.1) | filter-only scans, no ranking |
| Blob (primary container) | `listBlobsFlat` over every `{images,uploads,avatars,documents,files}/<userId>/` prefix, paged, **including versions, snapshots and soft-deleted objects**, then reconciled against every Mongo pointer | enumerated from storage, so an object no row points at is still found |
| Langfuse traces, scores | `GET /api/public/projects` binds the credentials to one project; `GET /api/public/{traces,scores}?userId=`, paged to `meta.totalPages`; at `after`, `GET /api/public/{traces,scores}/{id}` for every id captured at baseline (§4.4) | the collected ids must equal `meta.totalItems`; a baseline id answers 404 (gone) or 200 (present), anything else is not an answer |
| Redis | `SCAN MATCH *<id>*` (standalone) | exact for keys that embed the id; entries keyed by session/token ids are `redis:opaque` |
| Log files | grep of `*.log`/`*.log.gz` | only where `LOG_TO_FILE` is on; AGK ships stdout to the log platform instead (`logs:platform`) |
| Code-adapter staging (`files:execute_code`) | `listBlobsFlat` over `<sessionId>/` in the container the manifest names (`code-adapter-staging` on stage, `code-adapter-prod` on prod), for every session the subject's File rows referenced through `metadata.codeEnvRef` at baseline, all lifecycle classes | enumerated from storage by session; the adapter's reaper is what removes them (`FILE_TTL_HOURS`, 24 h sliding), so the manifest disposition is *eventually deleted* |
| Translation scratch (`translation:scratch`) | `listBlobsFlat` over `translation-source` and `translation-target`; count **current** objects older than the manifest's `lifecycleWindow` (`P1D`) | scratch is `<uuid>/<name>` with the uuid never persisted, so it cannot be found per subject; the probe measures the store's own guarantee instead. Any overdue object means the lifecycle rule is not enforcing, and the store is a residual for every subject |

### 4.1 Vectors: why the semantic probe was replaced

The first version asked `/query_multiple` and `/agent/query-multiple`, the **search** routes,
whether the deleted files still had chunks. A surviving chunk that ranks outside `k`, or beyond
the distance threshold, comes back as nothing, and nothing read as "erased". The
`agentic-karl-rag-api` adapter answers the existence question instead. It is read-only and
returns identifiers and counts only. It is off unless `RAG_VERIFICATION_ENABLED=true`, and a
request that fails, is disabled or is inexact is **NOT PROBED**.

- **`asset_id`** matches exactly the rows `delete_generation(asset_id, None)` removes: the asset
  id, or legacy rows with no `asset_id` and `file_id` equal to it. The probe looks exactly where
  the delete looks.
- **`user_id`** catches chat-file chunks no File row points at any more.
- **`entity_id`** (Azure AI Search) covers the subject's authored agents. Agent-knowledge chunks
  carry the **agent id** in `user_id`/`entity_id`, never the uploader's, so a subject-only scan
  would miss them.
- Every page must be exact, the total must not move between pages, and the groups must sum to
  the total. Vector metadata carries no tenant: the verifier resolves identifiers inside the
  tenant first, and the ids are globally unique.

### 4.2 Blob lifecycle classes

A current object or a snapshot after deletion is always a **residual**. Soft-deleted copies (and
old versions, if versioning is on) resolve as `EVENTUALLY DELETED` only under an **approved**
`eventualClasses` policy on `blob:primary`, and only inside its window. The window is counted
from the baseline, so the deadline errs early. Any Mongo pointer outside the canonical layout
makes the store NOT PROBED, because objects under an unknown layout cannot be enumerated.
Expect the storage-side scan to surface objects the cascade never touched. **Avatars have no
File row**, so a `images/<userId>/avatar-*` object that outlives the account deletion is a real
residual.

---

### 4.3 Storage identity

`envSignals` only said whether a store was configured. Pointing `MEILI_HOST` at an empty
instance between phases left the original untouched and read as CLEAN. Now every phase records
the **non-secret physical identity** of each store: Mongo hosts and database, the Meilisearch
endpoint, the RAG service URL plus what the adapter reports as its storage (pgvector host,
database, schema and collection, or the Azure AI Search endpoint and index), the Blob account
and each container URL, the Redis host and database, the Langfuse base URL and **project id**.
Credentials and SAS tokens are stripped before anything is written. `after` refuses to start
against different storage; the identities the probes learn are compared in the verdict and any
change is a blocker. The report's *Storage* line lists what was bound.

### 4.4 Langfuse: project binding and direct lookups

The Langfuse leg used to be bound to the host only. Credentials for another project on the same
host, for example a cloned environment, would have passed the guard and deleted that project's
traces for the same Mongo id. The baseline now resolves the credentials to exactly one project
(`GET /api/public/projects`) and records its id; `langfuse-delete` and `after` must resolve to
the same id. Rotating keys inside the project changes nothing; a different project is refused.

Scores are listed by `userId` through a join to the parent trace. Once the trace is deleted, a
score that failed to cascade disappears from the list and from `totalItems`, so paging would
reconcile to zero. The baseline therefore captures trace **and score ids**, and `after` looks
each one up directly (`GET /api/public/{traces,scores}/{id}`), which needs no parent. A score
that answers 200 is counted, and after the settle window it is a RESIDUAL to file against
Langfuse with its id.

## 5. What must be resolved before the first evidence run

`before --mode evidence` prints this list and refuses while it is non-empty. As shipped
(revision `2026-09-25.1`) both `stage.json` and `prod.json` carry 26 preflight blockers of four
kinds:

| Kind | Entries | Who resolves it |
|---|---|---|
| Proposed, awaiting approval | `mongo:auditlogs` (retained), `processor:azureOpenAI` (P30D), `processor:documentIntelligence` (P1D), `idp:entra` (externally controlled), `blob:primary` soft-delete window (P7D proposed), `files:execute_code` and `code:table` (eventually deleted by the code-adapter reaper, P1D proposed), `translation:scratch` (`NOT_SUBJECT_ADDRESSABLE`, measured against the one-day lifecycle rule), and baseline exemptions for `Balance`, `Preset`, `Assistant`, `Config`, `SystemGrant`, `MigrationAllowlist`, `SkillSyncCredential` | DPO + Eng. Check the stated fact, then fill `approvedBy`/`approvedAt` in a reviewed PR |
| Langfuse secondary stores | `langfuse:eventStorage` (`events/`), `langfuse:mediaStorage` (`media/`), `langfuse:batchExports` (`exports/`, enabled) | Platform: does trace deletion remove the raw events and media? What is the lifecycle of exports? |
| Backups | `langfuse:clickhouseBackups`, `backup:mongo`, `backup:blob`, `backup:pgvector`, `backup:meilisearch` | Platform: existence, retention, and a **no-restore-without-re-erasure** rule |
| Other not-probed stores | `redis:opaque` (TTLs), `logs:platform` (Datadog retention; also carries the erased email, P0-4), `apm:datadog` | Eng / Platform |

When a fact arrives, replace the entry with the matching disposition, cite its source in the
entry, and bump `revision`. A run is always judged against the manifest embedded in its own
`before.json`. A later change is noted in the report and never applied retroactively.

---

## 6. Filing the evidence

1. Attach `report-*.md`, `before.json`, `after-*.json` and `langfuse-delete-*.json` to the ticket,
   or, for a real request, to the DSAR register entry (DSAR runbook §6). `before.json` holds the
   subject's identifiers. Keep it under the register's access and retention rules, not in a
   chat thread.
2. Record the elapsed time from the delete click to a CLEAN report. That number is the answer to
   "how long does erasure take" in the Art. 30 record.
3. Work through the report's *Obligations* list: externally-controlled hand-offs, and the dates
   by which eventually-deleted copies must be gone.
4. **Re-run after P2-2** (conversation retention) lands, and after any upstream sync that touches
   `UserController.js`, `convos.js`, `process.js` or the `mongoMeili` plugin (P1-3 checklist).

---

## 7. Required before production rollout

Not built in this PR. Recorded so a CLEAN report is not mistaken for an operated compliance
control:

- Run verification as an **approved, environment-scoped compliance Job** (GitOps owns execution
  and network placement) with **read-only per-store identities**. Keep the Langfuse deletion
  under a **separate privileged identity and approval path**. Today one operator shell holds
  both, and the RAG adapter trusts any holder of `JWT_SECRET`.
- Each data-owning service exposes an exact, read-only verification adapter. RAG has one now;
  Langfuse secondary storage, Redis beyond key-addressable entries, and the log platform do not.
- Infrastructure owns private connectivity, **protected evidence storage** with retention, and
  **tested backup restore-and-re-erasure** procedures.
- Bounded **eventual-consistency polling** (Langfuse, Meilisearch) instead of a manual re-run.
- Evidence manifests signed or stored write-once, carrying component versions and timestamps.
  Today they carry sha256 digests of the tool and the manifest, not a signature.

---

## Rehearsal and acceptance

- [ ] RAG adapter deployed with `RAG_VERIFICATION_ENABLED=true` on staging
- [ ] `--mode rehearsal` run on staging end to end (machinery exercised; not evidence)
- [ ] `stage.json` preflight clean: approvals in, platform facts recorded
- [ ] Seeded test subject: `before` exits 0 (every mandatory store has a baseline)
- [ ] One chat deleted via the product; account deleted via the product
- [ ] Langfuse leg run; `after` ≥15 min later, within 24 h of the baseline
- [ ] Report verdict **CLEAN**; elapsed time recorded; obligations worked through
- [ ] Any `RESIDUAL` filed as a defect against the owning module, with the report attached

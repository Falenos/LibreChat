# Erasure verification — proving an Art. 17 deletion reached every sink

**Ticket:** KK20-TBD (workstream item **P2-5**) · **Owner:** Eng + DPO · **Status:** written
2026-09-04, **not yet run green** — the first staging run against a seeded test subject, with the
report filed, is this ticket's remaining acceptance criterion.

The right to erasure is only satisfied if the deletion reaches **every copy**. Agentic Karl holds
nine (workstream §1), and the product's deletion cascade was written store by store over many
tickets. Nobody has ever proved, end to end, that one delete click empties all nine. This runbook
produces that proof, repeatably, and files it as the standing erasure evidence.

> **The clock.** Art. 17(1): erase **without undue delay**. Art. 12(3) applies to the response:
> within one month, extendable by two with notice. Art. 19: tell every recipient the data was
> disclosed to — for KARL, that is nobody external (Azure processes under the DPA; Datadog holds no
> identity), so the notification duty is discharged by writing that down.

---

## 0. Before you start

| Precondition | Why |
|---|---|
| **Staging**, never prod. A dedicated test account (Okta test user) | The recipe deletes the account under test. Prod runs happen only for a real request, with the same steps |
| The test subject has data in **every** sink: a chat with a **file attachment** (→ pgvector), an **agent with a knowledge file** (→ Azure AI Search), a **memory** written, a **thumbs-down** given (→ Langfuse score), a **shared link**, a schedule if the scheduler is enabled | A sink that was empty before deletion proves nothing. The `before` snapshot will show which sinks are still `0` — seed them first |
| `ALLOW_ACCOUNT_DELETION` not set to `false` on the staging API | `canDeleteAccount` gates `DELETE /api/user/delete`; the default is `true` |
| A shell with the staging `.env` (Mongo, `MEILI_HOST`/`MEILI_MASTER_KEY`, `RAG_API_URL`, `JWT_SECRET`, Azure Blob, `LANGFUSE_BASE_URL`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`) | The verifier probes each sink the way the app does — same JWT for `rag_api`, same Blob client, same Langfuse project keys |
| The subject's Mongo `users._id` | Every other sink is keyed by it: Langfuse `userId`, Meilisearch `user`, `auditlogs` `actor.id`/`target.id` |

---

## 1. The deletion paths under test — and the one that is not

The verifier never deletes application data itself. The whole point is to test **what a user
gets**, so deletion runs through the product:

| Path | What it cascades | Where |
|---|---|---|
| **Account:** `DELETE /api/user/delete` (Settings → Delete account) | 25 Mongo stores, sessions, **files via `processDeleteRequest`** (Blob bytes + pgvector `/documents` + Azure AI Search `/agent/documents/{id}`), shared links + ACL grants, scheduler barrier + purge, group membership | `api/server/controllers/UserController.js` `deleteUserController`; route in `api/server/routes/user.js` |
| **One chat:** `DELETE /api/convos` with `arg.conversationId` (the trash icon) | Conversation + messages, **the chat's files** (`deleteConvosWithCleanup` — blobs, rows, embeddings), tool calls, the chat's shared links | `api/server/routes/convos.js` |

Meilisearch is emptied by both because the `mongoMeili` plugin hooks `deleteMany` on
`Conversation`/`Message`. **Langfuse is emptied by neither** — no application path deletes traces —
so §2 step 4 does it through the public API.

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
deletion is **not** an erasure — a follow-up ticket should either route the script through the
controller's cascade or delete it.

---

## 2. Procedure

```bash
# 1. Snapshot every sink while the subject still exists. Captures the file ids, blob paths,
#    agent ids and Langfuse trace ids the `after` phase needs — the user document will be gone.
node knauf/scripts/erasure-verify.js --phase before --user <email-or-id> --out ./erasure-<date>/

# 2. Delete ONE conversation through the product first (trash icon on a chat that had a file).
#    Optional but recommended: it exercises the per-chat cascade separately.

# 3. Delete the account through the product: Settings → Data controls → Delete account
#    (or: curl -X DELETE "$API/api/user/delete" -H "Authorization: Bearer <access token>").

# 4. Langfuse — no product path reaches it. Delete the traces captured in step 1:
node knauf/scripts/erasure-verify.js --phase langfuse-delete --out ./erasure-<date>/ --confirm
#    Deletion is ASYNCHRONOUS (Langfuse: "within 15 minutes") and cascades to observations and
#    scores. Wait, then continue. Do not touch ClickHouse or MinIO directly — that orphans media.

# 5. Re-probe every sink with the ids from step 1.
node knauf/scripts/erasure-verify.js --phase after --out ./erasure-<date>/
#    Exit code 0 = CLEAN, 3 = residuals. `report.md` is the evidence.
```

Flags: `--tenant <id>` runs the Mongo reads in a tenant scope; `--skip meili,rag,blob,langfuse`
when a sink is not configured in the environment (it is then reported as **NOT PROBED**, never as
clean); `--rag-query "<text>"` sets the query used to probe the vector stores (default `the`).

---

## 3. Reading the report

`report.md` lists every sink with before/after counts and one of four statuses:

| Status | Meaning | Action |
|---|---|---|
| `clean` | before > 0, after = 0 | none |
| `RESIDUAL` | something the cascade should have deleted survived | **Stop.** This is a defect in the deletion path, not in the recipe. File it against the owning module and re-run after the fix |
| `retained by design — …` | a copy the position in workstream §3.4 / P2-7 says to keep, with the basis printed | verify the basis still holds; no action |
| `NOT PROBED — …` | the sink could not be reached (env unset, HTTP error, no `entity_id` for Azure) | fix the environment and re-run. A run with unprobed sinks is **not** evidence |

A sink whose **before** count was already `0` is not evidence either — seed it (§0) and start over.

---

## 4. What legitimately survives, and what to do about it

| Copy | Survives? | Basis / action |
|---|---|---|
| **`auditlogs`** rows naming the subject as actor or target | Yes, by design | Art. 17(3)(b)/(e) — tamper-evident audit trail, retained under the P2-7 position and purged by the KK20-328 sweep at 12 months. The hash chain forbids row-level deletion; that is the point of it |
| **winston logs** (`api/logs/`, 14-day rotation) | Yes, for ≤14 days | `deleteUserController` itself logs `User deleted account. Email: <email> ID: <id>` at **info** — prod's `warn` root level suppresses it, dev/stage do not. Check with `grep -r "<id>" api/logs/`. Candidate for P0-4's identity-minimisation pass |
| **Datadog** browser logs | Not attributable | random per-session id, no user identity — excluded with the reason written down (DSAR runbook §1.9) |
| **Langfuse** traces/scores | Only until step 4 settles | asynchronous; if `after` still shows traces >15 min later, the delete was rejected — check `langfuse-delete.json` and the Langfuse project keys |
| **Backups** | Yes, until rotation | Cosmos/Blob/ClickHouse backup retention is a platform fact to record in P0-2/P0-5; erasure from backups is satisfied by rotation plus a documented no-restore-without-re-erasure rule |

---

## 5. Filing the evidence

1. Attach `report.md`, `before.json`, `after.json` (and `langfuse-delete.json`) to the ticket or,
   for a real request, to the DSAR register entry (DSAR runbook §6).
2. Record the elapsed time from the delete click to a CLEAN report — that number is the answer to
   "how long does erasure take" in the Art. 30 record.
3. **Re-run after P2-2** (conversation retention) lands, and after any upstream sync that touches
   `UserController.js`, `convos.js`, `process.js` or the `mongoMeili` plugin (P1-3 checklist).

---

## Rehearsal (the remaining AC)

- [ ] Seeded test subject on staging with data in all nine sinks (`before` shows no zeros except
      `auditlogs` if the subject never touched admin surfaces)
- [ ] One chat deleted via the product; account deleted via the product
- [ ] Langfuse leg run; `after` re-run after ≥15 min
- [ ] `report.md` verdict **CLEAN**; elapsed time recorded
- [ ] Any `RESIDUAL` filed as a defect against the owning module, with this report attached

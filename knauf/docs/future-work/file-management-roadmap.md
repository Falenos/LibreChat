# File management & governance — future-work roadmap

**Status:** backlog (not scheduled). **Owner:** Karl platform. **Related shipped work:** KK20-190 (chat File Search uploads — allow-list, per-category size limits, encrypted-file rejection, top-k context).

KK20-190 controls **what** gets uploaded. It does **not** address the **lifecycle** of a file once stored — deduplication, cleanup when a chat is deleted, retention, or the security controls an enterprise deployment is expected to have. This doc captures the verified current state and a set of ready-to-file Jira ticket drafts so the work can be scheduled in priority order.

> These are drafts. Numbers are placeholders (`KK20-XXX`) until the tickets are filed. Each ticket carries its own test plan when it's picked up.

---

## Current state (verified against the code)

| Area                       | State today                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deduplication**          | ❌ None. Every upload gets a fresh random UUID `file_id`; no content hash on the File schema; `createFile` upserts by `file_id` only. The same PDF uploaded to 5 chats → **5 blobs + 5 pgvector embeddings + 5 Mongo rows**.                                                                                | [multer.js:23](../../../api/server/routes/files/multer.js#L23), [file.ts schema](../../../packages/data-schemas/src/schema/file.ts)                                                                                          |
| **Cleanup on chat delete** | ❌ No cascade. Deleting a conversation removes the convo + messages only — its files/blobs/vectors are orphaned. Chat File Search files carry **no `conversationId`** (written `context:'agents'`, linked only to the ephemeral agent_id).                                                                  | [conversation.ts:454](../../../packages/data-schemas/src/methods/conversation.ts#L454), [convos.js:129](../../../api/server/routes/convos.js#L129), [process.js:716-731](../../../api/server/services/Files/process.js#L716) |
| **Explicit file delete**   | ✅ Works — Mongo + blob + pgvector + agent-refs, via `processDeleteRequest`. Reuse this for cascade/sweep. ⚠️ pgvector delete is best-effort (warns but doesn't block on non-404 errors).                                                                                                                   | [process.js:125](../../../api/server/services/Files/process.js#L125), [VectorDB/crud.js:44](../../../api/server/services/Files/VectorDB/crud.js#L44)                                                                         |
| **Retention / TTL**        | ❌ None for real files. TTL exists only for temp chats (`expiredAt`, 30d default) and the 1h temp-upload cache (`file.expiresAt`). **No scheduler** (no cron/agenda/node-cron anywhere). Only a manual orphan script that de-references agent file_id stubs — it does **not** delete records/blobs/vectors. | [convo.ts:47](../../../packages/data-schemas/src/schema/convo.ts#L47), [config/migrate-orphaned-agent-files.js](../../../config/migrate-orphaned-agent-files.js)                                                             |

### Security controls — gap matrix

| Control                                  | Present? | Evidence / note                                                                                                                        |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Upload rate limiting                     | ✅       | [uploadLimiters.js](../../../api/server/middleware/limiters/uploadLimiters.js) — `FILE_UPLOAD_IP_MAX` / `FILE_UPLOAD_USER_MAX`         |
| Signed/expiring download URLs (Azure)    | ✅       | 5-min SAS, KK20-167 ([Azure/crud.js](../../../api/server/services/Files/Azure/crud.js)). Local strategy serves permanent URLs — see S7 |
| Download access control                  | ✅       | [fileAccess.js](../../../api/server/middleware/accessResources/fileAccess.js) — owner + agent-ACL check                                |
| Filename sanitization                    | ✅       | `sanitizeFilename` across upload flows                                                                                                 |
| Malware / virus scanning                 | ❌       | none — **S1**                                                                                                                          |
| MIME-spoof rejection (sniff vs declared) | ⚠️ partial | Encrypted PDF/OOXML **are** byte-sniffed + rejected on all endpoints (`detectEncryptedFileAtPath`, KK20-190); general content-vs-declared MIME sniffing still missing — `filterFile` trusts `req.file.mimetype` — **S2** |
| Per-user storage quota                   | ❌       | Balance tracks token credits only — **S3**                                                                                             |
| Audit-grade logging                      | ❌       | debug/error logs only, not a structured immutable trail — **S4**                                                                       |
| App-level encryption at rest             | ❌       | relies on storage-layer encryption — **S5**                                                                                            |
| DLP / PII detection                      | ❌       | none — **S6**                                                                                                                          |

---

## Lifecycle & cost tickets

### T1 · File deduplication (content-hash, per-user)

**Priority:** HIGH (largest recurring cost driver) · **Complexity:** HIGH

**Problem.** No content hash → identical re-uploads duplicate the blob, the embedding, and the Mongo row. Cost scales linearly with re-uploads of the same document across chats.

**Approach.**

- SHA-256 the buffer at upload ([multer.js:23](../../../api/server/routes/files/multer.js#L23)); add an indexed, Knauf-namespaced `contentHash` to the File schema ([file.ts](../../../packages/data-schemas/src/schema/file.ts)) with a `(user, contentHash)` index.
- In `processFileUpload` / `processAgentFileUpload` ([process.js](../../../api/server/services/Files/process.js)) look up `{user, contentHash}` **before** the storage upload; on a hit, reuse the existing blob/`filepath` and **skip re-embedding** (point the new logical file at the existing vectors).
- **Scope per-user.** Cross-user dedup leaks the existence of content between users (privacy risk); per-tenant dedup is a later optimization, not the default.

**Deletion interaction (critical).** A shared blob needs **reference counting** (extend the existing `usage` field or add `refCount`) — never delete the blob/vectors until the last reference is gone. **T1 must land with or before T2/T3**, or cascade/sweep will delete blobs still referenced by other chats.

**Open ADR (pgvector).** `rag_api` partitions embeddings by `file_id` / `entity_id`. Reusing vectors across ephemeral agents requires either reusing the same `file_id` under a new `entity_id`, or content-dedup on the RAG side. Decide during implementation.

**Key files.** `multer.js`, `process.js` (both upload fns + `processDeleteRequest`), `file.ts` schema + `methods/file.ts`, `VectorDB/crud.js`.

### T2 · Cascade file + embedding cleanup on chat deletion

**Priority:** HIGH · **Complexity:** MEDIUM

**Problem.** Deleting a chat orphans its blobs + pgvector vectors. This also closes the ephemeral File Search leak that KK20-190 widened (chat-scoped RAG files never get cleaned up).

**Prerequisite.** Populate `conversationId` on chat File Search file records at upload ([process.js fileInfo ~716](../../../api/server/services/Files/process.js#L716)) — the field exists on the schema, it's just unset on this path. Confirm `conversationId` is available in the request at upload time.

**Approach.** In `deleteConvos` ([conversation.ts:454](../../../packages/data-schemas/src/methods/conversation.ts#L454)) or the convos route ([convos.js:129](../../../api/server/routes/convos.js#L129)), after deleting the convo + messages, find `File`s by `{conversationId}` and run the existing **`processDeleteRequest`** ([process.js:125](../../../api/server/services/Files/process.js#L125)) — reuse, don't reinvent. Respect T1 ref-counts (delete blob/vectors only at refCount 0). Harden the best-effort pgvector delete (retry/queue) so vectors don't leak silently.

**Key files.** `convos.js`, `conversation.ts`, `process.js` (reuse `processDeleteRequest`), `file.ts` (conversationId on File Search uploads).

### T3 · 90-day last-use retention sweep + orphan purge

**Priority:** HIGH · **Complexity:** MEDIUM-HIGH (introduces scheduler infra)

**Problem.** Files persist forever; orphans accumulate; there is no time-based cleanup and no scheduled-job infrastructure at all.

**Approach.**

- Define **last use** = `max(file.updatedAt, latest message referencing file_id)`; add `lastUsedAt` (or bump it on each usage update) + an index.
- Purge routine: find files where `lastUsedAt < now − RETENTION_DAYS` **or** orphaned (no convo/message/agent reference) → run `processDeleteRequest`. Window configurable via `FILE_RETENTION_DAYS=90`.
- Extend the manual orphan script to actually delete records + blobs + vectors (today it only de-references agent stubs).

**Scheduler — decision deferred (document both in the ticket):**

- **(A) k8s CronJob → protected admin purge endpoint.** Idiomatic for the ArgoCD/k8s deploy (agk-deployment-configs), single-run, observable in cluster logs, no new in-process dependency. _Leaning A._
- **(B) in-process `node-cron`.** Simplest to ship, but fires **once per replica** under HPA (double-run risk) and couples cleanup to API uptime.

**Key files.** New admin route or cron service under `api/server/`, `process.js` (reuse `processDeleteRequest`), `file.ts` (`lastUsedAt` + index), `config/migrate-orphaned-agent-files.js` (extend), + a CronJob manifest in the deployment repo if (A).

---

## Security hardening tickets

### S1 · Malware / virus scanning

**Priority:** HIGH. Scan the buffer **before** the DB commit and **before** embedding; reject or quarantine infected files. Options: ClamAV (`clamd` sidecar in k8s) or Azure Defender for Storage. **Files:** `process.js` (both upload fns), new scan service.

### S2 · MIME-spoof rejection (magic-byte sniffing)

**Priority:** HIGH. `filterFile` trusts the client-declared `req.file.mimetype`. Sniff magic bytes (`file-type`, already a dependency) and reject when the sniffed type ≠ declared / not on the allow-list. Directly extends KK20-190. **Files:** `process.js` `filterFile`, `api/server/utils/files.js`.

### S3 · Per-user storage quota

**Priority:** MEDIUM. No aggregate cap exists (Balance tracks token credits only). Aggregate `sum(File.bytes)` + file count per user; enforce in `filterFile` / upload; env-configurable cap; surface a localized error. **Files:** new quota check, `process.js`, `methods/file.ts`.

### S4 · Audit-grade file logging

**Priority:** HIGH (compliance — SOC 2 / ISO 27001 / GDPR). Today only debug/error logs. Emit structured, immutable events for upload/download/delete/share keyed on `{file_id, user, ts, action}` to a separate sink. Good candidate for a **Tier-3 sidecar** per the customization ladder. **Files:** files routes, `process.js`, new audit logger.

### S5 · App-level encryption at rest

**Priority:** MEDIUM (compliance / BYOK). Today relies entirely on storage-layer encryption. Add optional AES-GCM with an org/user-scoped KEK for key isolation, wrapping the fileStrategy upload/download. **Files:** Local/Azure/S3 crud strategies.

### S6 · DLP / PII detection & redaction

**Priority:** MEDIUM-LOW. Scan extracted text at ingest (Azure AI Language PII detection / Microsoft Presidio); flag or redact before embedding. **Files:** `process.js` text-extraction path, RAG ingest.

### S7 · Consistent signed/expiring download URLs

**Priority:** LOW (prod is Azure). The local strategy serves permanent unsigned URLs while Azure uses 5-min SAS; align them. **Files:** `Local/crud.js` `getFileURL`.

---

## Suggested sequencing

```
T1 (or its ref-count primitive) ──▶ T2 ──▶ T3        (lifecycle: share processDeleteRequest + ref-counting; coordinate)

S2 ─┐
S1 ─┼─ independent, parallelizable                    (security)
S4 ─┘
S3 · S5 · S6 · S7 — schedule by compliance need
```

T1↔T2↔T3 all touch `processDeleteRequest` and the ref-counting model, so they must be coordinated. The security tickets are independent of the lifecycle chain and can proceed in parallel.

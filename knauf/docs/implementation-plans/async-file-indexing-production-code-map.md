# Production async File Search indexing — agentic-karl code map (KK20-195)

> **Status: implementation companion to the accepted plan. Subordinate document.**
>
> The architecture, invariants, state machine, work packages, test matrix, and blocking decisions are
> defined by [async-file-indexing-production.md](async-file-indexing-production.md) — **that plan is
> the source of truth**; nothing here overrides it. This document maps each work package onto the
> `agentic-karl` codebase: the exact files, functions, schemas, endpoints, and reusable utilities, so
> WP tickets can be cut and executed without re-deriving the code archaeology. Where a WP lives in
> another repository (WP1 → `agentic-karl-rag-api`, WP6 → `agk-deployment-configs`), only the
> interface this repo consumes is pinned here.
>
> **Code-reference baseline: `main`** (post-v0.8.6). All anchors below were verified by direct
> inspection on main; three additional findings from that verification that the accepted plan should
> be aware of are listed in [§9 Discoveries](#9-discoveries-to-confirm-with-the-architect).
>
> **Prerequisites:** the plan's §17 blocking decisions gate specific WPs (mapped in
> [§10](#10-blocking-decision-gates)). Tickets can be drafted now; WP1–WP4 must carry their gates as
> blocking acceptance criteria.

---

## 1. Repo & tier map

| WP | Repo | Tier(s) in agentic-karl |
|---|---|---|
| WP0 containment | agentic-karl (+ a rag_api slice, external) | 4c seams (`crud.js`, client hooks) + metrics + Tier-3 config module |
| WP1 generation-safe RAG | **agentic-karl-rag-api (external)** | interface-only here (`crud.js` / `fileSearch.js` carry generation fields) |
| WP2 `FileAsset` + migration | agentic-karl | Tier-3 net-new model + Tier-3 migration + one 4c seam in `file.ts` |
| WP3 API lifecycle | agentic-karl | 4c seams (`process.js`, `files.js`, `multer.js`, `fileSearch.js`) + Tier-3 routes/services |
| WP4 dedicated worker | agentic-karl + **agk-deployment-configs (external)** | Tier-3 net-new (worker entry, claim loop, reconciler) |
| WP5 client UX | agentic-karl | 4c client seams + Tier-3 knauf client code + i18n |
| WP6 ops/rollout | **external** + in-repo `infrastructure/{dev,prod}/values.yaml` flags | — |

Every 4c edit is `[knauf]`-fenced with a SEAMS.md row (see `fork-management` / `seam-manifest`).

**Seam-size recommendation:** restructuring `processAgentFileUpload`'s file_search branch inside 4c
fences is merge-conflict-heavy on upstream syncs. Prefer extracting that branch into a net-new
`api/server/services/Files/knauf/` module (e.g. `fileSearchUpload.js`) invoked through one thin seam,
so the upstream function keeps its shape.

---

## 2. Reuse map (all anchors verified on main)

| Need | Reuse | Location |
|---|---|---|
| Claim-loop shape + per-file `req.user` builder | `startExpiredFileSweep` / `createExpiredFileSweepRequest` | [sweep.ts:259-289](../../../packages/api/src/files/sweep.ts#L259), [:151-183](../../../packages/api/src/files/sweep.ts#L151) |
| Graceful shutdown (worker-safe, non-listening server OK) | `registerShutdownTask` / `setupGracefulShutdown` | [shutdown.ts:25,38,92](../../../packages/api/src/app/shutdown.ts#L25) |
| System/tenant context for background work | `runAsSystem(async fn)` | [tenantContext.ts:39](../../../packages/data-schemas/src/config/tenantContext.ts#L39) |
| Atomic reservation / upsert + duplicate-key fallback | `upsertConfig` (`findOneAndUpdate` + E11000 retry) | [config.ts:145-200](../../../packages/data-schemas/src/methods/config.ts#L145) |
| Model authoring (schema → types → model → methods + barrels) | `File` as full template; `migrationAllowlist` as minimal `[knauf]` net-new example | `packages/data-schemas/src/{schema,types,models,methods}/` |
| Partial/unique index declaration | `file.index({...}, { unique, partialFilterExpression })` | [file.ts:194-205](../../../packages/data-schemas/src/schema/file.ts#L194) |
| Content hash + dedup lookup | `computeContentHash`, `findAssetForHash` | [contentDedup.js:21-29,45-63](../../../api/server/services/Files/knauf/contentDedup.js#L21) |
| Refcount GC / last-reference delete | `gcDedupRows`, `gcCanonicalAsset`, `deleteFilesWithDedupAwareness` | [cascadeDeleteConvoFiles.js:296-366,238-269,501-515](../../../api/server/services/Files/knauf/cascadeDeleteConvoFiles.js#L296) |
| **Blob re-materialization (worker)** | `getStrategyFunctions(source).getDownloadStream` — stream by stable key; never the stored SAS URL | [strategies.js:91-265](../../../api/server/services/Files/strategies.js#L91) (Azure `:157`) |
| RAG calls + worker→RAG auth | `uploadVectors`, `deleteVectorsByIds`, `generateShortLivedToken(user_id)` | [crud.js:185,72](../../../api/server/services/Files/VectorDB/crud.js#L185), [jwt.ts:9](../../../packages/api/src/crypto/jwt.ts#L9) |
| **Body-level failure guard (already exists)** | `uploadVectors` throws on `known_type===false` and on `!responseData.status` | [crud.js:227-233](../../../api/server/services/Files/VectorDB/crud.js#L227) |
| **Admission-control landing zone** | `createFileLimiters` → `fileUploadIpLimiter`/`fileUploadUserLimiter` | [uploadLimiters.js:55-84](../../../api/server/middleware/limiters/uploadLimiters.js#L55), wired [routes/files/index.js:35-44](../../../api/server/routes/files/index.js#L35) |
| Metrics recorder pattern | module-level no-op recorders wired inside `createMetrics()` (template: `generation_jobs_*`) | [metrics.ts:186-240,494-536](../../../packages/api/src/app/metrics.ts#L186) |
| Retry/backoff (jitter; `write conflict` retried) | `retryWithBackoff` | [retry.ts:27](../../../packages/data-schemas/src/utils/retry.ts#L27) |
| Config flags | `isEnabled`, `math`, validate-at-boot template | [common.ts:20](../../../packages/api/src/utils/common.ts#L20), [math.ts:19](../../../packages/api/src/utils/math.ts#L19), [cacheConfig.ts](../../../packages/api/src/cache/cacheConfig.ts) |
| Status-poll idiom | `useActiveJobs` — 5 s `refetchInterval` while active, `false` when terminal | [queries.ts:212-223](../../../client/src/data-provider/SSE/queries.ts#L212) |
| Per-`:file_id` route + ACL | `GET /:file_id/preview` + `fileAccess` middleware | [files.js:418,27](../../../api/server/routes/files/files.js#L418) |
| Retry-button UI | `PendingFileRow` (`RefreshCw`, `com_knauf_knowledge_retry`) | [KnaufKnowledgeFileList.tsx:209-215](../../../client/src/knauf/components/Agents/KnaufKnowledgeFileList.tsx#L209) |

### Gotchas (carry into every WP ticket)

1. **`dist/` build:** packages run from `dist/` — after edits under `packages/*/src`, run
   `npm run build:packages` and restart the backend, or changes silently don't apply.
2. **Index creation:** Mongo indexes auto-build only when `MONGO_AUTO_INDEX` is on
   ([connect.js:24-27,63](../../../api/db/connect.js#L24)). `createIndexesWithRetry` exists
   ([retry.ts:84](../../../packages/data-schemas/src/utils/retry.ts#L84)) but is **unwired** in
   single-tenant startup — if the environment sets `MONGO_AUTO_INDEX=false`, create the new indexes
   out-of-band.
3. **`File.status` is taken:** the existing enum ([file.ts:73-81](../../../packages/data-schemas/src/schema/file.ts#L73))
   belongs to the code-execution preview flow. All new fields are `knauf_*`-namespaced.
4. **Temp file lifetime:** the upload route's `finally` unlinks `req.file.path`
   ([files.js:738-748](../../../api/server/routes/files/files.js#L738)) — the worker must read bytes
   from the blob, never from the request's temp path.
5. **Metrics:** Prometheus names use underscores (`knauf_file_index_*`, not dots); recorders are
   per-process no-ops until `createMetrics()` runs — the worker process must call it and have
   `METRICS_SECRET` set.
6. **Images:** `Dockerfile` and `Dockerfile.multi` (there is no `Dockerfile.knauf`); the API `CMD` is
   `npm run backend` / `node server/index.js` — the worker is the same image with a different command.
7. **Client `file_id` is discarded today:** [multer.js:29](../../../api/server/routes/files/multer.js#L29)
   mints `req.file_id = crypto.randomUUID()` and [files.js:699-700](../../../api/server/routes/files/files.js#L699)
   demotes the client's id to `temp_file_id`; `createFile` upserts on `file_id` **alone**
   ([methods/file.ts:352-355](../../../packages/data-schemas/src/methods/file.ts#L352)). Upload
   idempotency (plan invariant #3) is unimplementable until WP3a fixes this.
8. **`embedded` consumers:** async-created File rows carry `embedded=false` until activation. Every
   consumer of `embedded` (delete/vector-cleanup paths, dedup-hit reuse at
   [process.js:913-915](../../../api/server/services/Files/process.js#L913), client gating) needs the
   WP2 projection rule.
9. **No multi-document transactions anywhere** (plan invariant #13). The
   `getTransactionSupport` cache defect ([transactions.ts:54-63](../../../packages/data-schemas/src/utils/transactions.ts#L54))
   makes this non-negotiable; correctness comes from single-document CAS + unique indexes +
   reconciliation.

---

## 3. WP0 — containment (agentic-karl slice; unblocked; ships first)

**`crud.js` (4c seam) — two timeout knobs, not one:**
- *Sync-path timeout (this WP):* a short, ingress-bounded axios `timeout` on
  `uploadVectors` ([crud.js:214](../../../api/server/services/Files/VectorDB/crud.js#L214)) and
  `deleteVectorsByIds` ([:81](../../../api/server/services/Files/VectorDB/crud.js#L81)) for the
  still-synchronous request path. Env-configurable via `math()`.
- *Worker-call timeout (WP4, not here):* the calibrated long cap (start ~30 min pre-prod per plan
  §7.5) applies only to the dedicated worker's RAG call. Do not put a 30-minute timeout inside the
  HTTP request path.
- Honor 429 `Retry-After` and add bounded retry to the embed path (the delete path already retries,
  [crud.js:31,79-100](../../../api/server/services/Files/VectorDB/crud.js#L31)); classify per plan §5.3.

**Client transfer cap (4c):** bound upload dispatch to 2-3 concurrent —
[useFileHandling.ts:297,327](../../../client/src/hooks/Files/useFileHandling.ts#L297) (`mutate()` is
fire-and-forget; wrap the `handleFiles` loop at `:381` in a bounded pool) and
[useDrainPendingKnaufFiles.ts:67-79](../../../client/src/knauf/data-provider/Agents/useDrainPendingKnaufFiles.ts#L67)
(chunk the `Promise.allSettled`).

**Metrics + logs (4c in `metrics.ts` + call sites):** the `knauf_file_index_*` recorder set (plan
§11.1 list; underscore names) via the module-level no-op pattern; the plan §11.2 lifecycle events
(`accepted`, `blob_stored`, `claimed`, `heartbeat_lost`, `rag_succeeded`, `activated`,
`retry_scheduled`, `failed`, `delete_requested`, `generation_cleaned`, `asset_deleted`) as structured
logs; **tag hygiene** — bounded tags only (env, route, vector backend, outcome, error code), never
file/user IDs, filenames, hashes, or text (plan §10); sanitize + truncate anything stored in
`last_error_detail`.

**Already true (don't re-do):** the client-side body-failure guard exists
([crud.js:227-233](../../../api/server/services/Files/VectorDB/crud.js#L227)). The "HTTP 200 with
failed body" and `Retry-After`-preservation fixes are the **rag_api slice of WP0** (external).

**External-but-gating WP0 outputs** (carried so nobody forgets they gate §17.5): measured arrival
rate, file-size/chunk distributions, P50/95/99 durations, downstream quota headroom, agreed
time-to-ready SLO, final retry/attempt configuration.

---

## 4. WP2 — `FileAsset` model + migration (agentic-karl)

### 4.1 New model: `KnaufFileAsset`, collection `knauf_file_assets`

Author the standard four layers + barrels (template: `File`; minimal net-new example:
`migrationAllowlist`):

- `packages/data-schemas/src/schema/fileAsset.ts` — fields exactly per **plan §4.2** (incl.
  `execution_token`, `target_generation`/`active_generation`, `index_profile`, `vector_backend`,
  `embed_route`, `delete_requested_at`; `dedup_key` = isolation scope + content hash + index profile,
  **chat-only**; `blob` = source + stable path/key + region + bytes + MIME — **never an expiring SAS
  URL**); indexes exactly per **plan §4.3** declared with `file.index(...)`-style calls.
- `types/fileAsset.ts`, `models/fileAsset.ts` (`createFileAssetModel`, guard-and-reuse, apply
  `applyTenantIsolation`), `methods/fileAsset.ts` (`createFileAssetMethods`).
- Barrel registrations: `schema/index.ts`, `models/index.ts` (both type + returned object),
  `methods/index.ts` (AllMethods + spread + type re-export), `types/index.ts`. Then
  `npm run build:packages`.

**Named methods (the state machine as an API):**

| Method | Contract |
|---|---|
| `reserveAsset` | find-or-create by `dedup_key` (chat) or fresh `asset_id` (agent/no-dedup), `status=uploading`; E11000 → return existing (the [config.ts:187-198](../../../packages/data-schemas/src/methods/config.ts#L187) pattern) |
| `markQueued` | CAS `uploading→queued` + blob metadata + `next_attempt_at=now` |
| `claimNextDue` | the plan §5.1 `findOneAndUpdate` verbatim (`$or` queued-due / lease-expired, tombstone-excluded, `$inc` attempt+generation, oldest-due-first sort) |
| `heartbeat` | CAS on `asset_id + execution_token + status=processing + no tombstone`; miss ⇒ ownership lost |
| `requeue` / `fail` | CAS on execution token; **atomically clear `lease_owner`, `lease_expires_at`, `execution_token`**; `requeue` sets `next_attempt_at` (full-jitter backoff, honoring provider `Retry-After`); `fail` sets stable `last_error_code` |
| `activateGeneration` | CAS on `asset_id + status=processing + execution_token + target_generation + no tombstone` → `active_generation=target`, `status=ready` |
| `requestDelete` | recount logical refs by `knauf_asset_id`; last-reference ⇒ CAS to `deleting` + `delete_requested_at` |
| `markDeleteFailed` / `retryDelete` | `deleting↔delete_failed` transitions with stable codes |
| `countQueuedByUser` / `sumQueuedBytesByUser` | admission-control queries (WP3) |

### 4.2 `file.ts` 4c seam (one fenced block)

- Add `knauf_upload_batch_id` (plan §4.1) — optional, client-generated, for derived batch UX.
- Add the **`knauf_asset_id` lookup index** (plan §4.3 last line) — none exists today (verified:
  only the `(user, knauf_content_hash…)` pair at
  [file.ts:194-205](../../../packages/data-schemas/src/schema/file.ts#L194)); reference recount and
  list-API batch hydration need it.

### 4.3 `embedded` projection rule

Inventory every `embedded` consumer; rule: **activation also sets `File.embedded=true`** (and the
legacy mapping treats `embedded=true` as `ready`/generation-0), so upstream consumers and the KK20-204
dedup-hit reuse path ([process.js:913-915](../../../api/server/services/Files/process.js#L913)) keep
working unchanged.

### 4.4 Migration (Tier-3; `requireKnaufApiKey` route)

Idempotent, restartable, **batched and cursor-resumable** (an HTTP-triggered long backfill must
process in bounded batches with a resume cursor, or it dies at the gateway). Implements **all 7 plan
§4.4 steps**: one asset per distinct `knauf_asset_id` (deduped chat rows); `asset_id = file_id` for
non-deduped/agent rows; backfill missing `File.knauf_asset_id`; `embedded=true → status=ready,
active_generation=0`; generation 0 = legacy vectors (absent generation field); known-incomplete rows →
`failed` + `migration_inconsistent` (never silently auto-embed); generation-0 **read compatibility in
this repo** until legacy assets are re-indexed or deleted. Reports counts (scanned / created /
legacy-ready / incomplete / inconsistent). Upsert-by-natural-key makes re-runs no-ops.

### 4.5 Deletion primitives live here

The recount→CAS-`deleting`+tombstone primitive, `delete_failed`, and asset-row retention ("remove the
`FileAsset` row only after confirmed blob + every-generation cleanup") are FileAsset methods — an
extension of the proven `gcDedupRows` recount-per-asset model
([cascadeDeleteConvoFiles.js:296-366](../../../api/server/services/Files/knauf/cascadeDeleteConvoFiles.js#L296)).
WP3 makes every delete surface call them (§5.6).

---

## 5. WP3 — API lifecycle (agentic-karl)

### 5.1 Upload idempotency (WP3a — new work the accepted plan implies but does not enumerate)

- Keep the **client-generated `file_id`** as THE `file_id`: change
  [multer.js:29](../../../api/server/routes/files/multer.js#L29) +
  [files.js:699-700](../../../api/server/routes/files/files.js#L699) to validate (UUID format) and
  adopt the client id instead of demoting it to `temp_file_id`.
- **Owner-scope** the logical-file upsert/uniqueness: `createFile` currently upserts on `file_id`
  alone ([methods/file.ts:352-355](../../../packages/data-schemas/src/methods/file.ts#L352)) — a
  replayed id from another user must never overwrite a row. Scope the upsert (and a unique index) to
  owner + `file_id`.
- Add plan §6.1 step 5: same owner + `file_id` + same destination/content → return current projected
  state; same key, different content/destination → **HTTP 409 `upload_idempotency_conflict`**.

### 5.2 Flag-gated dual-branch upload (WP3b)

Scope: **`tool_resource === file_search`, non-image only** — the `context`/OCR, `execute_code`, and
image branches of `processAgentFileUpload` are untouched. Preserve the two scope branches (invariant
#4): chat (`messageAttachment`) = per-user dedup (`dedup_key` set) + `/embed`; agent library = **no
dedup_key** + `/agent/embed`; stamp `embed_route`/`scope_type`/`isAgentFile` accordingly.

Common trunk (both flag states) — replaces the current order at
[process.js:875-1077](../../../api/server/services/Files/process.js#L875):
hash ([contentDedup.js:21](../../../api/server/services/Files/knauf/contentDedup.js#L21)) →
`reserveAsset` → blob upload to the deterministic asset path
([process.js:928/941](../../../api/server/services/Files/process.js#L928)) → `createFile` (durable
state **before any embed**; kills failure modes 1/2) → `addAgentResourceFile`
([:987-994](../../../api/server/services/Files/process.js#L987)). Then:

- **`KNAUF_ASYNC_FILE_INDEXING_ACCEPT` off** → embed in-request as today, but recorded through the
  FileAsset claim/activation path, respond **200** — this is plan rollout step 4
  (sync-through-FileAsset), which must run in production before async acceptance.
- **on** (+ tenant allow-list) → `markQueued`, respond **202**; no embed in-request.

**Existing-asset branch table (plan §6.1):** `ready` → return ready, no re-embed ·
`uploading/queued/processing` → return current state, no duplicate physical work · `failed` + stored
blob → return failed, retryable · `failed` without blob → `file_reupload_required` ·
`deleting/delete_failed` → 409 stable conflict code.

### 5.3 Response shape — backward-compatible superset (flagged deviation from plan §6.2)

The plan's nested `{ file: {...}, indexing: {...} }` literal would break every current client:
`useUploadFileMutation` inserts the raw body into the `TFile[]` cache and reads `data.file_id`
([mutations.ts:44-47,76](../../../client/src/data-provider/Files/mutations.ts#L44)), and
`useFileHandling` parses flat `data.filepath`/`data.temp_file_id`
([useFileHandling.ts:176-207](../../../client/src/hooks/Files/useFileHandling.ts#L176)). Ship a
**superset**: keep today's flat TFile spread ([process.js:1077](../../../api/server/services/Files/process.js#L1077))
and add `indexing { status, ready, retryable, error_code, queued_at }` + `batch_id` as siblings.
Same fields as §6.2, compatible envelope. **Architect sign-off required** (see §9).

### 5.4 Status / retry endpoints (under `/api/files`, not `/api/knauf`)

Mirror the `GET /:file_id/preview` + `fileAccess` ACL pattern
([files.js:418,27](../../../api/server/routes/files/files.js#L418)); inherit
`requireJwtAuth`/`configMiddleware`/`checkBan` from `routes/files/index.js`:

- `GET /api/files/:file_id/index-status` — per-file projection (authoritative contract).
- `GET /api/files/index-status?batch_id=<id>` — derived aggregate counts + per-file terminal failures
  (no batch collection).
- `POST /api/files/:file_id/index/retry` — plan §6.4 verbatim: authorized like file/agent
  modification; CAS **only** `failed→queued`; clears bounded error fields; resets attempts; requires
  confirmed blob metadata else `file_reupload_required`; idempotent; never retries
  `ready/deleting/delete_failed`.

**List-API status projection (plan §6.3):** existing file-list / agent-files responses project the
current asset status (batch-hydrate via the new `knauf_asset_id` index) so clients never need one
call per row.

### 5.5 Readiness enforcement + admission control

- Server: 409 `file_indexing_not_ready` when a request explicitly selects a non-ready initial asset;
  `fileSearch.primeFiles` filters non-ready/tombstoned assets as defense-in-depth (narrow the query at
  [fileSearch.js:43](../../../api/app/clients/tools/util/fileSearch.js#L43) or guard the loop at
  `:63-67`).
- **Admission control (plan §9.3):** extend the existing limiter layer
  ([uploadLimiters.js:55-84](../../../api/server/middleware/limiters/uploadLimiters.js#L55), wired at
  [routes/files/index.js:35-44](../../../api/server/routes/files/index.js#L35)) with queued-files and
  queued-bytes caps per user/tenant (backed by `countQueuedByUser`/`sumQueuedBytesByUser`); reject
  with HTTP 429 + a stable code; limits from config.

### 5.6 Delete surfaces converge

All four delete surfaces call the WP2 primitives (`requestDelete` → recount → CAS `deleting` +
tombstone → physical cleanup → row removal only after confirmed cleanup; failures → `delete_failed`):

1. Direct route — `deleteFilesWithDedupAwareness`
   ([cascadeDeleteConvoFiles.js:501-515](../../../api/server/services/Files/knauf/cascadeDeleteConvoFiles.js#L501)).
2. Conversation cascade (same module).
3. Agent-knowledge detach.
4. **Retention sweep** ([sweep.ts](../../../packages/api/src/files/sweep.ts)) — it is itself a
   physical-delete surface and must not bypass the tombstone.

Cleanup ownership: the deletion owner (request path) attempts physical cleanup; the WP4 reconciler
retries `delete_failed`. Stable error codes per plan §15 throughout.

---

## 6. WP4 — dedicated worker (agentic-karl + external Deployment)

### 6.1 Worker entry (net-new `api/server/worker.js` + npm script)

No worker mode exists today (`experimental.js` is an HTTP cluster simulator). The entry boots:
`connectDb()` → `getAppConfig({ baseOnly: true })` → `initializeFileStorage(appConfig)` →
`createMetrics()` → a minimal `http.Server` serving `/livez` + `/readyz` + `/metrics` →
`setupGracefulShutdown(server)` → the claim loop. Gate on `KNAUF_INDEXING_WORKER_ENABLED`
(early-exit log when off). **No** Express routes, MCPs, or `app.listen` of the API app.

### 6.2 Claim loop (fork of the `sweep.ts:259` template)

`setInterval` + re-entrancy guard + `interval.unref()` + immediate first run, work wrapped in
`runAsSystem`. Per claimed asset:

1. `claimNextDue` (oldest-due-first; lease per config; `$inc` attempt + target_generation;
   new `execution_token`).
2. Build the per-file `req.user` from persisted scope (the
   [sweep.ts:151-183](../../../packages/api/src/files/sweep.ts#L151) shape) — required for
   `runAsSystem`-scoped reads and `generateShortLivedToken(file.user)`.
3. Re-materialize the blob via `getStrategyFunctions(source).getDownloadStream` **streamed** to a
   bounded temp file (never buffer whole multi-hundred-MB files in memory; never fetch the stored
   SAS URL).
4. Tombstone check → RAG embed carrying `asset_id`+`generation`+scope+`index_profile`, with the
   **calibrated worker timeout** (start ~30 min pre-prod; final from P99) and `Retry-After`-aware
   backoff via `retryWithBackoff`; retry classes per plan §5.3 (incl. configuration/auth =
   limited-retry + immediate alert).
5. Tombstone re-check → `activateGeneration` CAS. On CAS miss: clean **only its own generation**,
   never the active one.
6. Heartbeat every 30 s, token-fenced; a heartbeat miss = ownership lost → stop, no state writes.
7. `registerShutdownTask('indexing worker', …)`: stop claiming, wait within grace; **never release a
   lease while a RAG call may still execute** (let it expire; generation fencing protects).

### 6.3 Reconciler (named deliverable, same process)

Bounded periodic pass covering the seven plan §8.4 cases — stale `uploading`, expired `processing`
lease, `File` → missing asset, asset with no logical references, `delete_failed` due for retry,
`ready` without `active_generation`, migration inconsistency — each with a defined action
(repair-when-unambiguous, else alert + leave intact), indexed/limited queries, and a counts metric
per case.

### 6.4 Configuration (all env, validate-at-boot module; `math()`/`isEnabled`)

Lease duration (default 5 min), heartbeat interval (30 s), attempt cap / base / max backoff, poll
interval, per-pod in-flight (default 1), worker RAG timeout, reconciler cadence. No hard-coded
constants (plan §5.2-5.3).

### 6.5 External interface (agk-deployment-configs) + Datadog bridge

Worker Deployment: **same image/tag** as the API, `command` = the worker entry, no HTTP
Service/Ingress (container port only for probes/metrics), **no HPA/KEDA**, `maxSurge: 0` +
pause-and-drain rollout, **2 replicas × 1 in-flight**, PDB/probes/resources, `envFrom` ConfigMap +
ExternalSecret (`MONGO_URI`, `JWT_SECRET`, `RAG_API_URL`, `METRICS_SECRET`, the `KNAUF_*` flags +
knobs). **Metrics bridge:** the repo emits prom-client on an auth-gated `/metrics` — the Datadog
monitors in plan §11.3 need an OpenMetrics scrape config (annotations + the bearer secret) and a
name-mapping note (`knauf.file_index.*` monitor names ↔ `knauf_file_index_*` Prometheus names).

---

## 7. WP5 — client UX (agentic-karl)

- `useKnaufIndexStatus(fileIds)` hook mirroring `useActiveJobs`
  ([queries.ts:212-223](../../../client/src/data-provider/SSE/queries.ts#L212)): 5 s while any file
  is non-terminal, stop on all-terminal.
- Index status carried on `ExtendedFile` (populated from the upload response `indexing` sibling, the
  poll, and list-API projection).
- Send-gate: extend `filesLoading` ([FileRow.tsx:67](../../../client/src/components/Chat/Input/Files/FileRow.tsx#L67))
  to hold while any file_search file is not `ready`, **and** filter the submit map
  ([useChatFunctions.ts:505-515](../../../client/src/hooks/Chat/useChatFunctions.ts#L505)) — the gate
  must live in the message-assembly path, not only the disabled button.
- Agent knowledge: `SavedFileRow`
  ([KnaufKnowledgeFileList.tsx:129-183](../../../client/src/knauf/components/Agents/KnaufKnowledgeFileList.tsx#L129))
  renders server-backed `processing/ready/failed` + a retry action (reuse the `PendingFileRow` retry
  pattern at `:209-215` → `POST /index/retry`); failed state survives reload (server-persisted). The
  client-only `pendingAgentFiles.ts` statuses remain the separate pre-save concern.
- Optional batch summary UI from the `batch_id` endpoint; one failed file never hides successes.
- `com_knauf_file_indexing_*` i18n keys in **both** `en` and `de` `translation.json` (flat,
  alphabetical, `{{0}}` interpolation).
- **Ordering constraint:** WP5 ships before `KNAUF_ASYNC_FILE_INDEXING_ACCEPT` is enabled for any
  user (plan rollout step 7).

---

## 8. WP1 — generation-safe RAG (external repo; the interface this repo consumes)

Owned by `agentic-karl-rag-api` (+ the deployed image — pin the exact baseline first, plan §17.4).
The contract `agentic-karl` codes against:

- **Embed** (`/embed`, `/agent/embed`): carries `asset_id`, `generation` (positive int from the
  claim), persisted scope, `index_profile`; multipart file as today. Success only when every
  chunk/document succeeded: `{ "status": "ready", "asset_id", "generation", "chunks_expected",
  "chunks_written" }`. Failures: 4xx stable codes for bad input; 429 preserving `Retry-After`; 5xx
  transient; partial Azure-Search document failure = request failure.
- **Query**: each `asset_id` passed with its `active_generation`; RAG filters on both; generation 0
  matches legacy vectors with no generation field.
- **Delete**: by `asset_id`+`generation` (one inactive generation) AND all-generations; full
  pagination (>1,000 Azure documents); idempotent 404/empty; response reports
  matched/deleted/failure counts.
- Vector identity: deterministic `asset_id:generation:chunk_index`, upsert never blind-append; new
  vectors invisible until activation; a stale attempt cleans only its own generation.

agentic-karl-side changes: `uploadVectors` and the query/delete paths in
[crud.js](../../../api/server/services/Files/VectorDB/crud.js) /
[fileSearch.js](../../../api/app/clients/tools/util/fileSearch.js) carry the new fields.
**WP1 is the critical path — it gates WP4.**

---

## 9. Discoveries to confirm with the architect

Three code-level findings from this mapping that the accepted plan should incorporate or sign off:

1. **The client `file_id` is discarded server-side today** ([multer.js:29](../../../api/server/routes/files/multer.js#L29),
   [files.js:699-700](../../../api/server/routes/files/files.js#L699)), and `createFile` upserts on
   `file_id` alone — plan §4.1's "use the existing client-generated `file_id`" premise requires the
   WP3a changes (client-id adoption + owner-scoped uniqueness), which the plan does not list.
2. **The body-level failure guard already exists client-side**
   ([crud.js:227-233](../../../api/server/services/Files/VectorDB/crud.js#L227)) — the observed
   "HTTP 200 with failed body" means rag_api's `status` field is wrong on partial failure; confirms
   the WP0 fix is rag_api-side.
3. **Response-shape deviation:** WP3 ships a backward-compatible **superset** body (flat TFile spread
   + `indexing`/`batch_id` siblings) instead of plan §6.2's nested literal, because current clients
   parse the flat shape ([mutations.ts:44-47,76](../../../client/src/data-provider/Files/mutations.ts#L44)) —
   a nested body cannot be rolled out flag-staged without breaking uploads.

---

## 10. Blocking-decision gates

Plan §17 decisions mapped to the WP each one blocks:

| Decision | Blocks |
|---|---|
| 1 `File`/`FileAsset` ownership + collection naming | WP2 |
| 2 Isolation scope + exact `dedup_key` inputs | WP2 |
| 3 Generation-aware RAG contract | WP1 |
| 4 Exact deployed RAG source/image baseline | WP1 |
| 5 SLO, job timeout, attempts/backoff, initial concurrency (from WP0 measurements) | WP0→WP4 |
| 6 Queued-file/byte admission limits | WP3 |
| 7 Worker identity, persisted scope, RAG token path | WP4 |
| 8 Operational ownership (`failed`, `delete_failed`, generation cleanup) | WP6 |
| 9 Legacy generation-0 migration/retention duration | WP2 |

---

## 11. PR sequence

1. **WP0** — sync-path RAG timeout + `Retry-After` + bounded retry; client transfer cap; metrics +
   lifecycle events. Small, unblocked, independently valuable.
2. **WP1** (rag_api repo — critical path) ‖ **WP2** — FileAsset model + `file.ts` seam + migration +
   deletion primitives. Parallel tracks.
3. **WP3a** idempotency (multer/files.js client-id adoption + owner-scoped `createFile`) →
   **WP3b** sync-through-FileAsset (accept flag off; = plan rollout step 4) →
   **WP3c** endpoints + list projection + readiness gating + delete convergence + admission control.
4. **WP4** — worker + reconciler; deploy claims-disabled → dev canary (concurrency 1, full fault
   matrix) → prod at the 2×1 hard cap.
5. **WP5** — client UX; **must land before any accept-flag enablement**.
6. **WP6** — flags/values, monitors, runbooks, canary allow-list: throughout.

Hard constraint from the plan: **no WP4 async acceptance before WP1–WP3 acceptance criteria pass.**
Rollback (plan §12): accept-flag off stops new async work; worker drains unless RAG is unsafe (then
pause claims — active generations stay queryable); never route queued work back through synchronous
embedding; all data changes additive.

---

## 12. Test-matrix mapping (plan §14 → suites in this repo)

| Plan §14 row | Suite |
|---|---|
| Lost upload response (replayed `file_id`) | jest api: upload idempotency (WP3a) |
| Concurrent identical chat uploads | jest data-schemas: `reserveAsset` E11000 single-asset; api integration |
| Concurrent different large uploads | dev fault/load (2× burst) |
| Blob upload fails | jest api: reservation reconcilable, no queued work without blob |
| Worker dies before RAG | integration: lease expiry → reclaim |
| Worker dies during RAG | integration: new generation starts; only winning token activates |
| Worker dies after RAG before CAS | integration: retry writes new generation; one activation wins |
| Heartbeat stalls | jest: token-fenced heartbeat miss ⇒ no state writes |
| Azure OpenAI 429 | jest: `Retry-After` honored (WP0 + worker backoff) |
| RAG 5xx / network timeout | jest: retry classification + bounded attempts |
| pgvector partial batch failure | WP1 (rag_api repo tests); contract test here |
| Azure per-document failure | WP1 (rag_api repo tests); contract test here |
| Duplicate claim/delivery | jest: claim CAS single-winner; activation fencing |
| Delete while queued | jest: tombstone blocks claim/activation |
| Delete while processing | integration: tombstone wins; late generation cleaned |
| Delete one dedup reference | jest: shared asset survives (recount) |
| Delete last reference | integration: all generations + blob removed before row |
| Cleanup failure | jest: `delete_failed` observable + retryable |
| Rolling deploy | dev fault: SIGTERM stops claims; no concurrency surge (`maxSurge:0`) |
| Mongo outage | dev fault: durable pause + resume, no duplicate visibility |
| RAG outage beyond retries | jest: terminal `failed` + authorized manual retry |
| Legacy generation 0 | jest + integration: migrated `ready` file stays searchable |

Plus (plan §9.2): the stale-request-overlap capacity test — a killed worker's in-flight RAG request
outliving the pod must be included in capacity/fault testing.

**Datastore validation:** the claim query (`$or` + sort + update-pipeline generation assignment) and
the `dedup_key` **partial-unique index** semantics against Cosmos/DocumentDB via the existing
`packages/data-schemas/misc/ferretdb` harness; assert no code path uses multi-document transactions.

---

## 13. Definition of done for this document

This code map is consumed when every WP0–WP6 ticket cites the section here that scopes it, and it is
archived (or folded into `knauf/docs/architecture/`) together with the accepted plan when the plan's
own §18 definition of done is met.

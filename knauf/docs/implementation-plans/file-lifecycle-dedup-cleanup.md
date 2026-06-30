# File lifecycle — deduplication + cascade cleanup on chat delete

> The lifecycle half of the [file-management roadmap](../future-work/file-management-roadmap.md):
> stop duplicating identical uploads (**T1**) and stop orphaning files when a chat is deleted
> (**T2**). Retention/TTL (**T3**) is explicitly **out of scope** for this workstream. Spans
> three steps with a hard ordering constraint — the two features share a deletion path and a
> reference-counting invariant, and the dedup half is gated on a RAG-API spike.

---

## TL;DR

Today a file's lifecycle after upload is unmanaged. **No dedup:** every upload gets a fresh
random `file_id` ([multer.js:28](../../../api/server/routes/files/multer.js#L28)), so the same
PDF in 5 chats is 5 blobs + 5 pgvector embeddings + 5 Mongo rows. **No cleanup on chat delete:**
[`deleteConvos`](../../../packages/data-schemas/src/methods/conversation.ts#L454) removes the
convo + messages only — blobs, File rows, and embeddings are orphaned forever.

We ship the two as a coordinated pair because they meet at one invariant: **once dedup makes a
physical blob/vector set shared across conversations, cleanup must not delete an asset another
chat still references.** The bridge is a reference-count guard, introduced degrade-safe in the
cleanup PR and given dedup-aware logic in the dedup PR.

**Delivery order (decided):** cleanup **first** (safe to ship standalone — nothing is shared
pre-dedup), then a RAG spike, then **full** dedup (blob **and** embeddings, not blob-only).

**Where we are now:** planning complete; tickets not yet filed (drafts pending). No code landed.

---

## Architecture / mental model

### The deletion path everything reuses

```
chat delete ─▶ convos.js route ─▶ collect file_ids ─▶ refcount guard ─▶ processDeleteRequest
                                   (union of links)    (drop only ↓        ├─ blob (per-source strategy)
                                                         unreferenced)      ├─ pgvector (deleteVectors)
                                                                            ├─ Mongo (deleteFiles)
                                                                            └─ agent-resource refs
```

[`processDeleteRequest`](../../../api/server/services/Files/process.js#L126) already deletes
blob + vectors + Mongo + agent refs for an explicit single-file delete. **Both T2 (cascade) and
a future T3 (sweep) reuse it** — we do not reinvent deletion. The new work is everything *left*
of it: collecting the right file_ids and filtering them through the refcount guard.

### The reference-count invariant (the T1↔T2 seam)

A physical asset (blob + its embeddings) may be referenced by N logical things: multiple
conversations (fork/duplicate today; dedup tomorrow), multiple messages, an agent's
`tool_resources`. **Physically delete an asset only when its live-reference count hits zero.**

- **Pre-dedup** every upload is unique, so the guard is effectively a no-op — but it already
  earns its keep by protecting files shared via the existing fork/duplicate-conversation feature.
- **Post-dedup** the guard is load-bearing: it's what stops chat A's deletion from nuking the
  blob chat B still uses.

Implemented as **computed counts** (`countDocuments`), never a stored mutable counter — a
hand-maintained counter drifts on retries/crashes. Stable interface so the implementation can
change without touching callers:

```
partitionByRefCount(files, { excludeConversationIds }) → { deletable, sharedStillReferenced }
```

### Why dedup needs a spike (the pgvector unknown)

The RAG API is an **upstream image, not in this repo** ([docker-compose.yml](../../../docker-compose.yml)
`rag_api`; the Knauf overlay [knauf/rag-api-overlay/](../../../knauf/rag-api-overlay/) only patches
document loading/chunking, never `/embed` · `/query` · `/documents`). Vector dedup means reusing
one embedding under multiple agents, but agent file_search queries carry
`entity_id = agent.id` ([fileSearch.js:103-115](../../../api/app/clients/tools/util/fileSearch.js#L103-L115)).
Whether a query under agent B finds vectors embedded under agent A is **undocumented and
unreadable from here** — it must be tested live before any vector-dedup code is written.

---

## Rollout sequence (do these in order)

### Step 1 — PR1: cascade file + embedding cleanup on chat delete (T2)

Safe to ship standalone (pre-dedup nothing is shared). Branch `feat/KK20-203-cascade-file-cleanup`.

1. **`configMiddleware` on the delete routes.** [convos.js `delete('/')`](../../../api/server/routes/convos.js#L97)
   and [`delete('/all')`](../../../api/server/routes/convos.js#L141) lack it today, so `req.config`
   is undefined — but `processDeleteRequest` dereferences it immediately. It's already imported
   ([convos.js:11](../../../api/server/routes/convos.js#L11)).
2. **Collect file_ids *before* deletion**, from the union of linkages (no single one is complete):
   `File.conversationId` (unset on RAG uploads — see step 5), `Conversation.files[]`, and
   `Message.files[]` (the durable per-message link). Collect first, then call `deleteConvos`
   (its signature stays unchanged → no `packages` rebuild for this PR).
3. **Refcount guard** (`partitionByRefCount`) — only files with zero references outside the
   deletion set are passed on.
4. **Reuse `processDeleteRequest`** for the deletable set. ⚠️ **Never pass `user` to
   [`deleteFiles`](../../../packages/data-schemas/src/methods/file.ts#L295)** — with a `user` arg
   it ignores `file_ids` and deletes *all* the user's files. The reused path already calls it
   correctly (ids only).
5. **Stamp `conversationId` on chat File Search uploads** (two-sided prerequisite so RAG files are
   catchable by conversationId): client appends it to the FormData
   ([useFileHandling.ts:214-227](../../../client/src/hooks/Files/useFileHandling.ts#L214-L227),
   guarded against the `NEW_CONVO` sentinel); server sets it in the `file_search` `fileInfo`
   ([process.js ~717](../../../api/server/services/Files/process.js#L717)).
6. **Harden the pgvector delete** — bounded retry/backoff in
   [`deleteVectors`](../../../api/server/services/Files/VectorDB/crud.js#L20) (its throw is
   swallowed by `Promise.allSettled`, so leaks are silent today).

Real logic lives in a **Tier 3 Knauf module** (`api/server/services/Files/knauf/`); upstream files
get thin **Tier 4c `[knauf]`** markers + SEAMS.md rows (`convos.js`, `process.js`, `crud.js`,
`useFileHandling.ts`).

### Step 2 — RAG `/query` `entity_id` spike (gates Step 3 vector dedup)

Against a live `rag_api` (compose stack):

1. `POST /embed` a doc with `file_id=F`, `entity_id=A`.
2. `POST /query` `{file_id:F, query}` — **no** `entity_id` → hits?
3. `POST /query` `{file_id:F, entity_id:B}` (mismatched) → hits or empty?
4. Inspect `langchain_pg_embedding.cmetadata` for an `entity_id` filter column; check for any way
   to associate existing vectors with a new `entity_id`.

| Outcome | Meaning | Action |
|---|---|---|
| Step 3 returns hits | query filters loosely / ignores `entity_id` | full cross-agent vector dedup is safe → proceed Option C |
| Step 3 empty | strict `(file_id, entity_id)` partition | cross-agent vector dedup needs a **Tier-2 RAG-image overlay** (scope separately); otherwise vector dedup is limited to the inline `context` path + same-agent re-uploads, cross-agent falls back to blob-only |

Record the verdict in the dedup ticket before writing Step 3 code.

### Step 3 — PR2: full per-user content-hash dedup (T1)

Branch `feat/KK20-204-content-hash-dedup`. **⚠️ `packages/*` rebuild gotcha applies** (below).

1. **Schema field + partial index** — `knauf_content_hash` (the `knauf_` prefix is mandatory per
   the fork field-naming rule; `contentHash` would risk an upstream collision) on
   [file.ts](../../../packages/data-schemas/src/schema/file.ts), `IMongoFile`, and `TFile`.
   Non-unique partial index `{ user:1, knauf_content_hash:1 }`.
2. **Hash in [files.js](../../../api/server/routes/files/files.js), not multer** — multer streams
   to disk (no buffer); the existing `[knauf]` encryption check already reads the temp file at the
   right spot. SHA-256 the raw bytes, set `metadata.knauf_content_hash` (both upload fns already
   receive `metadata` → no signature change).
3. **Atomic claim** (`claimContentHash`) mirroring the existing
   [`claimCodeFile`](../../../packages/data-schemas/src/methods/file.ts#L180) to avoid a
   double-canonical race on simultaneous first-uploads.
4. **Dedup on upload (Option C — canonical pointer)** in
   [`processFileUpload`](../../../api/server/services/Files/process.js#L391) /
   [`processAgentFileUpload`](../../../api/server/services/Files/process.js#L481): on a
   `{user, knauf_content_hash}` hit, create a new logical row but point `filepath` at the existing
   blob and store `knauf_canonical_file_id` → the canonical row; skip the blob upload and the embed.
5. **Resolve canonical at retrieval** — map `file_id → knauf_canonical_file_id` before `/query` in
   [fileSearch.js](../../../api/app/clients/tools/util/fileSearch.js#L103) and
   [createContextHandlers.js](../../../api/app/clients/prompts/createContextHandlers.js).
6. **Wire real refcount into PR1's guard** — blob count = `File.countDocuments({user, knauf_content_hash})`;
   vector count = canonical-group size. Delete Mongo rows first (or exclude in-flight ids), then
   physically delete only assets now at 0.
7. **No backfill** — dedup applies to new uploads only.

---

## Critical file map

| File | Repo role | PR1 | PR2 |
|---|---|---|---|
| [api/server/routes/convos.js](../../../api/server/routes/convos.js) | upstream — delete routes | `configMiddleware` + cascade call | — |
| `api/server/services/Files/knauf/cascadeDeleteConvoFiles.js` | **net-new Tier 3** | cascade + `partitionByRefCount` | refcount impl swapped |
| [api/server/services/Files/process.js](../../../api/server/services/Files/process.js) | upstream — upload/delete | `conversationId` stamp | dedup lookup + reuse branch |
| [api/server/services/Files/VectorDB/crud.js](../../../api/server/services/Files/VectorDB/crud.js) | upstream — pgvector | retry hardening | — |
| [client/src/hooks/Files/useFileHandling.ts](../../../client/src/hooks/Files/useFileHandling.ts) | upstream — upload client | FormData `conversationId` | — |
| [packages/data-schemas/src/schema/file.ts](../../../packages/data-schemas/src/schema/file.ts) | shared schema (`dist/`!) | — | `knauf_content_hash` + index |
| [packages/data-schemas/src/methods/file.ts](../../../packages/data-schemas/src/methods/file.ts) | shared methods (`dist/`!) | — | `claimContentHash`, refcount helpers |
| [packages/data-provider/src/types/files.ts](../../../packages/data-provider/src/types/files.ts) | shared types (`dist/`!) | — | `knauf_content_hash?` on `TFile` |
| [api/app/clients/tools/util/fileSearch.js](../../../api/app/clients/tools/util/fileSearch.js) | upstream — RAG query | spike target | canonical resolve |
| [api/app/clients/prompts/createContextHandlers.js](../../../api/app/clients/prompts/createContextHandlers.js) | upstream — inline RAG | — | canonical resolve |

---

## Verification recipes

**⚠️ `packages/*` rebuild (PR2):** mongoose `strict:true` + the Zod boundary silently strip
unknown fields. A new schema field saves 200-OK but never persists until:
```bash
NODE_OPTIONS=--max-old-space-size=8192 npm run build:packages   # rollup OOMs without the heap bump
# then restart the backend — nodemon does NOT watch packages/*/dist
```

**PR1 manual (stack via `docker compose up -d` + `npm run backend:dev`):** upload a file to a
chat, send a message, delete the chat → confirm the blob is gone from storage, the File row is
gone from Mongo, and the embedding is gone from pgvector:
```bash
docker compose exec vectordb psql -U myuser -d mydatabase \
  -c "select count(*) from langchain_pg_embedding where cmetadata->>'file_id' = '<FILE_ID>';"
# expect 0 after delete
```

**PR1 automated:** extend `process.integration.spec.js` — delete a convo invokes blob + Mongo +
`deleteVectors`; a file still referenced by a forked convo is **retained**.

**PR2 manual (the end-to-end proof T1+T2 compose):** upload the same PDF to two chats → **one**
blob, **one** vector set, two File rows, retrieval works in both. Delete chat A → asset survives
(refcount 1). Delete chat B → blob + vectors removed (refcount 0).

**PR2 automated:** `knauf_content_hash` round-trips through `createFile` post-rebuild; partial
index exists; `claimContentHash` under `Promise.all` → exactly one canonical row; on a hit the
storage strategy `handleFileUpload` and `uploadVectors` are **not** called.

---

## Tickets

Roadmap source: [file-management-roadmap.md](../future-work/file-management-roadmap.md) (T1, T2;
T3 deferred). No epic — two standalone tasks.

- **KK20-203 (PR1)** — Cascade file + embedding cleanup on chat deletion.
- **KK20-204 (PR2)** — Per-user content-hash file deduplication (RAG spike is its first AC).

---

## Open questions

- **RAG `/query` `entity_id` semantics** — the spike; gates Step 3. Cannot be answered from this repo.
- **Field case** — `knauf_content_hash` (snake, matches `knauf_fast_mode` precedent) vs `knaufContentHash`; prefix mandatory either way.
- **Ephemeral conversationId** — first-upload-to-new-chat files rely on `Message.files[]` for
  cleanup, not the `conversationId` stamp (sentinel chat has no real id yet).
- **pgvector orphan capture** — whether PR1 also records terminally-failed vector deletes to a
  Knauf collection now (cheap T3 hook) or defers it to T3.

# Investigation: "messages in chat history disappear after a while"

## Context

Users report that chat history disappears after some time. The report is ambiguous between two
distinct symptoms that have completely different root causes:

- **(S1) Whole conversations vanish from the sidebar history list.**
- **(S2) A conversation is still listed, but its older messages are gone when reopened.**

This investigation mapped every mechanism in the fork that can remove or hide conversations and
messages: MongoDB TTL, retention config, delete call sites, list pagination, the Knauf project
filter, tenant isolation, Meilisearch sync, client query-cache handling, and auth/session expiry.

Findings below are evidence-based with file:line references. Nothing here is speculative unless
explicitly marked.

---

## What was ruled OUT (do not spend time here)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Mongo data loss on restart / ephemeral volume | **Ruled out** | Local compose uses bind mounts (`docker-compose.yml:54-61` `./data-node:/data/db`); prod is external **Cosmos DB for MongoDB vCore** (`knauf/docs/reference/agentic-karl-architecture.md:266,447`). No StatefulSet, no `emptyDir`, no PVC for Mongo anywhere. |
| `retentionMode: "all"` deleting everything | **Not enabled** | `librechat.yaml` has no `retentionMode` key; Zod default is `TEMPORARY` (`packages/data-provider/src/config.ts:1211`). |
| Knauf audit-log retention sweep | **Ruled out** | Operates only on the `AuditLog` model (`packages/api/src/knauf/audit/retention.ts:318`). `KNAUF_AUDIT_RETENTION_DAYS` unset ⇒ sweep disabled entirely. |
| Langfuse retention job | **Ruled out** | HTTP-only against the Langfuse API; no mongoose/Conversation/Message reference. Unscheduled and inert. |
| Tenant isolation hiding rows | **Dormant** | `applyTenantIsolation` is applied to convo/message, but `user.tenantId` is never assigned by any code path in the tree ⇒ `getTenantId()` is always `undefined` ⇒ plugin is a no-op. **Latent**: see Risk R1. |
| Meilisearch deleting source rows | **Ruled out** | `mongoMeili.ts` only ever writes the `_meiliIndex` bookkeeping flag; it never deletes Mongo documents. |
| Filter-less `DELETE /api/convos` mass delete | **Not reachable from the UI** | `convos.js:124` 400-guard + `:132` `source === 'button'` early return cover every client call site. **Latent API hardening item**: see Risk R2. |

---

## Ranked root causes

### C1 — Project-scoped chats are filtered out of the main history list (S1, permanent, Knauf-specific)

The sidebar "Chats" list requests **only conversations with no project**:

```tsx
// client/src/components/UnifiedSidebar/ConversationsSection.tsx:44-58
// [knauf] Keep project chats out of general history while preserving global search.
projectId: search.debouncedQuery ? undefined : 'unassigned',
```

Server-side this becomes `{$or:[{chatProjectId:null},{chatProjectId:{$exists:false}}]}`
(`packages/data-schemas/src/methods/conversation.ts:566-567`).

A chat acquires `chatProjectId` from the **URL** at creation time:

```ts
// client/src/hooks/Chat/useChatFunctions.ts:425-430
const chatProjectId =
  conversationId === Constants.NEW_CONVO
    ? getRouteChatProjectId()
    : (conversation?.chatProjectId ?? null);
```

and `client/src/store/families.ts:96-97` writes `projectId` back into the URL, making it sticky.
`saveConvo` itself carries a comment acknowledging accidental assignment: *"a stale tab
re-submitting an older project id"*.

**Why it matches the report:** the chat is never deleted, but it is absent from the history the
user looks at, and **a reload does not bring it back**. Highest-probability explanation for S1.

Related, same file: `ConversationsSection.tsx:84-92` reduces the list to **at most one item or
empty** whenever a search query is active with a conversation open.

### C2 — Client query-cache destruction on 401 / token refresh (S1 + S2, recovers on reload)

Three compounding defects:

1. **`QueryClient` is constructed inside the `App` component body**, unmemoised
   (`client/src/App.jsx:21`). `App` consumes `ApiErrorBoundaryContext`, and the `QueryCache`
   `onError` calls `setError(...)` on **any 401** (`App.jsx:33-37`). The provider sits above `App`
   (`client/src/main.jsx`), so a 401 → provider state change → `App` re-render → **brand-new
   `QueryClient` with an empty cache**. Every loaded conversation page and message list is lost.
2. **`useRefreshTokenMutation` calls bare `queryClient.removeQueries()`** with no filter, in
   `onMutate` — i.e. *before* the refresh succeeds
   (`client/src/data-provider/Auth/mutations.ts:62-72`).
3. `SESSION_EXPIRY` is **15 minutes**. The sidebar has `staleTime: 30000` with
   `refetchOnWindowFocus` left at its `true` default, so returning to an idle tab immediately
   fires the query that 401s.

Mitigated but not eliminated by the existing `[knauf]` proactive-refresh seam
(`packages/data-provider/src/request.ts:255-274`, commit `6ef9829b1` — the team has already been
bitten by this class of bug).

### C3 — `clearMessagesCache` writes `[]` and `refetchOnMount: false` suppresses recovery (S2)

`clearMessagesCache` sets the **currently open** conversation's message list to `[]`
(`client/src/utils/messages.ts:334-347`) and is called by every "New Chat" affordance
(`NewChat.tsx:20-21`, `Conversations.tsx:100-101`, `ExpandedPanel.tsx:40-41`, …).

`useGetMessagesByConvoId` sets `refetchOnMount: false`
(`client/src/data-provider/Messages/queries.ts:141-146`), so navigating **back** to that
conversation renders it with zero messages until the 5-minute `cacheTime` GC.

Also: `client/src/components/Nav/SearchBar.tsx:35` calls
`queryClient.removeQueries([QueryKeys.messages])`, evicting every conversation's messages.

### C4 — Cursor pagination silently skips conversations (S1, permanent)

`packages/data-schemas/src/methods/conversation.ts:614-640`:

```js
cursorFilter = {
  $or: [
    { [finalSortBy]: { [op]: primaryValue } },
    { [finalSortBy]: primaryValue, updatedAt: { [op]: secondaryValue } },
  ],
};
```

When `finalSortBy === 'updatedAt'` (**the default**), the computed key `[finalSortBy]` resolves to
`updatedAt` and is then **overwritten by the literal `updatedAt` key**, collapsing branch 2 into
branch 1. The filter degenerates to a strict `updatedAt < cursor`. Combined with a sort object
carrying **no `_id` tiebreaker**, conversations sharing a boundary `updatedAt` are skipped and
never appear on any page. Most likely to bite after bulk writes/imports that share a timestamp.

### C5 — Temporary Chat 30-day TTL erodes conversations from the beginning (S2, permanent)

MongoDB TTL indexes are live on both collections:
`packages/data-schemas/src/schema/convo.ts:59` and `.../message.ts:191`, both
`{ expiredAt: 1 }, { expireAfterSeconds: 0 }`.

`saveConvo` re-stamps `expiredAt` **every turn**, but `saveMessage` stamps each message **once at
write time**. In any chat carrying an expiry the conversation keeps renewing itself while its
**oldest messages are deleted out from under it**. The fork's own privacy workstream documents
exactly this: *"An active conversation stays alive while its oldest messages are deleted out from
under it. Users see chats that lose their beginning"* (`knauf/docs/privacy/workstream.md` §7).

Reachability today: only `isTemporary: true` chats are stamped. But `isTemporary` and
`defaultTemporaryChat` are **localStorage-persisted** atoms (`client/src/store/temporary.ts:3-4`),
there is a **Ctrl+Shift+Y** shortcut, and a **"Default to temporary chat"** switch in Settings →
Chat — all silently sticky across sessions. Default window is **30 days**
(`DEFAULT_RETENTION_HOURS = 24 * 30`, `TEMP_CHAT_RETENTION_HOURS` unset).

Secondary: `buildRetentionVisibilityFilter` (`packages/data-schemas/src/utils/retention.ts:20-29`)
has no `{isTemporary: null, expiredAt: {$gt: now}}` arm, so a row with absent `isTemporary` and a
future `expiredAt` is invisible while still present in Mongo.

### C6 — Deleting a Chat Project cascade-deletes every conversation in it (S1, permanent)

`packages/data-schemas/src/methods/chatProject.ts:417-420` deletes all messages then all
conversations for the project. If the confirmation dialog does not make the cascade explicit,
users will read this as "my chats disappeared".

### C7 — `removeConvoFromAllQueries` desynchronises `pages` / `pageParams` (S1, recovers on reload)

`client/src/utils/convos.ts:576-600` ends with `.filter((page) => page.conversations.length > 0)`,
dropping empty pages from `data.pages` without removing the matching `data.pageParams` entry. In
TanStack Query v4 an infinite refetch replays `pageParams`, so the mismatch causes conversations to
be skipped or duplicated in the sidebar.

---

## Diagnosis plan (do this before changing any code)

The single most valuable discriminator is: **does a hard browser reload bring the messages back?**

- **Yes** → C2 / C3 / C7 (client cache).
- **No, conversation missing from list but openable by URL** → C1 (project filter) or C4 (pagination).
- **No, conversation 404s or its early messages are gone** → C5 (TTL) or C6 (project delete).

`GET /api/messages/:conversationId` applies **no limit and no retention filter**
(`packages/data-schemas/src/methods/message.ts:384-407`), so missing messages *inside* a
conversation after a reload mean the rows are physically gone from Mongo — not filtered, not
paginated.

### Read-only queries to run against the production Cosmos database

```js
// 1. Is anything actually carrying a TTL? (confirms/eliminates C5)
db.conversations.countDocuments({ expiredAt: { $ne: null } })
db.messages.countDocuments({ expiredAt: { $ne: null } })
db.conversations.countDocuments({ isTemporary: true })

// 2. Do the TTL indexes exist on Cosmos at all?
db.conversations.getIndexes()
db.messages.getIndexes()

// 3. Rows invisible to the sidebar but present in Mongo (C1 + the retention-filter gap)
db.conversations.countDocuments({ chatProjectId: { $ne: null } })
db.conversations.countDocuments({ isTemporary: null, expiredAt: { $ne: null } })

// 4. Orphaned messages whose conversation is gone (confirms deletion happened)
//    Run as an aggregation with $lookup on a sample, not a full scan.

// 5. Tenant landmine (Risk R1)
db.users.distinct('tenantId')
```

### Confirm with the reporting users

1. Does the chat reappear after a hard reload (Ctrl+Shift+R)?
2. Were they working inside a **Project** when the chat was created?
3. Is **Settings → Chat → "Default to temporary chat"** switched on for them?
4. Whole conversations missing from the list, or a conversation that lost its earlier messages?

### Also verify outside this repo

The live environment comes from `Knauf-Group/agk-deployment-configs`, **not** this repo. Confirm
`TEMP_CHAT_RETENTION_HOURS`, `SESSION_EXPIRY`, and any `interface.retentionMode` override there.

---

## Proposed fixes, in order

| # | Cause | Change | Tier |
|---|---|---|---|
| F1 | C2 | Hoist `QueryClient` out of the `App` render body into module scope (or `useState(() => new QueryClient(...))`). Make the `onError` 401 handler not re-render `App`. | 5 |
| F2 | C2 | Replace bare `queryClient.removeQueries()` in `useRefreshTokenMutation.onMutate` with a scoped removal (auth/user keys only), and move it to `onSuccess`. | 5 |
| F3 | C3 | Stop writing `[]` for the outgoing conversation in `clearMessagesCache`; clear only `NEW_CONVO`. Or drop `refetchOnMount: false` so a cleared entry re-fetches. | 5 |
| F4 | C4 | Fix the degenerate `$or` (use a distinct secondary key) and add `_id` as a sort tiebreaker so the cursor is total-ordered. | 5 |
| F5 | C1 | Make project-scoped chats discoverable from the main history — e.g. a project badge on the row, or an "All chats" toggle. UX decision needed. | 5 |
| F6 | C5 | Pin `retentionMode: 'temporary'` explicitly in `librechat.yaml` (guards against an upstream default flip — already an unchecked item in the privacy workstream). Make the Temporary Chat state visually obvious and consider not persisting it to localStorage. | 0 + 5 |
| F7 | C6 | Make the project-delete dialog state explicitly that N conversations will be permanently deleted. | 5 |
| F8 | C7 | Keep `pages` and `pageParams` in lockstep in `removeConvoFromAllQueries` (and the two sibling helpers in `convos.ts`). | 5 |

Every Tier-5 edit needs a `[knauf]` marker plus a `SEAMS.md` **append** (see
`.claude/skills/seam-manifest/SKILL.md`); several of these files already have rows.

## Risks / latent issues to file separately

- **R1 — tenant isolation.** If `user.tenantId` is ever populated, pre-tenancy conversations stop
  matching the injected filter and `saveConvo`'s `upsert: true` mints a **fresh tenant-stamped
  row** instead of conflicting, making all prior history unreachable. `TENANT_ISOLATION_STRICT` is
  unset, so this would fail **silently**. Needs a backfill migration before tenancy is enabled.
- **R2 — `DELETE /api/convos` filter-less path.** `convos.js:154-156` reaches
  `deleteConvos(user, {})` when `conversationId` is absent but `thread_id`/`endpoint` is present
  and `source !== 'button'`. Not reachable from the current UI, but it is a one-request
  wipe-my-entire-history endpoint. Harden the guard.
- **R3 — Meilisearch TTL orphans.** Mongo's TTL monitor deletes server-side, bypassing the
  mongoMeili middleware, and `indexSync.js` only reconciles when Meili is *behind* Mongo — never
  the TTL case where Meili is *ahead*. TTL-deleted conversations stay searchable.

## Verification

- `npm run test:client` and `npm run test:packages:data-schemas` for the touched units.
- Add regression tests: a cursor test asserting no conversation is skipped across a page boundary
  with tied `updatedAt`; a test that a 401 does not empty the query cache; a test that navigating
  away from and back to a conversation preserves its messages.
- Manual: open a chat, click New Chat, navigate back — messages must still render.
- Manual: leave a tab idle >15 min, refocus — the sidebar must keep its loaded pages.
- Build needs `NODE_OPTIONS=--max-old-space-size=8192` (known heap issue).

---

# UPDATE — empirical results from the live diagnostic (2026-09-11)

A read-only diagnostic was written and executed against the **local dev** MongoDB
(`chat-mongodb`, db `LibreChat`, 73 conversations / 459 messages). Script:
`<scratchpad>/diagnose-history-loss.js`. It makes no writes.

## C8 (NEW, and it reframes everything) — no schema index is ever created

`.env` contains `MONGO_AUTO_INDEX=` — **present but empty**. In `api/db/connect.js:24-27`:

```js
const autoIndex =
  process.env.MONGO_AUTO_INDEX != undefined
    ? isEnabled(process.env.MONGO_AUTO_INDEX) || false
    : undefined;
```

`"" != undefined` is **true**, and `isEnabled("")` is false, so `autoIndex` resolves to **`false`**
— not `undefined`. Mongoose therefore never creates **any** declared index. Verified on the live
local database:

```
=== conversations ===   _id_  key={"_id":1}
=== messages ===        _id_  key={"_id":1}
```

Only `_id_` exists. Three consequences:

1. **C5 is mechanically impossible in this environment.** There is no
   `{expiredAt: 1}, {expireAfterSeconds: 0}` index, so Mongo's TTL monitor has nothing to act on.
   TTL deletion cannot be the cause unless the index exists in the target environment.
2. **The unique index `{conversationId, user, tenantId}` does not exist**, so nothing enforces
   conversation uniqueness. `saveMessage`'s duplicate-key recovery path
   (`packages/data-schemas/src/methods/message.ts:199-229`, a `[knauf]` seam) depends on error
   code 11000, which that index is what raises. No duplicates locally yet (0/0), but the
   constraint is absent under concurrency.
3. **The sidebar list query has no supporting index.** `explain()` on the list query returns a
   blocking `SORT` stage — a collection scan plus an in-memory sort, every request. The declared
   `{user, chatProjectId, updatedAt:-1, _id:-1}` index is absent. This is a **scale-dependent**
   failure mode: it degrades as history grows and hits the heaviest users first, which fits
   "some users" and "after a while" better than any deletion mechanism does.

**This is environment-specific and must be re-checked per environment.** If dev/stage/prod set
`MONGO_AUTO_INDEX=true`, or indexes were created by an earlier deploy or by hand, then the TTL
indexes exist there and C5 becomes live again while C8 does not apply.

## Local diagnostic results

| Check | Result | Verdict |
|---|---|---|
| TTL indexes present | **NONE** on either collection | C5 **cannot fire here** |
| `expiredAt` set | 0 conversations, 0 messages | C5 clear |
| `isTemporary: true` | 0 conversations, 0 messages | Temporary Chat unused here |
| Conversations whose oldest messages expire before the conversation | 0 | erosion pattern absent |
| `chatProjectId` set | **1 of 73 (1.4%)** | C1 **LIVE** — real but low volume locally |
| `isTemporary` null + `expiredAt` set (filter blind spot) | 0 | clear |
| `(user, updatedAt)` ties | 0 | C4 exposed but not currently triggerable |
| Orphaned messages (convo deleted, messages survive) | 0 | no deletion has occurred |
| Conversations with zero messages | 0 | S2 has **not** persisted here |
| `users.tenantId` / `conversations.tenantId` | `[]` / `[]` | R1 **dormant**, confirmed |
| `isArchived: true` | 0 | not a factor here |

Caveat: 73 conversations is a developer sandbox. Absence of evidence here is weak evidence of
absence in production. The same script must be run against dev/stage/prod Cosmos.

## Revised ranking after evidence

1. **C1 — project filter** (confirmed present in data; permanent; no reload recovery)
2. **C8 — missing indexes** (confirmed; scale-dependent; best fit for "some users, after a while")
3. **C2 — QueryClient rebuilt on 401** (confirmed by code reading; recovers on reload)
4. **C3 — `clearMessagesCache` + `refetchOnMount:false`** (confirmed by code reading)
5. **C4 / C7** (real defects, not currently triggered in local data)
6. **C5 — TTL** (mechanically inert wherever `MONGO_AUTO_INDEX` is empty — **verify per env**)
7. **C6** — only if users actually delete Projects

## How to run the diagnostic elsewhere

```bash
# local
docker cp diagnose-history-loss.js chat-mongodb:/tmp/d.js
docker exec chat-mongodb mongosh "mongodb://127.0.0.1:27017/LibreChat" --quiet --file /tmp/d.js

# dev / stage / prod (Cosmos) — read-only, but NOT free
# Defaults to SAMPLE mode (5000-doc cap + 20s maxTimeMS per aggregation) because sections
# [1], [4] and [5] $lookup across collections. Read-only is not the same as low-cost on a
# large cluster. A sampled zero bounds the problem; it does not disprove it.
mongosh "<COSMOS_CONNECTION_STRING>" --quiet --file diagnose-history-loss.js

# Unsampled — agree a window with a DBA/operator first; do not just run this on prod.
mongosh "<COSMOS_CONNECTION_STRING>" --quiet --eval 'FULL=1' --file diagnose-history-loss.js
```

User ids are redacted by default; pass `SHOW_USERS=1` only when you need to contact the affected
users, and keep that output out of tickets.

The single most decisive line in the output is section **[1] TTL indexes**. If prod prints index
names there, C5 is live and takes priority over everything else.

---

# SUPERSEDING UPDATE — the Redis-streams mechanisms (2026-09-16)

Everything above predates the decisive clue. The product owner reported the symptom **does not
occur when `USE_REDIS_STREAMS=false`**. None of C1–C8 is gated on Redis, so **none of them explains
the reported behaviour**. They remain real defects worth fixing on their own merits, but they are
not this bug, and the ranking above should be read as superseded.

Three Redis-gated mechanisms were found and reproduced with automated tests.

## Why the flag gates it

The client never sees `USE_REDIS_STREAMS` — `useAdaptiveSSE.ts:25-38` routes to the resumable path
based only on "is this the assistants endpoint". What the flag changes is **server-side job
lifetime**:

| | In-memory (`false`) | Redis (`true`) |
|---|---|---|
| Job on completion | deleted immediately (`GenerationJobManager.ts:855`) | kept: `completed` TTL 300s, `running` TTL **1200s** (`RedisJobStore.ts:147-156`) |
| `/chat/status` on revisit | `{active: false}` → no resume | finds a job → builds a resume submission |
| The 404 / error / max-retry branches | effectively dead code | live |

Deployed replica counts are **2 (dev) / 2 (stage) / 3 (prod)** with `USE_REDIS=true`, so the
multi-replica mechanism below is live in every environment.

## M1 — the disconnect save never runs across replicas (permanent loss)

When a client disconnects mid-generation, the partial response is saved by a handler registered on
`onAllSubscribersLeft` (`GenerationJobManager.ts:433-473` → `api/server/controllers/agents/request.js:415`,
written with `unfinished: true`).

Those handlers live on **process-local** runtime state (`GenerationJobManager.ts:536-541`). The
cross-replica runtime built by `getOrCreateRuntimeState` (`:649-661`) omits
`allSubscribersLeftHandlers` and then guards invocation on that always-undefined field (`:678`).
Compounding it, `RedisEventTransport.getSubscriberCount` is documented local-only (`:699-719`), so
the generating replica never observes its count reach zero.

With Redis the job is shared, so `GET /agents/chat/stream/:streamId` can land on any replica. When
it lands on a **non-generating** one, neither replica fires the handler.

**Scope — important.** This alone does **not** mean every disconnect loses data. The controller
saves the response independently on the normal completion and abort paths
(`request.js:691`, `:700`). The loss window is **disconnect plus a terminal failure that skips
those saves** — a provider error (`request.js:857-859`, the only terminal path with no
`saveMessage`), or the generating pod dying. Within that window the streamed text exists only in
Redis and is lost with the job.

Verified against live Redis: replica B **can** reconstruct the partial response from the chunk
stream. The data is reachable; nothing asks it to save it.

The repo predicted this class of bug — `knauf/docs/architecture/redis-and-caching.md:22-24`:
> *"The fallbacks are correct on a single instance but wrong across multiple replicas — which is
> exactly the shape of bug that never reproduces on a laptop running without Redis."*

## M2 — the sidebar evicts a conversation the server kept

`removeConvoFromAllQueries` is called from three branches of `useResumableSSE.ts` (`:910-915`,
`:956-961`, `:1067-1072`), guarded by
`!createdStreamIdsRef.has(id) && optimisticStreamIdsRef.has(id)`.

That guard uses "did this socket observe a `created` frame" as a proxy for "is this conversation
unpersisted". A resumed stream **never** receives `created`: `subscribeWithResume` passes
`skipBufferReplay` (`GenerationJobManager.ts:1327-1331`) and the re-emit is gated on
`!skipBufferReplay` (`:1201-1231`) — the client gets a `sync` frame instead. So after any reconnect
the guard is permanently armed. `streamId === conversationId`
(`api/server/routes/agents/index.js:200`), so a real id is evicted, and `finalHandler` never
re-inserts it. Recovers on reload.

Related and still open: `isInitialNewConversationSubmission` (`useEventHandlers.ts:99-102`) is a
tree-root test (`parentMessageId === NO_PARENT`), not an "unpersisted" test, and gates a block that
also does `removeQueries([messages, id])` + `setMessages([])`.

## M3 — infinite-page desync

`removeConvoFromAllQueries`, `removeConvoFromInfinitePages` and `updateConvoFieldsInfinite`
(`client/src/utils/convos.ts`) dropped emptied pages without dropping the matching `pageParams`
entry. React Query v4 pairs `pages[i]` with `pageParams[i]` when replaying an infinite query, so the
next `fetchNextPage` ran against the wrong cursor — losing more conversations than the one removed.
Upstream's `convos.spec.ts` seeds `pageParams: []` in every fixture, which makes it invisible there.

## Reproduction

| Mechanism | Test |
|---|---|
| M1 cross-replica | `packages/api/src/knauf/stream/RedisGenerationLifecycle.stream_integration.spec.ts` — `allSubscribersLeft handlers across replicas` (needs live Redis) |
| M1 user outcome | `api/server/controllers/agents/__tests__/request.resumeMetadata.spec.js` — partial response persisted exactly once when the generation fails after a disconnect |
| M2 | `client/src/hooks/SSE/__tests__/useResumableSSE.spec.ts` — `[knauf] resumed stream never receives created` |
| M3 | `client/src/utils/convos.knauf.spec.ts` |

## Not a mitigation

`USE_REDIS_STREAMS=false` is **not** a fix. On multiple replicas it converts a silent non-save into
a loud intermittent 404, and it leaves M2 and M3 untouched. The original observation was almost
certainly made on a single replica, where in-memory is correct by construction because the POST and
the SSE necessarily hit the same process. Scaling to one replica would reduce exposure at the cost
of HA and would still leave both client defects live.

## Still open

- No reconciliation for orphaned generations: if the generating pod dies, the Redis job stays
  `running` with its chunks intact and nothing flushes them to Mongo. `getRunningJobs()` has no
  callers.
- A stale `running` job blocks new generations on that conversation with HTTP 409 for up to 20
  minutes.
- `RedisJobStore.cleanup()` reaps on `createdAt`, not last activity (`:572-577`), killing
  legitimately long generations at 20 minutes. The in-memory store reaps on inactivity.
- `emitChunk` persists chunks fire-and-forget (`GenerationJobManager.ts:1388-1393`).

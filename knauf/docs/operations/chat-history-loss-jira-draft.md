# Jira draft — Redis-streams chat-history loss

Paste-ready for the KK20 project. Shape agreed in review of PR #365: **one standalone Bug** for the
three confirmed mechanisms; the items under "Follow-up tickets" are filed separately. Delete this
file once the ticket is filed and the ID is recorded in the PR and the SEAMS rows.

---

**Title:** Chat messages and history lost when a stream disconnects across replicas

**Type:** Bug

**Priority:** High (silent user-data loss in production within a bounded, routinely hit window)

**Components:** api (Redis streams), client (sidebar and conversation cache)

**Summary**

Users report chat messages and whole conversations disappearing from history. The product owner
observed that the symptom does not occur with `USE_REDIS_STREAMS=false`, which narrowed it to the
resumable-streaming path. Three independent mechanisms were found, reproduced with automated tests,
and fixed in one PR.

1. **Cross-replica disconnect save (server, permanent loss).** When the user's SSE is served by a
   different replica than the one running the generation, the handler that saves the partial
   response on disconnect fired on neither replica. The controller still saves on normal completion
   and on user abort, so the loss window is a disconnect followed by a terminal failure with no save
   of its own: a provider error, or the generating pod dying. In that window the streamed text
   exists only in Redis and is lost with the job. Dev, stage and prod run 2/2/3 replicas with
   `USE_REDIS=true`, so the mechanism is live in every environment.
2. **Sidebar eviction (client, recovers on reload).** A resumed stream never receives the `created`
   frame, so the "unpersisted conversation" guard stays armed after any reconnect and a real
   conversation is removed from the sidebar on a stream error. It does not return until a full
   page reload.
3. **Infinite-page desync (client).** The conversation-list cache helpers drop emptied pages
   without dropping the matching `pageParams` entry, so the next page fetch runs against the wrong
   cursor and unrelated conversations vanish from the list.

`USE_REDIS_STREAMS=false` is not a fix: on multiple replicas it turns a silent non-save into an
intermittent 404. The reported correlation is a single-replica observation, where in-memory
streaming is correct by construction because the POST and the SSE hit the same process.

**Acceptance criteria**

- [ ] A client disconnect mid-generation persists the partial response exactly once, even when the
      SSE was served by a replica that did not start the generation.
- [ ] If the sole viewer's replica stops without unsubscribing (pod loss), the generating replica
      detects the lapsed lease on its own and persists the partial exactly once. It never fires
      before any viewer has attached.
- [ ] A disconnect followed by a provider failure persists the partial exactly once regardless of
      which completes first, the departure verification or the failure. Covered by an ordering
      regression that holds the departure verification, fails the provider, then releases it.
- [ ] The "all viewers left" decision uses all-replica membership, so a second tab on another
      replica does not trigger a premature save. The per-replica reconnect bookkeeping still fires
      synchronously on the replica whose viewer left.
- [ ] A conversation that exists on the server is never removed from the sidebar by a stream error;
      the sidebar re-syncs from the server instead.
- [ ] `pages` and `pageParams` stay the same length in every infinite-list cache helper.
- [ ] Mixed-version pods during a rolling deploy do not error against each other (new lease key and
      event name).
- [ ] Green: `packages/api/src/knauf/stream/RedisGenerationLifecycle.stream_integration.spec.ts`
      (needs live Redis), `api/server/controllers/agents/__tests__/request.resumeMetadata.spec.js`,
      `client/src/utils/convos.knauf.spec.ts`, and the `[knauf]` block in
      `client/src/hooks/SSE/__tests__/useResumableSSE.spec.ts`. No regression in the Redis stream
      suites, `useResumableSSE.spec.ts`, or upstream's `convos.spec.ts`.

**Notes and links**

- Investigation with file:line evidence and the hypotheses ruled out:
  `knauf/docs/operations/chat-history-disappearing-investigation.md`.
- Investigation, reproduction and fix ship together in PR #365 (agreed in review; merge once the
  remaining ordering blocker is fixed and CI is green).
- Server fix design, two departure signals. `onAllSubscribersLeft` stays process-local and
  synchronous (reconnect bookkeeping). New `onGlobalDeparture` fires when no replica holds a
  viewer, verified against Redis: one lease per replica scored by the Redis server clock, an epoch
  key as durable evidence that a viewer ever attached, once-per-epoch announcement, fail-closed with
  a grace window after Redis errors. Detection latency for a lost pod is `REDIS_STREAM_LEASE_TTL_MS`
  (default 30 s) plus one sweep (`REDIS_STREAM_LEASE_SWEEP_MS`, default a third of the TTL).
- Root causes at investigation time. (1) `GenerationJobManager` kept `allSubscribersLeft` handlers
  on process-local runtime state and built the cross-replica runtime without them;
  `RedisEventTransport.getSubscriberCount` was local-only, so the generating replica never saw its
  count reach zero. (2) `useResumableSSE.ts` evicts through `removeConvoFromAllQueries` behind
  `!createdStreamIdsRef.has(id) && optimisticStreamIdsRef.has(id)`; `subscribeWithResume` skips the
  `created` re-emit, so the guard stays armed; `streamId === conversationId`, so a real conversation
  id is evicted. (3) `removeConvoFromAllQueries`, `removeConvoFromInfinitePages` and
  `updateConvoFieldsInfinite` in `client/src/utils/convos.ts` drop pages but not `pageParams`;
  upstream's spec seeds `pageParams: []` in every fixture, so it never showed.
- Also found, environment-specific: `MONGO_AUTO_INDEX=` present but empty disables every declared
  index (only `_id_` existed locally). Re-check per environment; see the investigation doc.

**Follow-up tickets (separate, not part of this Bug)**

1. Orphaned-generation recovery: when the generating pod dies, the Redis job stays `running` with
   its chunks intact and nothing flushes them to Mongo; `getRunningJobs()` has no callers.
2. Stale-running-job blocking: a stale `running` job answers new turns on that conversation with
   HTTP 409 for up to 20 minutes.
3. Cleanup timing: `RedisJobStore.cleanup()` reaps on `createdAt` rather than last activity, so a
   legitimately long generation is killed at 20 minutes; the in-memory store reaps on inactivity.
4. Fire-and-forget chunk durability: `emitChunk` persists chunks without awaiting; a crash right
   after can lose the chunk.

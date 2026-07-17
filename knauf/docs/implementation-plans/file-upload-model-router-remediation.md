# Plan: File Upload and Model Router Remediation

**Generated:** 2026-07-17  
**Status:** Ready for implementation  
**Owner:** Agentic Karl maintainers  
**Primary environment:** Development  
**Production promotion:** Blocked until the exit criteria below pass

## Objective

Make the Azure Foundry model-router and file-upload paths predictable under normal and concurrent use. The work must bound stalled model calls, route pasted documents through the same retrieval path as selected documents, isolate unsaved drafts between tabs, account for router cost conservatively, and remove avoidable telemetry amplification.

This plan is based on browser testing in development plus Datadog APM, Langfuse, and Azure metrics. It addresses confirmed product defects and explicit validation gaps. Account bans and authentication policy are out of scope.

## Current evidence

| Area | Result | Evidence and implication |
|---|---|---|
| Default KARL through Model Router | Pass with intermittent failures | Normal prompts and file questions completed, but two calls waited about 300 seconds for response headers (`UND_ERR_HEADERS_TIMEOUT`); Azure recorded a 408 and an aborted 499. |
| PR #144 upload/stream race | Pass | Five uploads started during an active answer remained pending after the answer completed. Keep this behaviour under regression test. |
| File persistence | Pass | File cards and responses survived reload. Large PDFs, including a 4.8 MB/46-page file, completed. |
| Model/embedding quota | Pass in observed window | No model or embedding 429 occurred. Capacity must not be increased again without new evidence. |
| Clipboard document routing | Fail | A byte-identical pasted PDF produced two Azure blobs and bypassed File Search because the paste path omitted `tool_resource=file_search`. |
| Attachment limit feedback | Fail | Only five of seven pending files were accepted; the remaining files were silently ignored. |
| New-chat tab isolation | Fail | Multiple `/c/new` tabs shared the `PENDING` local-storage draft. Text from one tab appeared in another. |
| Router cost attribution | Fail | The primary Responses stream reported `model-router`, so the main token usage was not priced. Only secondary calls were included. |
| Langfuse media handling | Degraded | The same PDF was uploaded to Langfuse media repeatedly, creating unnecessary network and storage traffic. |
| Blob container setup telemetry | Degraded | Uploads repeatedly called container `createIfNotExists`; expected 409 responses were recorded as APM errors. |
| Foundry embedding path | Not validated by automation | In-app browser automation pasted files and produced zero `text-embedding-3-large` requests. A real file chooser test is required. |
| Custom-agent retrieval | Partially validated | A message attachment returned a citation, but persistent Agent Builder knowledge was not exercised by the automated run. |

## Decisions

1. Keep Azure Responses API. Hosted web search and file tools depend on it.
2. Keep the existing five-file limit until load evidence supports changing it. Make rejection visible instead of silently dropping files.
3. Do not change router provider pool or Azure quota in this workstream. No 429 was observed.
4. Treat router cost as estimated when Azure does not identify the selected backing model. Under-counting is not acceptable.
5. Keep persistent Agent Builder knowledge and per-message attachments as separate lifecycles:
   - Message document: user-scoped File Search/RAG attachment.
   - Agent Builder knowledge: agent-scoped persistent knowledge.
6. Use one application PR with logically separated commits. Add a deployment-config PR only if runtime configuration is actually required.

## Work package 1: Bound model-router failures

### 1.1 Capture the failing request lifecycle

Instrument the Foundry Responses request boundary with fields already safe to log:

- request/stream ID
- conversation ID hash or existing non-PII correlation ID
- configured deployment alias
- attempt number
- time to first response event
- final status: completed, timed out, aborted, provider error
- provider status code and Azure request ID when available

Never log prompts, file contents, API keys, access tokens, or raw user identifiers.

### 1.2 Add a bounded per-attempt timeout

Add cancellation at the application request boundary used by the Azure Responses stream. Start with a development candidate between 90 and 120 seconds, based on the observed successful maximum near 41 seconds, then select the final value from replay/load evidence.

- Abort the provider request and close the SSE lifecycle on timeout.
- Allow at most one retry, and only before any assistant content or tool side effect has been emitted.
- Apply jittered backoff to the retry.
- Return a clear retryable error instead of leaving an empty assistant message for five minutes.
- Ensure user cancellation and timeout share one idempotent cleanup path.

### 1.3 Tests and acceptance

- Unit test: timeout aborts the provider request and closes the stream.
- Unit test: one pre-content timeout retries once.
- Unit test: no retry after content or a tool side effect starts.
- Unit test: user abort does not become a provider-timeout error.
- Integration test: delayed mock headers cannot exceed the configured total bound.
- Development replay: no request remains open beyond the selected timeout plus retry/backoff budget.
- Datadog: timeout, retry, abort, and eventual result correlate under one request/stream ID.

## Work package 2: Correct router cost attribution

### 2.1 Inspect the final Responses metadata

Capture the shape, not the content, of the final Azure Responses event in development. Confirm whether an underlying model/version appears in the final response, response headers, or Azure metadata. Add a focused parser test using the observed payload shape.

### 2.2 Price deterministically

Resolve cost in this order:

1. Exact backing model and version returned by Azure.
2. Normalised model family returned by Azure, using the effective-dated application price table.
3. If Azure reports only `model-router`, use the highest input/output price among the allowed router pool and mark the transaction `estimated=true` with reason `router_model_unreported`.

Do not assign a zero price to a supported router transaction. Keep unsupported token categories explicit rather than silently discarding them.

### 2.3 Tests and acceptance

- Parser tests cover exact version, model family, router-only, and unknown values.
- Cost tests cover input and output tokens without requiring caching support.
- One routed development conversation has non-zero primary-call cost.
- The transaction records whether the amount is exact or estimated.
- Conversation total equals the sum of primary and secondary calls.
- Cost calculation does not add network calls to the request path.

## Work package 3: Make document routing consistent

### 3.1 Route pasted documents like selected documents

Update the paste path in `client/src/hooks/Input/useTextarea.ts` so non-image documents receive the same effective tool resource as the normal KARL upload menu and drag/drop path. Images remain direct multimodal attachments where supported.

Keep `client/src/hooks/Files/useFileHandling.ts` as the single form-data builder. It must send both:

- `message_file=true`
- `tool_resource=file_search` for a message document that should enter File Search

Do not attach pasted message documents to an agent's persistent `tool_resources`.

### 3.2 Preserve server-side content deduplication

The existing server deduplication in `api/server/services/Files/process.js` should remain authoritative. Once paste routing supplies `file_search`, verify that byte-identical files from the same user reuse the existing asset rather than creating a second blob and embedding job.

### 3.3 Make the five-file limit visible

Keep the cap at five. When an action would exceed it, show one localised notification containing:

- number accepted
- maximum allowed
- number rejected

The accepted files must remain attached. The control must not shift layout or clear existing pending uploads.

### 3.4 Tests and acceptance

- Paste test: PDF is assigned `file_search`; image is not forced into document retrieval.
- Menu, drag/drop, and paste tests assert equivalent document metadata.
- Boundary tests cover 5, 6, and 7 selected files and the notification content.
- Same-user duplicate test: sequential byte-identical documents reuse one shared asset.
- Same-turn duplicate test: duplicate documents do not create duplicate visible attachments.
- Cross-user test: deduplication never exposes another user's file record or permissions.
- Development evidence: one document upload produces the expected Blob, embedding, vector-store, and citation lifecycle.

## Work package 4: Isolate new-chat drafts by browser tab

`client/src/hooks/Input/useAutoSave.ts` currently uses one local-storage key for `Constants.PENDING_CONVO`. Store unsaved `PENDING` text and file state in `sessionStorage`, which is isolated per tab. Continue using the existing persistent storage behaviour for real conversation IDs.

Preserve the transition from `PENDING` to the created conversation ID so PR #144's in-flight upload state survives conversation creation.

### Tests and acceptance

- Two `/c/new` tabs retain independent text and pending-file drafts.
- Reloading one tab restores that tab's draft.
- Creating the conversation migrates only that tab's pending state.
- Completing an active response does not clear uploads added during the response.
- Closing one tab cannot clear another tab's pending state.

## Work package 5: Remove telemetry amplification and false errors

### 5.1 Langfuse media deduplication

First confirm whether the installed Langfuse callback emits the same media ID repeatedly across observations. Prefer an upstream SDK fix if one is already present in a compatible release. Otherwise, deduplicate per trace and media ID at the existing Knauf integration boundary.

- A telemetry-media failure must never fail the chat or file upload.
- Do not suppress the primary trace or token/cost observation.
- Record a counter for skipped duplicate media attempts.

Acceptance: one source file produces at most one Langfuse media upload per trace, with before/after request and byte counts recorded.

### 5.2 Blob container initialisation

Ensure the configured Azure Blob container once per process using a shared promise or existing client initialisation lifecycle. Do not call `createIfNotExists` for every file.

Acceptance:

- Concurrent first uploads share one initialisation request.
- Warm uploads issue no container-create request.
- Expected "already exists" does not appear as an application error after warm-up.
- A real container creation failure remains visible and fails safely.

## Work package 6: Validate the real retrieval paths in development

Browser clipboard automation cannot validate the embedding path. Run this gate with a real browser file chooser or an equivalent authenticated API flow.

### Validation matrix

| Scenario | Expected storage/retrieval path | Required evidence |
|---|---|---|
| KARL message PDF | User-scoped Blob plus File Search/vector path | Upload completes, embedding metric increments, answer cites file, delete cleanup succeeds. |
| Duplicate KARL PDF | Existing same-user asset reused | No second Blob or embedding job; both message references work. |
| Custom-agent message PDF | User-scoped message retrieval | Agent answer cites the attachment without mutating persistent Agent Knowledge. |
| Agent Builder knowledge PDF | Agent-scoped persistent knowledge | Saved agent can retrieve it in a new conversation; another user cannot access it without agent permission. |
| Five concurrent uploads | Five independent terminal states | No disappearing cards, cancelled prior answer, or orphaned upload. |
| Six-file attempt | Five accepted, one rejected visibly | Notification appears and accepted uploads continue. |
| Routed prompt with web search | Azure Responses hosted web search | Tool result succeeds and router timeout/cost fields are present. |

For every scenario, correlate browser action, application logs, Datadog trace, Langfuse trace, Azure request metrics, and the relevant database/file records. Sanitise all captured evidence.

### Load smoke

Use multiple test identities or a dedicated harness; one UI account is limited by the two-concurrent-message guard and cannot represent platform concurrency.

- Mixed workload: short chats, web search, one-file retrieval, five-file upload.
- Record p50/p95/p99 time to first token and completion.
- Record timeout, retry, 408, 429, 499, and 5xx counts.
- Record embedding throughput and queue time.
- Stop and investigate on data loss, permission leakage, or repeated empty streams.

## Pull request and rollout sequence

1. **Agentic Karl application PR:** work packages 1-5, split into reviewable commits but delivered as one PR.
2. **Development release:** deploy the application PR to development.
3. **Deployment-config PR only if needed:** add timeout/config values only when a runtime knob is preferable to the existing configuration pattern.
4. **Development validation:** complete work package 6 and attach sanitised evidence to the application PR or release ticket.
5. **Production promotion:** use the same tested image digest and environment-specific Foundry resource configuration.

No `agk-infrastructure` PR is expected unless development evidence shows a real quota, deployment, or private-network defect.

## Production exit criteria

- Router requests have a tested upper time bound and an actionable user-visible failure.
- No retry can duplicate assistant content or tool side effects.
- Routed primary calls have non-zero cost marked exact or conservative estimate.
- Paste, menu, and drag/drop route documents consistently.
- Byte-identical same-user documents do not create duplicate Blob/embedding work.
- New-chat drafts are isolated between tabs.
- The five-file cap never rejects silently.
- Real KARL and custom-agent retrieval paths produce expected embeddings and citations.
- PR #144 upload-during-stream behaviour remains green.
- No embedding/model 429 occurs in the agreed development smoke window; if it does, capture measured demand before changing capacity.
- Langfuse and Blob telemetry no longer amplify one upload into repeated media/container requests.

## Rollback

Rollback is an application image/config reversion. The timeout, draft-storage, upload-routing, cost, and telemetry changes require no data migration. Existing files remain readable. If paste routing must be reverted, retain the visible error rather than silently presenting pasted documents as searchable.

## Non-goals

- Account-ban or authentication-policy changes.
- Increasing Azure quota without measured throttling.
- Changing the Model Router provider pool.
- Replacing Azure Responses API with Chat Completions.
- Increasing the five-file UI limit.
- Redesigning the full retrieval ranking or agent graph architecture.
- Merging Agent Builder persistent knowledge into per-message attachment storage.

# KARL Runtime Limits

Last audited: 2026-10-06

This reference inventories operational limits enforced by the `agentic-karl`
repository: upload ceilings, model and agent budgets, Code Adapter guardrails,
rate limits, retention, background-worker bounds, timeouts, and CI safeguards.

It does **not** replace deployed configuration. GitOps, Terraform, Azure,
Kubernetes, ArgoCD, and provider platform limits remain authoritative for
environment-specific values. Recheck the owning source before describing a
value as current in dev, stage, or prod.

## How to read the inventory

There is no single KARL file-size, timeout, or concurrency limit. A request can
cross several layers, and the effective limit is normally the smallest
applicable value.

The `Authority` column uses these categories:

- **Committed policy**: active application policy in `librechat.yaml`.
- **Code default**: used unless an environment variable or deployment value
  overrides it.
- **Environment example**: documented default in `.env.example`; deployment
  configuration may differ.
- **Platform ceiling**: imposed by Azure, Node, a provider, or a shared
  transport layer.
- **CI-only**: affects validation workflows, not production traffic.

Unless a row explicitly says otherwise, numeric environment settings are
configurable. Zero is not a universal "disabled" value:

- file-policy count and aggregate limits use `0` to disable that policy layer;
- selected intervals use `0` to disable the scheduled action;
- many Code Adapter positive-integer parsers reject zero and fall back to their
  default;
- Redis retry attempts use `0` for unlimited retries.

The repository sometimes labels binary byte values as MB. This document uses
MiB where the code value is based on 1,048,576 bytes.

## File upload and processing

| Limit | Value | Authority | Source | Rationale and interaction |
| --- | ---: | --- | --- | --- |
| Chat files per send | 5 | Client-side committed policy | `librechat.yaml` `fileConfig.endpoints.azureOpenAI.fileLimit`; `client/src/utils/files.ts` | UX guard in the supported client; direct API callers are not server-enforced by this count setting. |
| Chat aggregate per send | 100 MiB | Client-side committed policy | `librechat.yaml` `totalSizeLimit`; `client/src/utils/files.ts` | Bounds one client submission. It must not be reused as a server-side filter for an agent's complete conversation history. |
| Agent file count policy | Unlimited (`0`) | Client-side committed policy | `librechat.yaml` `fileConfig.endpoints.agents.fileLimit`; `client/src/utils/files.ts` | Long-lived agent conversations and knowledge can accumulate files; direct API callers are not constrained by this count setting. |
| Agent aggregate policy | Unlimited (`0`) | Client and agent-initialization policy | `librechat.yaml` `fileConfig.endpoints.agents.totalSizeLimit`; `packages/api/src/files/filter.ts` | Prevents older files disappearing when the server prepares accumulated agent history. |
| Endpoint per-file backstop | 50 MiB | Committed policy | `librechat.yaml` `fileSizeLimit` | Broad backstop; the category limits below normally bind first. |
| Document file | 25 MiB | Code default | `packages/data-provider/src/file-config.ts` | Bounds parsing, OCR, and embedding cost. |
| Data/spreadsheet file | 50 MiB | Code default | `packages/data-provider/src/file-config.ts` | Allows larger CSV/XLSX analysis while bounding memory and transfer. |
| Raster image | 20 MiB | Code default | `packages/data-provider/src/file-config.ts` | Bounds image decoding and model payloads. |
| SVG file/source | 8 MiB | Code default | `packages/data-provider/src/file-config.ts` | Bounds XML parsing and browser artifact rendering. |
| Shared multipart file | 512 MiB | Platform/shared default | `packages/data-provider/src/file-config.ts` `serverFileSizeLimit` | One Multer instance serves several routes, so this cannot safely be lowered for chat alone. |
| Avatar | 2 MiB | Code default | `api/server/services/Files/process.js` | Bounds profile-image processing and storage. |
| Skill archive import | 50 MiB | Code default | skills import route and parser | Bounds ZIP buffering and extraction. |
| Extracted file text | 100,000 tokens | Code default | file extraction configuration | Prevents one file from consuming the complete context budget. |
| Expired-file sweep | 100 files per pass, hourly | Code default | `packages/api/src/files/sweep.ts` | Incremental deletion avoids a large storage burst; interval `0` disables the sweep. |
| Audit-log retention sweep | Off unless `KNAUF_AUDIT_RETENTION_DAYS` is set (recommended 365); dry-run by default; 6 h cadence; fenced lease TTL 10 min (floor 30 s); newest row per chain always retained | Env, per environment (GitOps) | `packages/api/src/knauf/audit/retention.ts`; `packages/data-schemas/src/knauf/audit/methods.ts`; `.env.example` | Deletes a contiguous `seq` prefix per audit chain through upstream `purgeAuditLogEntries`, always bounded by a retained row (the newest row is the chain anchor and outlives the window until superseded); one pass per lease holder across all replicas, with a boot-storm guard of half the cadence; the cutoff is `now − days`, so the effective retention is `days` plus at most one cadence interval. A pass over the low-volume admin log takes seconds; there is no per-pass row cap because the delete is one contiguous-prefix `deleteMany`. Interval `0` disables the in-process scheduler (CronJob mode via `npm run audit:retention:sweep`). |
| Signed URL TTL | At most 7 days | Code default | Azure/S3 file strategy implementations | Limits bearer-URL exposure; refresh checks use half-TTL with a one-minute floor. |

### Upload interaction example

A 40 MiB PDF is below the 50 MiB endpoint backstop and the 100 MiB chat
aggregate, but it is rejected by the server-enforced 25 MiB document-category
limit. In the supported client, five 25 MiB documents satisfy the count and
per-file limits but exceed the 100 MiB aggregate UX guard. Agent policy
deliberately has no count or aggregate ceiling, while the same server-side
per-file category limits still apply.

## Code Adapter and sandbox

The Code Adapter values below are defaults from
`knauf/code-adapter/src/config.ts`. GitOps can override them. Most use a
positive-integer parser, so zero or an invalid value restores the default rather
than disabling the limit.

| Limit | Default | Source/key | Rationale |
| --- | ---: | --- | --- |
| Staging upload file | 128 MiB | `UPLOAD_MAX_BYTES` | Matches the practical ACA session-pool file API ceiling. |
| Upload batch | 32 files, 256 MiB of file bytes | `UPLOAD_BATCH_MAX_FILES`, `UPLOAD_BATCH_MAX_TOTAL_BYTES` | Bounds ephemeral disk and transfer work; decoupled from the capture cap so a skill with many bundled files still primes (0.4.0). Enforced while the body is parsed, so a chunked request without Content-Length stops at the budget instead of spooling every file to disk; the early declared-length check allows 64 KiB plus 8 KiB per file of multipart framing on top. |
| Execution inputs mounted | 32 files | `EXEC_INPUT_MAX_FILES` | Ranked selection (0.4.0): files the code names always mount, the newest of the rest fill the budget, and omissions are reported to the model. `EXEC_INPUT_SELECTION=strict` restores the old reject. |
| Execution input refs | 256 per request | `EXEC_INPUT_MAX_REFS` | Hard ceiling on the file list one request may carry. |
| Un-named execution inputs | 64 MiB, 30-second push budget | `EXEC_INPUT_OPTIONAL_MAX_BYTES`, `EXEC_INPUT_PUSH_BUDGET_MS` | Pushes are strictly sequential, so the optional tail is bounded in bytes and time. |
| Directory siblings mounted unconditionally | 16 files, 32 MiB | `EXEC_INPUT_SIBLING_MAX_FILES`, `EXEC_INPUT_SIBLING_MAX_BYTES` | Siblings of a file the code names (skill helpers, fonts) skip the optional cap and the push budget, so they are bounded on their own; the overflow competes as optional input and is reported if left out (0.4.0). |
| Execution input file | 128 MiB | `EXEC_INPUT_MAX_FILE_BYTES` | Matches the upload ceiling. |
| Aggregate execution input | 256 MiB | `EXEC_INPUT_MAX_TOTAL_BYTES` | Bounds memory and transfer pressure for one execution. |
| Active executions | 4 per process | `EXEC_MAX_ACTIVE_REQUESTS` | Rejects with HTTP 429 rather than building an unbounded in-process queue. |
| Aggregate in-flight input | 512 MiB per process | `EXEC_MAX_INFLIGHT_INPUT_BYTES` | Protects the Node process across concurrent executions. |
| Code body | 256 KiB | `CODE_MAX_BYTES` | Prevents oversized generated programs and request bodies. |
| Arguments | 100, 8 KiB each | Hard-coded validation in `routes/exec.ts` | Bounds wrapper and command construction. |
| Identity/session fields | 4 KiB each | execution request validation | Bounds metadata and log exposure. |
| Stdout/stderr | 64 KiB each | output limits | Bounds tool responses; the wrapper initially inlines smaller excerpts. |
| Captured output count | 20 files | `CAPTURE_MAX_FILES` | Bounds sandbox scans and downloads. |
| Post-exec manifest | 500 entries; dotfiles, `__pycache__/` and `*.pyc` skipped | `EXEC_MANIFEST_MAX_ENTRIES`, `CAPTURE_IGNORE_HIDDEN` | Tool litter (LibreOffice locks and profiles, bytecode) would otherwise be delivered and fill the manifest before real deliverables (0.4.0). |
| Aggregate captured output | 256 MiB | `CAPTURE_MAX_TOTAL_BYTES` | Bounds Blob transfer and response construction. |
| Capture phase | 60 seconds | `CAPTURE_MAX_TOTAL_MS` | Prevents sequential file operations extending a request for many minutes. |
| Total adapter request | 300 seconds | `EXEC_TOTAL_TIMEOUT_MS` | End-to-end deadline across staging, execution, capture, and cleanup. |
| ACA execution operation | 230 seconds | `ACA_EXEC_TIMEOUT_MS` | Leaves room around the platform's roughly 220-second useful execution ceiling. |
| ACA file operation | 30 seconds | `ACA_FILE_OP_TIMEOUT_MS` | Bounds each upload/download operation. |
| Session deletion | 10 seconds | `ACA_SESSION_DELETE_TIMEOUT_MS` | Cleanup cannot delay the response indefinitely. |
| LibreChat helper | 350 seconds | `CODE_EXEC_HELPER_TIMEOUT_MS` | Must exceed the adapter's complete request deadline. |
| Visual-QA images | 8 per response, 4 MiB each; off by default | `KNAUF_CODE_VISUAL_QA_MAX_IMAGES`, `KNAUF_CODE_VISUAL_QA_ENABLED` (LibreChat) | Each image costs roughly 1k input tokens and mid-run images bypass the Langfuse image guard (KK20-397). |
| Skill-file cache reuse | Needs 1 hour of staging life left; off by default | `KNAUF_CODE_SKILL_FILE_CACHE` (LibreChat) | A reused staged copy must outlive the run that mounts it (KK20-397). |
| Preview extraction | 60 seconds | preview finalization | Expensive or failed previews become download-only. |
| Staged-file retention | 24 hours, sliding | `FILE_TTL_HOURS` | Files survive multiple executions but eventually expire. |
| Reaper | Hourly, 120-second lease | reaper configuration | Allows one replica to clean storage without duplicate work. |
| Reconciliation | Daily; 100 rows/page; 10 pages; 30 seconds | reconciliation configuration | Bounded repair of Blob/Table inconsistencies. |
| Conditional table writes | 5 attempts | storage configuration | Handles optimistic-concurrency collisions without infinite retries. |
| Adapter JWT | 300-second age, 5-second tolerance | JWT configuration | Short-lived request capability with minor clock-drift allowance. |
| Readiness | 30-second cache, 10-second refresh timeout | readiness configuration | Avoids repeated Azure probes while still detecting failures. |

Deployment documentation may show intentional overrides, such as a 64 MiB
capture ceiling or a 2 GiB pod limit. Treat those as examples until verified in
the current `agk-deployment-configs` values and rendered ArgoCD manifest.

## Models, agents, tools, and memory

| Limit | Value | Authority/source | Rationale |
| --- | ---: | --- | --- |
| Agent graph recursion | 25 default, 50 hard maximum | Committed policy, `librechat.yaml` | Emergency fuse for repeated model/tool turns. |
| Distinct File Search queries | 3 per run | Committed policy, `librechat.yaml` | Exact repeats reuse work; unique retrieval fan-out is bounded. |
| File Search retrieval | 10 results/query | Code default | Bounds retrieval payload and context expansion. |
| Citations | 30 total, 7/file | Code default | Preserves source diversity without flooding the answer. |
| Explicit subagents | 10 per parent | Code default | Bounds fan-out. |
| Subagent depth | 5 | Code default | Prevents recursive agent trees. |
| Unique graph nodes | 50 | Code default | Bounds total graph size. |
| Expanded run configurations | 100 | Code default | Bounds serialized run requests. |
| KARL context | 256,000 tokens | Committed policy, `librechat.yaml` | Fits every configured Model Router candidate with headroom. |
| KARL output | 8,192 tokens | Committed policy, `librechat.yaml` | Cost and runaway-output fuse, including reasoning tokens. |
| Prompt drafting output | 1,500 tokens | Committed policy, `librechat.yaml` | Keeps generated agent instructions concise. |
| Model Router request / stream idle | 60 seconds | Committed policy, `librechat.yaml`; `packages/api/src/agents/run.ts` | Bounds time to initial provider response and the idle interval between streamed response chunks. |
| Model Router retry | 1 logical retry | Committed policy, `librechat.yaml`; `packages/api/src/knauf/agents/modelRouterRetry.ts` | Disables nested SDK retries and uses one observable same-provider fallback. Retry is suppressed after visible output, provider-side tool activity, caller cancellation, or a deterministic failure. |
| Stored memory context | 2,000 tokens | Committed policy | Prevents memory from consuming the main conversation budget. |
| Memory message window | 5 messages | Committed policy | Bounds extraction input. |
| Memory value | 10,000 characters | Committed policy | Bounds one stored memory. |
| Memory key | 1,000 characters | Schema/code default | Defensive metadata bound. |
| Memory model input | 12,000 tokens | Code default | Bounds the memory request. |
| Memory HTTP body | 100 KiB | Route limit | Protects the memory endpoint. |
| Web search | 20 results; 1-3 chunks/source; up to 120 seconds | Code/provider configuration | Bounds cost, context growth, and latency. |
| Open URL | 5 MiB; 10 seconds; 5 redirects | `api/app/clients/tools/structured/openUrl/fetcher.js` | Bounds remote content and redirect abuse. |
| HTML DOM parse | 2 MiB | HTML extraction code | Larger pages use lighter extraction to avoid expensive DOM construction. |
| PDF access probe | 10 seconds; first 1,024 bytes | PDF file processing | Detects inaccessible or encrypted PDFs without downloading indefinitely. |
| Mermaid PNG | 8,192 px/dimension; 16 million pixels | `client/src/knauf/components/Mermaid/KnaufMermaidControls.tsx` | Prevents browser canvas memory failures. |
| Artifact revision inferred gap | 1,000 missing versions | Code default, `api/server/services/Artifacts/knauf/edit.js` `MAX_INFERRED_MISSING_REVISIONS` | Rejects untrusted legacy version outliers with `invalid_revision` before dense history traversal or allocation. Fully persisted revisions do not count toward this ceiling and remain uncapped. |

## Authentication, rate limiting, and abuse prevention

Values in `.env.example` document defaults and supported configuration, not
proof of the currently deployed environment.

| Surface | Default | Source | Rationale |
| --- | ---: | --- | --- |
| Login | 7 attempts / 5 minutes | `LOGIN_MAX`, `LOGIN_WINDOW` | Brute-force protection. |
| Registration | 5 / 60 minutes | `REGISTER_MAX`, `REGISTER_WINDOW` | Account-creation abuse protection. |
| Concurrent messages | 2 per user, enabled | `CONCURRENT_MESSAGE_MAX` | Prevents one user monopolizing model/tool capacity. |
| Message IP | 40/minute, enabled | `MESSAGE_IP_*` | Broad request-abuse protection. |
| Message user | 40/minute, disabled in example | `MESSAGE_USER_*` | Optional per-account request protection. |
| Upload/import | 100/IP and 50/user per 15 minutes | limiter code | Protects storage and parsing services. |
| Conversation fork | 30/IP and 7/user per minute | limiter code | Prevents database amplification. |
| Speech-to-text | 100/IP and 50/user per minute | limiter code | Protects provider and upload capacity. |
| Password reset | 2 per 2 minutes | limiter code | Prevents reset-email abuse. |
| Email verification | 2 per 2 minutes | limiter code | Prevents verification-email abuse. |
| Artifact export | 10/minute | artifact limiter | Bounds browser-rendering/export work. |
| Shared artifact continuation | 10/minute | artifact limiter | Bounds shared-session generation. |
| Ban threshold | Every 20 violation points | `BAN_INTERVAL` | Aggregates repeated policy violations. |
| Ban duration | 2 hours | `BAN_DURATION` | Temporary containment without permanent lockout. |
| Access session | 15 minutes | `SESSION_EXPIRY` | Limits exposure of an active session token. |
| Refresh session | 7 days | `REFRESH_TOKEN_EXPIRY` | Bounds persistent login lifetime. |
| Reset/verification token | 15 minutes | authentication services | Short-lived email capabilities. |
| OpenID expiry buffer | 30 seconds | OpenID authentication | Avoids reusing a token too close to expiry. |

Rate-limit toggles and numeric values are separate. A configured number does not
mean the limiter is active unless its corresponding enable flag is true.

## Async indexing and RAG

| Limit | Default | Source | Rationale |
| --- | ---: | --- | --- |
| Queue admission per user | 50 files or 500 MiB | indexing admission | Backpressure before accepting more OCR/embedding work. |
| Synchronous embedding | 300 seconds, 3 attempts | `api/server/services/Files/VectorDB/crud.js` | Prevents uploads hanging indefinitely while tolerating transient failures. |
| Retry backoff | 1-30 seconds; `Retry-After` capped at 60 seconds | Vector DB client | Bounded provider-pressure recovery. |
| RAG deletion | 60 seconds, 3 attempts | Vector DB client | Reduces leaked vectors during transient failures. |
| Worker embedding | 30 minutes | `indexingWorker.js` | Async OCR can legitimately exceed the synchronous deadline. |
| Worker lease | 5 minutes | `indexingWorker.js` | Enables recovery after worker crashes. |
| Worker heartbeat/poll | 30 seconds / 5 seconds | `indexingWorker.js` | Maintains ownership while balancing queue latency and DB load. |
| Worker attempts | 5 general, 2 authentication | `indexingWorker.js` | Avoids repeatedly running permanently invalid work. |
| Worker backoff | 10 seconds-10 minutes | `indexingWorker.js` | Full-jitter exponential retry. |
| Worker shutdown | 60 seconds | `api/server/worker.js` | Allows in-flight work to settle. |
| Reconciliation | Every 15 minutes; 100 records/case | `indexingReconciler.js` | Bounded repair of queue and storage state. |
| Stale upload | 1 hour | `indexingReconciler.js` | Distinguishes abandoned uploads from slow legitimate ones. |
| Stale lease alert | 30 minutes | `indexingReconciler.js` | Detects a queue that is no longer draining. |
| Orphan asset | 24 hours | `indexingReconciler.js` | Avoids deleting records during short metadata races. |
| Delete retry | 15 minutes | `indexingReconciler.js` | Allows transient storage failures to recover. |
| Migration batch | 500 | indexing migration | Keeps migration cursor-resumable and bounded. |
| Meilisearch reconciliation | Every 15 minutes; 30-minute lease; 60-second renewal; 5-second safety window; startup acquisition does not wait; optional waiters poll every 2 seconds; 3 release attempts with 100 ms backoff | `api/db/indexSync.js`, `api/knauf/db/meiliSyncLock.js` | One API replica owns each shared-index inspection and rebuild. Disabled startup returns before coordination, and startup followers skip when another replica owns the lease. Periodic followers also skip duplicate checks. A replica exits before lease expiry if ownership cannot be renewed, preventing stale work from overlapping a replacement holder. Release errors are surfaced after bounded retries. |
| Meilisearch task acknowledgement | 10-second polling requests, repeated until terminal; 250 ms task poll interval | `api/db/indexSync.js`, `packages/data-schemas/src/models/plugins/mongoMeili.ts` | Reconciliation retains ownership while Meilisearch applies settings, cleanup, and bulk-index tasks. SDK polling timeouts continue without releasing the lease; provider errors and failed/cancelled tasks fail reconciliation for retry. |
| Meilisearch bulk reconciliation | Estimated submission cohorts plus 10 retry passes; submission defaults to the 100-document acknowledgement size and is capped at 1,000; Mongo acknowledgement is capped at 100; delay defaults to 100 ms and is capped at 60 seconds | `packages/data-schemas/src/models/plugins/mongoMeili.ts`; `MEILI_SYNC_SUBMISSION_BATCH_SIZE`; `MEILI_SYNC_BATCH_SIZE`; `MEILI_CLEANUP_BATCH_SIZE`; `MEILI_SYNC_DELAY_MS` | One bounded cohort creates one Meilisearch task, which must succeed before sequential snapshot-fenced Mongo acknowledgements begin. Submission size can be raised independently for a canary without widening Mongo writes; malformed, partial, over-limit, or unsafe integer values fail startup. Delay is applied between acknowledgement chunks and submission cohorts; zero explicitly disables it, while negative and over-limit values fail startup. Cleanup pages inherit the acknowledgement size unless `MEILI_CLEANUP_BATCH_SIZE` is set; stage and production currently use 1,000 only for cleanup while submission and acknowledgement remain 100. |
| Meilisearch persistent data | 20 GiB in dev; stage/prod gated | Deployment override in `agk-deployment-configs/agentic-karl/dev/services/agentic-karl-meilisearch` | The initial claim preserves a six-month capacity horizon at the measured September 2026 growth rate. Remeasure allocated size and 30-day growth before promotion; MongoDB remains the source of truth. |
| Meilisearch termination grace | 120 seconds in dev | Deployment override in `agk-deployment-configs/agentic-karl/dev/services/agentic-karl-meilisearch/values.yaml` | Gives the single `Recreate` pod time to stop cleanly before the RWO claim is attached to its replacement. An absent or falsey value omits the field and Kubernetes uses its default; malformed or invalid values fail rendering or deployment validation. |

## Conversation history normalization

The KK20-385 command defaults to dry-run and changes data only with both
`--apply` and an exact `--expected-count`. GitOps may lower these limits or
increase the pause, but must not exceed the code ceilings without a reviewed
code change.

| Limit | Default / allowed | Authority/source | Rationale |
| --- | ---: | --- | --- |
| Documents per batch | 25 / 1-100 | Code default, `knauf/scripts/backfill-chat-project-id.js` | Bounds each raw MongoDB read and update while keeping the migration restartable. |
| Inter-batch pause | 250 ms / 1-10,000 ms | Code default, same source | Reduces database pressure; zero, negative, non-integer, and over-limit values are rejected rather than treated as unlimited. |
| Maximum matching documents | 1,000 / 1-10,000 | Code default, same source | Apply aborts before writing when the live missing-field count exceeds this ceiling. |
| Per-operation MongoDB deadline | 30,000 ms / 1-120,000 ms | Code default, same source | Applies `maxTimeMS` to counts, reads, aggregation, and updates; invalid values fail before connecting. |
| Maintenance Job wall-clock deadline | 900 seconds | Temporary GitOps deployment override, `agentic-karl/<env>/maintenance/kk20-385-chat-project-id-backfill/values.yaml` in `agk-deployment-configs` | Bounds the complete dry-run or apply pod. A deadline failure leaves already-normalized rows safe to rescan; it never authorizes an automatic retry. |
| Expected document count | Required for apply; zero or greater | Reviewed run input, same source | Must exactly equal the live pre-write count. Zero is valid only for proving an idempotent no-op rerun; it does not disable a safety gate. |

Dry-run reports only aggregate counts, including orphaned project references,
and performs no writes. Apply preserves conversation timestamps and the
Meilisearch marker, rechecks the missing-field predicate in every update, fails
if rows remain, and is safe to rerun. Temporary GitOps values are deployment
inputs, not repository defaults.

## File translation

All values below are code defaults unless marked as a provider ceiling. GitOps
sets explicit dev, stage, and prod overrides; the effective limit is the
strictest applicable upload, application, provider, or deployment value.

| Limit | Default | Source/key | Rationale and interaction |
| --- | ---: | --- | --- |
| Files per job / aggregate bytes | 20 / 250 MiB | `translation/jobs.js` | Bounds one durable admission record; normal upload policy may reject individual files earlier. |
| Buffered input per file | 50 MiB | `translation/tool.js` | Hard application memory backstop before parsing or provider upload. |
| IDML and structured text | 25 MiB | `tool.js` | Bounds ZIP/XML/JSON/Markdown parsing; also capped at 10,000 segments and 500,000 translated characters. |
| Azure synchronous document | 10 MiB | application routing threshold | Larger eligible documents route to batch translation. |
| Azure batch document / image | 40 MiB / 5 MiB | provider ceiling | Applied before starting the Azure batch operation. |
| PDF output recompression | Ghostscript `/printer` preset, lossless by default; best-effort | `KNAUF_TRANSLATION_PDF_COMPRESSION_ENABLED`, `KNAUF_TRANSLATION_PDF_COMPRESSION_BIN` (default `gs`), `KNAUF_TRANSLATION_PDF_COMPRESSION_PRESET`, `KNAUF_TRANSLATION_PDF_COMPRESSION_QUALITY` (`lossy` opt-in), `KNAUF_TRANSLATION_PDF_COMPRESSION_TIMEOUT_MS` (default 30s; bounds only the Ghostscript run itself, not time spent waiting for a concurrency slot), `KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_CONCURRENT` (default 1, per API process), `KNAUF_TRANSLATION_PDF_COMPRESSION_MAX_QUEUE_DEPTH` (default 8; callers arriving once the wait queue is this deep skip compression immediately instead of queueing further), `translation/pdfCompression.js` | Azure Document Translation rebuilds PDFs from scratch (full font embedding, re-encoded images), often multiplying output size several times over. Ghostscript recompresses the returned PDF before persistence; by default image resolution and pixel data are preserved (no downsampling, and unmodified JPEG/JPEG2000 streams are passed through where Ghostscript's own logic allows it). The output is a Ghostscript re-render (`pdfwrite`), not a patched copy of Azure's file — digital signatures, AcroForm fields, tagged/PDF-UA structure, and XMP metadata are not guaranteed to survive the round-trip. A missing binary, timeout, queue-saturation, non-improving result, or output that fails a basic `%PDF-`/`%%EOF` validity check silently falls back to the untouched Azure output; a cancelled translation job aborts the Ghostscript process (or, while queued, is dequeued) instead of falling back. The default concurrency of 1 is calibrated to the documented 1 GiB worker pod / 768 MiB Node heap ceiling (`file-translation-production-plan.md`) — `gs` can carry hundreds of MB of RSS per spawn, so raise `MAX_CONCURRENT` only where the pod's memory headroom has been confirmed to absorb that. |
| Glossary payload | 900 KiB sync / 9 MiB batch | application safety margin below Azure limits | Required glossaries fail closed instead of truncating applicable terms. |
| Request-level preserved terms | 100 terms; 200 characters each | `translate_file.preserve_terms` | Exact, case-sensitive user-supplied product, brand, or technical terms are merged over the deployed glossary; tabs and newlines are rejected, the combined glossary must fit the provider payload limit, and an IDML term split across translation segments fails instead of being reported as preserved. |
| Active jobs | 3/user; 100/global | `KNAUF_TRANSLATION_MAX_ACTIVE_PER_USER`, `KNAUF_TRANSLATION_MAX_ACTIVE_GLOBAL` | Mongo partial-unique slots enforce admission across API replicas. Admission hash-spreads requests and probes the finite slot set; a full response is returned only after a fresh occupancy check. |
| Worker concurrency | 2 jobs; 1 file/job | `KNAUF_TRANSLATION_WORKER_CONCURRENCY`, `KNAUF_TRANSLATION_FILE_CONCURRENCY` | GitOps currently lowers job concurrency to one inside a 1 GiB worker pod. |
| Lease / heartbeat / poll | 12 minutes / 30 seconds / 2 seconds | `KNAUF_TRANSLATION_LEASE_MS`, `KNAUF_TRANSLATION_HEARTBEAT_MS`, `KNAUF_TRANSLATION_WORKER_POLL_MS` | Every lease is capped at the persisted whole-job deadline. Expired claims enter bounded backoff before reclaim; expired cancellations are finalized and release admission. |
| Attempts / output ledger | 5 general; 2 authentication; 16 generations retained | `KNAUF_TRANSLATION_ATTEMPT_CAP`, `KNAUF_TRANSLATION_AUTH_ATTEMPT_CAP`, `translation/jobs.js` | Each claim gets a new generation and deterministic generation-specific output IDs. Configured attempt caps are clamped to the bounded 16-entry output ledger so cleanup debt cannot be evicted. |
| Retry backoff | 10 seconds–10 minutes | `KNAUF_TRANSLATION_BACKOFF_BASE_MS`, `KNAUF_TRANSLATION_BACKOFF_MAX_MS` | Full jitter with provider `Retry-After` as the floor. A retry time at or beyond the persisted deadline terminally deadline-fails instead of retrying early. |
| Whole-job age | 60 minutes | `KNAUF_TRANSLATION_MAX_JOB_AGE_MS` | Persisted as `deadline_at` on admission and enforced by claim, heartbeat, storage fencing, completion, recovery, and retry. Overdue queued/retrying jobs release admission. |
| Inline wait | 15 seconds | `KNAUF_TRANSLATION_INLINE_WAIT_MS` | Tool returns a job id after this; the worker continues independently. |
| Storage write timeout | 2 minutes | `KNAUF_TRANSLATION_STORAGE_WRITE_TIMEOUT_MS` | Bounds the application wait for one output write; its AbortSignal and timeout are passed to storage strategies. A timed-out underlying write is still covered by generation cleanup reconciliation. |
| Cleanup quiescence / reconciliation | 30 seconds after the 2-minute write bound; every 30 seconds; 25 jobs/pass | `KNAUF_TRANSLATION_CLEANUP_QUIESCENCE_MS`, `KNAUF_TRANSLATION_RECONCILE_INTERVAL_MS`, `KNAUF_TRANSLATION_RECONCILE_BATCH_LIMIT` | Cleanup debt remains durable until an independent worker sweep runs after the maximum write window plus quiescence. Sweeps delete only the recorded generation's IDs through the normal dedup-aware file deletion path. |
| Terminal job history | 7 days after cleanup convergence | `KNAUF_TRANSLATION_JOB_HISTORY_MS` | Terminal tombstones have no TTL while cleanup debt or the bounded late-write window remains. The TTL starts only after a successful reconciliation sweep confirms cleanup debt is clear. |

## Scheduler

| Limit | Default | Source | Rationale |
| --- | ---: | --- | --- |
| Schedules per user | 10 | scheduler API | Prevents one user monopolizing scheduled work. |
| Poll interval | 5 seconds | scheduler worker | Balances dispatch latency and database load. |
| Lease | 10 minutes | scheduler worker | Protects active runs from duplicate workers. |
| Bookkeeping/dispatch batch | 10 / 100 | scheduler worker | Bounds each poll while allowing efficient dispatch. |
| Concurrent executions | 25 | scheduler worker | Worker-process capacity safeguard. |
| Execution timeout | 30 minutes | scheduler worker | Interrupts stuck scheduled agents. |
| Auto-disable | 5 consecutive failures | scheduler worker | Stops repeatedly broken schedules. |
| Terminal-run retention | 30 days | scheduler worker | Keeps useful history while bounding Mongo growth. |
| Deletion fence | 5 minutes | scheduler service | Prevents stale workers reviving deleted schedules. |
| User-deletion barrier | 1 hour | scheduler service | Blocks new scheduled work during account deletion. |
| Admission drain | 10 seconds, 25 ms polling | scheduler middleware | Lets admitted requests finish before deletion proceeds. |
| Internal signature skew | 60 seconds | scheduler authentication | Replay-resistance window with clock-drift tolerance. |
| Schedule jitter | 2 minutes | scheduler calculation | Spreads load around cadence boundaries. |
| Conversation-integrity scan | At scheduler startup and every 24 hours per replica; 30-second MongoDB deadline | Scheduler code default | Counts conversations where `chatProjectId` is missing, updates continuously scraped missing-count and scan-health gauges, and never mutates data. A failed scan marks telemetry unhealthy while preserving the last successful count. |

## MCP

| Limit | Default | Source | Rationale |
| --- | ---: | --- | --- |
| Registry initialization | 30 seconds | `packages/api/src/mcp/mcpConfig.ts` | Bounds unavailable MCP servers. |
| Normal connection path | Up to 2 minutes | MCP connection factory | Allows request-scoped discovery without an indefinite wait. |
| OAuth detection | 5 seconds | MCP config | Fast capability probe. |
| OAuth user completion | 10 minutes | MCP config | Human browser-authorization window. |
| OAuth state | 15 minutes minimum | MCP config | Always outlives the completion wait by at least one minute. |
| Connection check cache | 60 seconds | MCP config | Avoids repeatedly probing stable connections. |
| Idle user connection | 15 minutes | MCP config | Releases unused sockets and processes. |
| Discovery | 50 pages, 1,000 tools, 5 MiB, 30 seconds | MCP config | Stops broken pagination and unbounded registry growth. |
| Circuit breaker | 7 cycles/45 seconds; 15-second cooldown | MCP config | Stops connect/disconnect storms. |
| Failed rounds/backoff | 3/120 seconds; 30-300 seconds | MCP config | Protects repeatedly failing remote services. |
| Registry cache | 5 seconds/layer | `packages/api/src/cache/cacheConfig.ts` | Limits Redis load; multi-layer staleness may be roughly ten seconds. |

## Retention and general runtime safeguards

| Limit | Default | Authority/source | Rationale |
| --- | ---: | --- | --- |
| Temporary chats | 30 days; allowed range 1 hour-1 year | `packages/data-schemas/src/utils/tempChatRetention.ts` | Automatic cleanup without accidental immediate expiry or effectively permanent temporary chats. |
| API JSON/urlencoded body | 3 MiB | Express application configuration | General request-body safeguard. |
| RUM proxy | 3 MiB; 10 seconds | RUM proxy route | Bounds telemetry forwarding. |
| Redis connect | 10 seconds | `packages/api/src/cache/cacheConfig.ts` | Fails unavailable cache connections promptly. |
| Redis reconnect | 10 attempts; at most 3 seconds between attempts | cache config | Bounded recovery; zero attempts means unlimited retries. |
| Redis scan/delete/set chunk | 1,000 keys | cache config | Controls command and in-memory batch size. |
| Docker frontend-build heap | 8,192 MiB | `Dockerfile` | Allows the production React build to complete. |
| Node heap example | 6,144 MiB | `.env.example` | Suggested runtime/build setting; not proof of deployment. |
| Docker `npm ci` | 1,500 seconds, 2 attempts | `Dockerfile` | Handles slow dependency installation while remaining finite. |
| npm registry retry | 5 attempts; 15-600 seconds | `Dockerfile` | Registry resilience during image builds. |
| Log redaction | 8 levels, 50 entries | `packages/data-schemas/src/config/parsers.ts` | Prevents cyclic or huge error objects overwhelming logs. |
| Logged provider error | 1,024-character message, 2,048-character stack | `parsers.ts` | Keeps failures concise and limits accidental payload exposure. |
| Locale/timezone header | 40 characters | request context middleware | Rejects malformed context headers. |
| Analytics diagnostic strings | 160 characters | analytics code | Keeps telemetry bounded. |

CPU/memory requests, pod replica counts, ingress timeouts, ACA session-pool
capacity, database service tiers, and provider quota are intentionally absent
from the table. Their current values belong to GitOps, Terraform, Azure, or
ArgoCD and must be inspected there.

## Erasure verifier

Operator tooling, not request traffic: `knauf/scripts/erasure-verify.js`
(runbook `knauf/docs/privacy/runbooks/erasure-verify.md`). Every value is a
code default. A bound that is reached turns the store NOT PROBED or the run
INCOMPLETE; it never reads as zero.

| Limit | Value | Authority/source | Rationale and interaction |
| --- | ---: | --- | --- |
| Baseline age at `after` | 24 hours | `MAX_BASELINE_AGE_MS` | An older baseline is STALE. Eventual deletions with a longer deadline therefore end as obligations in the report, not as checks this tool can repeat. |
| Langfuse settle window | 15 minutes | `LANGFUSE_SETTLE_MS` | Langfuse deletes asynchronously; data still listed inside the window is PENDING. |
| Langfuse delete batch | 100 trace ids | `LANGFUSE_DELETE_BATCH` | Keeps each `DELETE /api/public/traces` body small; a failed batch leaves the record `partial`. |
| Langfuse list paging | 100 per page, 1,000 pages | `LANGFUSE_PAGE_SIZE`, `LANGFUSE_MAX_PAGES` | Beyond 100,000 ids the listing is inexact. |
| Langfuse lookups by id | 5,000 ids per route per phase, 8 in flight | `LANGFUSE_MAX_LOOKUPS`, `LANGFUSE_LOOKUP_CONCURRENCY` | Runs at `before` (positive control) and at `after`, so a subject with more than 5,000 traces or scores is NOT READY at baseline. |
| RAG verification requests | 500 values per request, 1,000 groups per page, 1,000 pages | `RAG_MAX_VALUES`, `RAG_PAGE_SIZE`, `RAG_MAX_PAGES` | The first two are the `agentic-karl-rag-api` `/verification/vectors` maxima (`MAX_VALUES`, `MAX_PAGE_SIZE`); more pages is inexact. |
| Redis `SCAN` | 100,000 rounds of `COUNT 1000`; 5-second connect, no retry | `REDIS_MAX_SCAN_ROUNDS`; `main()` client options | A scan that does not finish is inexact; an unreachable Redis is NOT PROBED rather than a reconnect loop. |
| Blob listing page | 1,000 items | `listAll()` `maxPageSize` | Paged to exhaustion; the size only bounds memory per page. |
| Translation scratch window | Manifest `lifecycleWindow` (`P1D` in stage and prod) | `knauf/docs/privacy/erasure-sinks/<env>.json` | No code default: without the manifest value the store is NOT PROBED. It mirrors the storage lifecycle rule that Terraform owns. |

## CI-only limits

| Workflow | Limit | Rationale |
| --- | ---: | --- |
| Playwright mock suite | 30 minutes | Stops hung browser tests. |
| Playwright dependency setup | 5 minutes | Bounds environment setup. |
| Playwright artifacts | 7-day retention | Preserves short-term diagnostics without indefinite storage. |
| Docker client build smoke | 25 minutes | Bounds image-target validation. |
| Docker runtime smoke | 30 minutes | Bounds production-image boot validation. |
| Config migration review | 15 minutes | Bounds schema/config compatibility tests. |
| Cache and GitNexus maintenance | 5 minutes | Bounds repository-maintenance workflows. |

Relevant PR workflows use concurrency groups. Some cancel an older run when a
new commit arrives; cleanup workflows deliberately do not.

## Known documentation and terminology traps

- `librechat.yaml` and enforcement code are authoritative for file policy;
  distinguish chat's per-send aggregate from an agent's accumulated history.
- Code Adapter responses and maintained documentation use 128 MiB for the
  134,217,728-byte ceiling. Older tickets may still use decimal "MB" wording.
- The Code Adapter code default allows 256 MiB captured output, while deployment
  examples show a 64 MiB override. Verify current GitOps values before reporting
  the deployed limit.
- User-facing sandbox text describes the roughly 220-second platform execution
  ceiling, while the adapter HTTP operation allows 230 seconds for platform and
  response handling.
- Pagination defaults such as 25 records are not necessarily security ceilings;
  do not list them as hard limits unless the route enforces a maximum.

## Maintenance procedure

Update this reference in the same change whenever code, configuration, or
deployment documentation changes an operational:

- byte, file-count, token, character, result, citation, or graph bound;
- timeout, lease, heartbeat, retry, backoff, retention, or polling interval;
- concurrency, queue-admission, batch, recursion, or circuit-breaker bound;
- rate limit, session lifetime, or abuse threshold;
- CPU, memory, replica, provider-quota, or platform ceiling documented in this
  repository.

For every update:

1. Identify whether the value is committed policy, a code default, an
   environment example, a deployment override, a provider/platform ceiling, or
   CI-only.
2. Record the key and owning source; do not copy mutable environment state into
   this document.
3. Check adjacent layers and describe the effective minimum or timeout ladder.
4. Record zero, missing, invalid, and disabled semantics where they are not
   obvious.
5. Update or remove stale statements in subsystem documentation.
6. If the value is deployment-specific, verify it in the owning GitOps,
   Terraform, Azure, Kubernetes, or ArgoCD source before calling it current.

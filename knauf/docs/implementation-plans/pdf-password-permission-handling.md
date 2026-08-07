# PDF access handling (KK20-232)

| Status | Owner | Started | Target | Related |
|---|---|---|---|---|
| PR 2 ready for review | Agentic Karl maintainers | 2026-07-20 | KK20-232 | [PR #228](https://github.com/Knauf-Group/agentic-karl/pull/228) merged; KK20-253 (PDF permission governance; separate follow-up) |

## Outcome

File Search accepts PDFs that are readable without credentials, including permission-encrypted,
signed/certified, and PDF/A documents. This is the committed KK20-232 outcome and must ship
independently.

PDFs that require an open password remain rejected with a typed error unless Knauf separately
approves the optional password-submission extension described below. That extension must not delay
or block the readable-PDF fix.

No RAG API change is currently planned. That remains true only if the core fixture corpus passes
the deployed `/embed` and `/agent/embed` paths, including Azure Document Intelligence fallback.

## Scope

In scope:

- `POST /api/files` for chat attachments and agent knowledge using `file_search`;
- upload-time PDF access classification;
- unchanged storage and indexing of every PDF that is readable without credentials;
- explicit regression coverage for permission-encrypted but credential-free, signed/certified,
  PDF/A, and malformed PDFs.

Out of scope:

- open-password submission and decryption unless separately approved by Knauf;
- native multimodal/provider PDF paths and OpenAI Assistants uploads;
- blocking copy, printing, extraction, agent creation, or download based on PDF permission flags;
- retroactive classification of existing assets.

KK20-253 must define any future governance policy and its authoritative data source. Acrobat's
Document Security panel is not sufficient. The exact source behind the reported screenshot is an
unencrypted, readable PDF/A-2A file with no `/Perms`, `/DocMDP`, signature field, or AcroForm;
qpdf, PDF.js, pypdf, and Acrobat's JavaScript API all confirm that no password or security handler
applies. Adobe documents that PDF/A viewing mode opens conforming documents read-only to prevent
modification. This explains why Acrobat can show "Document assembly" and "Page extraction" as
"Not Allowed" while also showing "Security Method: No Security". Those viewer-mode rows must not be
stored as encryption or authorization facts.

## Verified current behavior

The active File Search path stores the original PDF in `KnaufFileAsset.blob` and sends that PDF to
the RAG route selected by its vector backend: chat attachments use pgvector `/embed`; Agent
Knowledge uses Azure AI Search `/agent/embed` when `AZURE_SEARCH_ENABLED=true`, and the compatibility
fallback uses pgvector `/embed` when it is false. Node text extraction belongs to the separate
`context` path and is not a fallback for File Search.

Before PR 1, the upload gate scanned bytes for `/Encrypt` and rejected both encrypted cases. PR 1
replaced that heuristic with the isolated PDF.js access probe, so the current classifier distinguishes
documents that are readable without credentials from documents that require an open password:

| Case | PDF access | Required behavior |
|---|---|---|
| A | Unencrypted | Upload and index normally |
| B | Encrypted but readable without credentials | Upload and index normally |
| C | Open/user password required | Return a typed rejection; password submission is an optional extension |

For the standard PDF security handler, libraries commonly detect case B by attempting the empty
user password. This is an internal probe, not a password users enter. The KK20-232 sample is case B:
`pdfjs-dist` and the RAG API's pinned `pypdf==6.13.3` stack both open and extract all 18 pages
without supplied credentials. If Azure Document Intelligence rejects it, the existing RAG loader
falls back to pypdf. The former `/Encrypt` upload gate was therefore the reported defect.

GitOps now contains dedicated dev and prod indexing-worker services that run
`npm run backend:worker`, use the same application image as their API deployment, and set
`KNAUF_INDEXING_WORKER_ENABLED=true` in the worker pods. Companion GitOps
[PR #309](https://github.com/Knauf-Group/agk-deployment-configs/pull/309) is merged and also sets
`KNAUF_INDEXING_WORKER_ENABLED=true` beside `KNAUF_ASYNC_FILE_INDEXING_ACCEPT=true` in the dev and
prod API deployments. Because effective acceptance is evaluated in the API process, this declaration
allows the API to return async acceptance after the matching PR 2 image is deployed.

## Core invariants

1. `blob` remains the byte-identical uploaded PDF and the source of content-hash identity,
   provenance, citation, and download.
2. Classification and hashing read the same original upload bytes in the existing order:
   classify, then hash, then reserve/store.
3. Async acceptance is computed as `acceptFlag && workerEnabled`. When false, the existing
   transient `uploading -> queued -> processing` synchronous claim path remains valid and the
   request waits for bounded generation completion.
4. Every terminal cleanup path deletes the original blob and all vector generations.
5. PDF permission observations are not authorization controls and are not persisted by KK20-232.

## Delivery sequence

### PR 1 - Fix case-A/B/C classification ([merged](https://github.com/Knauf-Group/agentic-karl/pull/228))

Extract the non-trivial classifier to
`packages/knauf/src/server/pdfAccessProbe.js` with its process-isolated worker beside it, and export
it from `packages/knauf/package.json`. Declare the pinned `pdfjs-dist` runtime dependency in
`packages/knauf/package.json` and update the lockfile. Leave only minimal `[knauf]` import/call
integration seams in upstream files. Add:

- an append-only KK20-232 Net-New Files row for each Knauf module;
- append-only KK20-232 Inline Modifications rows for the route and validation seams;
- a seam test that pins the imports, File Search gate, and removal of global PDF rejection.

Keep the existing CFBF/OOXML sniff global. Remove PDF classification from that global detector and
invoke the new PDF access probe only when:

```js
!isAssistantsEndpoint(metadata.endpoint) &&
metadata.tool_resource === EToolResources.file_search
```

This preserves current Assistants and native/provider behavior, which is outside KK20-232.

The probe returns a discriminated result:

- successful open without a supplied password -> `readable` (A or B);
- PDF.js `PasswordException` requiring a password -> `password_required` (C);
- malformed, spoofed, or unsupported PDF -> validation failure, not `password_required`.

Run the probe only after the existing MIME and file-size checks. Execute `pdfjs-dist@5.4.624` in a
Node worker thread or child process because its Node fake worker parses in-process and cannot be
bounded by `Promise.race`. The parent terminates the isolated process at the deadline. Inside the
isolate, disable PDF.js evaluation and destroy both the loading task and loaded document in
`finally`. Add tests that prove timeout termination and parser failures release their resources.
The route must not inherit the current encryption detector's broad fail-open catch.

Define stable route/client outcomes:

| Probe result | HTTP | Stable code | Client behavior |
|---|---:|---|---|
| Password required | 422 | `com_knauf_error_pdf_password_required` | Localize; do not retry |
| Invalid/malformed/unsupported PDF | 422 | `com_knauf_error_pdf_invalid` | Localize; do not retry |
| Read/init/worker/timeout failure | 503 | `com_knauf_error_pdf_probe_unavailable` | Localize and use the existing bounded 503 retry path |

Add all three codes to `resolveUploadErrorMessage`, English/German localization, route tests, and
upload-client tests. Only a confirmed `PasswordException` maps to password-required.

Keep the existing OOXML encrypted-container check unchanged. Preserve client-ID adoption,
authorization, original-byte hashing, reservation, and temp-file cleanup order.

Ship the case-A/B behavior independently: readable PDFs continue through the existing storage and
RAG path without stripping encryption or creating alternate content. Unless the optional extension
is separately approved and enabled, case C retains a typed password-required rejection.

### PR 2 - Prove downstream and deployment readiness

PR 2 is implemented on `feat/kk20-232-pdf-downstream-readiness`. Its rollout
guard makes effective async acceptance require both the acceptance flag and
declared worker availability. Environments that set only
`KNAUF_ASYNC_FILE_INDEXING_ACCEPT=true` therefore retain the transient queued
state but immediately claim and embed synchronously. Dev and prod GitOps now
declare `KNAUF_INDEXING_WORKER_ENABLED=true` on the API deployment as well as
the worker deployment through merged companion PR #309.

The companion GitOps change is merged. Merge PR 2 through the standard release process to produce
and deploy the matching application/worker image in dev, then run the deployed fixture matrix.
Production promotion remains blocked until the exact release has passed the required readiness,
retrieval, citation, rejection, and worker-health checks.

Run unencrypted, permission-encrypted but credential-free, signed/certified, PDF/A, malformed, and
open-password fixtures through the deployed File Search `/embed` and `/agent/embed` paths. The
deployed Agent Knowledge path requires `AZURE_SEARCH_ENABLED=true`; a local configuration with the
flag disabled must instead prove the supported pgvector `/embed` fallback. Assert actual text
extraction and generation activation, not only successful upload or PDF metadata loading. Exercise
Azure Document Intelligence rejection/fallback where applicable.

If any readable fixture cannot be fully extracted by the existing RAG stack, the required RAG
change joins KK20-232; do not weaken the acceptance matrix or mark the upload ready with incomplete
content.

Before rollout, make the indexing execution mode coherent in code and each environment:

1. compute `asyncAccepted = acceptFlag && workerEnabled`;
2. when false, retain the existing `markQueued` followed immediately by the synchronous claim and
   bounded generation path;
3. when true, prove that a draining worker is deployed and enabled before returning async success.

This prevents mismatched flags from stranding uploads without incorrectly forbidding the internal
transient `queued` state. Prove the selected mode with a canary that reaches `ready`. This is
mandatory core work, not part of the optional open-password extension.

Add durable deployed regression coverage in `agentic-karl-quality`, building on its shared
conversation-file and Agent Knowledge E2E flows rather than duplicating upload, polling, chat,
citation, and cleanup helpers. The automated tests must:

- accept either HTTP `200` or `202` according to the deployed indexing mode, then poll
  `GET /api/files/:file_id/index-status` until `ready`;
- exercise both conversation File Search and Agent Knowledge with PDFs, assert a
  fixture-specific fact, and require a structured citation tied to the uploaded file;
- assert that open-password and malformed PDFs return their stable HTTP `422` error codes without
  producing an indexable file;
- use unique resource names and delete only the conversations, agents, and files created by the
  test; and
- remain excluded from prod because they mutate data and consume indexing and model capacity.

Keep a representative PDF canary in the blocking STAGE promotion suite. Make the complete readable
fixture matrix available through a manually dispatched quality workflow so it can be run for
release acceptance and broader regression checks without making every STAGE promotion pay the full
matrix cost. A passing quality run is durable regression evidence, but it does not replace the
required manual dev and prod evidence for the exact deployed KK20-232 release.

## Appendix: optional open-password extension

This appendix preserves the ready technical design without making it part of the committed delivery
sequence.

The following work is technically designed but is not required to complete KK20-232. Start it only
after product ownership confirms that open-password PDFs are an important Knauf use case.

### Optional PR 1 - Add the server-side password lifecycle

Extend the physical `KnaufFileAsset` machine and types with:

- status `needs_password`;
- fork-only descriptor `knauf_worker_blob`;
- CAS transitions `uploading -> needs_password`, `needs_password -> queued`, and
  `needs_password -> failed/deleting`.

For case C, finish authorization, hashing, reservation, pending logical-file creation, and storage
of the encrypted original before entering `needs_password`. Do not call `markQueued`.

Add an owner/agent-EDIT-authorized password endpoint for the logical `file_id`:

1. load and authorize the associated physical asset;
2. require `status=needs_password`;
3. materialize the encrypted `blob` using the configured storage strategy;
4. invoke qpdf with the password on stdin, bounded by timeout, output-size, temp-permission, and
   sanitized-error limits;
5. persist the decrypted PDF as `knauf_worker_blob`;
6. CAS to `queued`; return asynchronously only when `acceptFlag && workerEnabled`, otherwise claim
   immediately and run the existing bounded synchronous generation embed in the same request;
7. delete a newly written worker blob if persistence or CAS loses.

Wrong passwords return one generic error and leave the asset in `needs_password`. Limit failed
attempts to five per `(user, file_id)` per 15 minutes using the existing rate-limit infrastructure.
Audit only success/failure event metadata.

Centralize RAG-input selection as `knauf_worker_blob ?? blob`; use it in synchronous execution,
worker execution, retry, and reconciliation. Downloads and citations always resolve `blob`.

Add qpdf to both Alpine app images (`Dockerfile` and `Dockerfile.multi`). Root Dockerfile changes
need `[knauf]` markers, KK20-232 `SEAMS.md` rows, and image smoke coverage.

### Optional PR 2 - Add actionable client behavior

Split the current `isIndexingPending` concept into explicit predicates:

| Concern | `needs_password` |
|---|---|
| Poll automatically | No |
| Block chat send | Yes |
| Workflow terminal | No |
| Render file status/action | Yes |

Render password entry in the existing per-file indexing status surface. Submit in the request body,
clear local password state after every attempt, show the generic wrong-password response, and resume
normal status polling only after the server returns `queued` or `processing`.

The server-side chat readiness check remains the enforcement boundary.

### Optional PR 3 - Complete cleanup and rollout

Update deletion, cancellation, expiry, reconciler, partial-persistence, and CAS-loss paths to delete
the original and worker descriptors once each. A `needs_password` asset expires after 24 hours by
default through a configurable reconciler threshold; expiry removes its logical references and both
artifacts using the normal tombstone/delete lifecycle.

Before enabling case-C acceptance:

1. confirm the mandatory core indexing-mode correction remains active;
2. deploy qpdf image changes to every API pod that can serve the password endpoint;
3. enable new case-C acceptance for dev, then prod.

Use a creation gate for case C so rollback can stop new `needs_password` assets while leaving the
password endpoint available to drain existing ones. Disabling the feature must not strand already
stored encrypted originals.

Update the files architecture docs and seam manifest after behavior is accepted.

## Core acceptance matrix

| Scenario | Expected result |
|---|---|
| Unencrypted PDF | Original stored; indexes normally |
| KK20-232 permission-encrypted PDF readable without credentials | Original stored unchanged; indexes normally |
| Readable signed/certified or DocMDP PDF | Original stored unchanged; indexes normally |
| Readable PDF/A document | Original stored unchanged; indexes normally |
| Readable PDF rejected by Azure Document Intelligence | Existing pypdf fallback extracts and activates the generation |
| Open-password PDF | Typed password-required rejection; does not block the readable-PDF release |
| Malformed PDF or MIME spoof | Rejected as invalid, never presented as a password prompt |
| PDF.js read, initialization, worker, or timeout failure | Stable 503 probe-unavailable response; bounded client retry; no silent pass-through |
| Worker disabled or unavailable | `asyncAccepted=false`; transient queue plus bounded synchronous claim reaches `ready` |
| Worker enabled | Canary queues once and reaches `ready` |

## Optional-extension acceptance matrix

Applies only if Knauf approves open-password support:

| Scenario | Expected result |
|---|---|
| Open-password PDF, wrong password | Remains `needs_password`; no worker blob; generic error |
| Open-password PDF, correct password | Original retained; internal worker blob indexed; reaches `ready` |
| API restart while waiting | `needs_password` remains visible and actionable |
| Duplicate password submissions | One CAS winner; losing output is deleted |
| Delete/expiry before or after unlock | Original, worker blob, logical refs, and vectors are removed |
| Download unlocked case-C asset | Returns the encrypted original, never the worker blob |
| Worker enabled | Password success queues once and worker reaches `ready` |
| Logs and stored records | Contain no password value or password-derived filename/argument |

## Repository ownership

| Repository | Work |
|---|---|
| `agentic-karl` | Process-isolated classifier in `packages/knauf/`, small upstream seams, tests/docs; optional state machine, qpdf lifecycle, and client UX only if approved |
| `agk-deployment-configs` | Coherent async/worker flags, worker deployment if async is selected, and optional case-C feature gate |
| `agentic-karl-rag-api` | Validate the existing PDF fallback and generation contract; change it if a readable core fixture fails |
| `agentic-karl-quality` | Durable deployed PDF E2E coverage for conversation and Agent Knowledge retrieval, readiness, citations, rejection behavior, and scoped cleanup; blocking STAGE canary plus manually dispatched full matrix |

## Completion

KK20-232 is complete when unencrypted, permission-encrypted, signed/certified, and PDF/A documents
that are readable without credentials pass upload, text extraction, and generation activation in
dev and prod; malformed PDFs, parser infrastructure failures, and open-password PDFs return their
specified stable HTTP/code combinations; and `asyncAccepted = acceptFlag && workerEnabled` while
both synchronous and asynchronous modes demonstrably reach `ready`. Manual dev and prod evidence
must identify the tested application and worker versions and remains authoritative for release
acceptance; automated STAGE quality coverage protects subsequent promotions but is not a substitute
for testing the exact deployed release.

If Knauf later approves the optional extension, its separate completion condition is that case C
passes the optional-extension matrix without exposing a password or internal worker descriptor.

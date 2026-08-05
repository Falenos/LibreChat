# PDF access handling (KK20-232)

| Status | Owner | Started | Target | Related |
|---|---|---|---|---|
| Proposed for implementation review | Agentic Karl maintainers | 2026-07-20 | KK20-232 | KK20-253 (PDF permission governance; separate follow-up) |

## Outcome

File Search accepts PDFs that are readable without a password, including the owner-password-only
PDF reported in KK20-232. PDFs that require an open password are retained in an actionable
`needs_password` state and continue after an authorized user supplies the password. The password is
never persisted.

This plan changes the app and its deployment only. The RAG API needs no code change.

## Scope

In scope:

- `POST /api/files` for chat attachments and agent knowledge using `file_search`;
- upload-time PDF access classification;
- password submission and client UX for genuinely locked PDFs;
- durable storage, indexing, retry, deletion, expiry, and rollback for the resulting artifacts.

Out of scope:

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
RAG `/embed` or `/agent/embed`. Node text extraction belongs to the separate `context` path and is
not a fallback for File Search.

The current upload gate scans bytes for `/Encrypt` and rejects both encrypted cases:

| Case | PDF access | Required behavior |
|---|---|---|
| A | Unencrypted | Upload and index normally |
| B | Encrypted with owner/permission password only; opens with an empty password | Upload and index normally |
| C | Open/user password required | Store the encrypted original and request a password |

The KK20-232 sample is case B: `pdfjs-dist` and the RAG API's pinned `pypdf==6.13.3` stack both open
and extract all 18 pages without a supplied password. If Azure Document Intelligence rejects it,
the existing RAG loader falls back to pypdf. The current `/Encrypt` upload gate is therefore the
reported defect.

Dev and prod currently set `KNAUF_ASYNC_FILE_INDEXING_ACCEPT=true`, but GitOps contains no dedicated
indexing-worker service and does not set `KNAUF_INDEXING_WORKER_ENABLED`. Queuing work is not a valid
completion strategy until that deployment mismatch is corrected. This is a rollout prerequisite,
not a reason to keep rejecting case B.

## Invariants

1. `blob` remains the byte-identical uploaded PDF and the source of content-hash identity,
   provenance, citation, and download.
2. A case-C asset may additionally own `knauf_worker_blob`, a decrypted internal PDF used only for
   indexing. It is never serialized to clients or returned by download APIs.
3. The password exists only in the password-submission request and qpdf stdin. It is absent from
   logs, MongoDB, blob metadata, filenames, argv, queues, metrics, and worker payloads.
4. Classification and hashing read the same original upload bytes in the existing order:
   classify, then hash, then reserve/store.
5. `needs_password` is durable, visible, non-searchable, excluded from worker claims, and requires
   a user action. It is not an indexing retry state.
6. Work enters `queued` only when a draining worker deployment is enabled. Otherwise the request
   uses the existing bounded synchronous generation path.
7. Every terminal cleanup path deletes both unique blob descriptors and all vector generations.
8. PDF permission observations are not authorization controls and are not persisted by KK20-232.

## Delivery sequence

### PR 1 - Fix case-A/B/C classification

Replace the `/Encrypt` byte-sniff decision in
`packages/api/src/files/validation.ts` with a PDF.js access probe:

- successful open without a supplied password -> `readable` (A or B);
- PDF.js `PasswordException` requiring a password -> `password_required` (C);
- malformed, spoofed, or unsupported PDF -> validation failure, not `password_required`.

Keep the existing OOXML encrypted-container check unchanged. Preserve client-ID adoption,
authorization, original-byte hashing, reservation, and temp-file cleanup order.

Ship the case-A/B behavior independently: readable PDFs continue through the existing storage and
RAG path without stripping encryption or creating alternate content. Until the later PRs are
enabled, case C retains a typed password-required rejection.

### PR 2 - Add the server-side password lifecycle

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
6. CAS to `queued` only when the worker deployment is enabled; otherwise claim and run the existing
   bounded synchronous generation embed in the same request;
7. delete a newly written worker blob if persistence or CAS loses.

Wrong passwords return one generic error and leave the asset in `needs_password`. Limit failed
attempts to five per `(user, file_id)` per 15 minutes using the existing rate-limit infrastructure.
Audit only success/failure event metadata.

Centralize RAG-input selection as `knauf_worker_blob ?? blob`; use it in synchronous execution,
worker execution, retry, and reconciliation. Downloads and citations always resolve `blob`.

Add qpdf to both Alpine app images (`Dockerfile` and `Dockerfile.multi`). Root Dockerfile changes
need `[knauf]` markers, KK20-232 `SEAMS.md` rows, and image smoke coverage.

### PR 3 - Add actionable client behavior

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

### PR 4 - Complete cleanup, deployment, and rollout

Update deletion, cancellation, expiry, reconciler, partial-persistence, and CAS-loss paths to delete
the original and worker descriptors once each. A `needs_password` asset expires after 24 hours by
default through a configurable reconciler threshold; expiry removes its logical references and both
artifacts using the normal tombstone/delete lifecycle.

Before enabling case-C acceptance:

1. either deploy the dedicated worker with `KNAUF_INDEXING_WORKER_ENABLED=true`, or set
   `KNAUF_ASYNC_FILE_INDEXING_ACCEPT=false` so uploads use synchronous execution;
2. prove the selected mode drains a queued canary asset;
3. deploy qpdf image changes to every API pod that can serve the password endpoint;
4. enable new case-C acceptance for dev, then prod.

Use a creation gate for case C so rollback can stop new `needs_password` assets while leaving the
password endpoint available to drain existing ones. Disabling the feature must not strand already
stored encrypted originals.

Update the files architecture docs and seam manifest after behavior is accepted.

## Acceptance matrix

| Scenario | Expected result |
|---|---|
| Unencrypted PDF | Original stored; indexes normally |
| KK20-232 owner-password-only PDF | Original stored unchanged; indexes normally |
| Open-password PDF, wrong password | Remains `needs_password`; no worker blob; generic error |
| Open-password PDF, correct password | Original retained; internal worker blob indexed; reaches `ready` |
| Malformed PDF or MIME spoof | Rejected as invalid, never presented as a password prompt |
| API restart while waiting | `needs_password` remains visible and actionable |
| Duplicate password submissions | One CAS winner; losing output is deleted |
| Delete/expiry before or after unlock | Original, worker blob, logical refs, and vectors are removed |
| Download unlocked case-C asset | Returns the encrypted original, never the worker blob |
| Worker unavailable | No new work is queued; bounded synchronous path is used |
| Worker enabled | Password success queues once and worker reaches `ready` |
| Logs and stored records | Contain no password value or password-derived filename/argument |

## Repository ownership

| Repository | Work |
|---|---|
| `agentic-karl` | Classification, state machine, endpoint, qpdf runtime, client UX, cleanup, tests, docs |
| `agk-deployment-configs` | Coherent async/worker flags, worker deployment if selected, case-C feature gate |
| `agentic-karl-rag-api` | No change; validate the existing PDF fallback and generation contract |

## Completion

The workstream is complete when cases A, B, and C pass the acceptance matrix in dev and prod, no
password or internal worker descriptor is exposed, and the async deployment can demonstrably drain
every state it accepts.

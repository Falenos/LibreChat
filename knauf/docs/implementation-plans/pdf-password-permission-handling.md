# PDF access handling (KK20-232)

| Status | Owner | Started | Target | Related |
|---|---|---|---|---|
| Proposed for implementation review | Agentic Karl maintainers | 2026-07-20 | KK20-232 | KK20-253 (PDF permission governance; separate follow-up) |

## Outcome

File Search accepts PDFs that are readable without credentials, including permission-encrypted,
signed/certified, and PDF/A documents. This is the committed KK20-232 outcome and must ship
independently.

PDFs that require an open password remain rejected with a typed error unless Knauf separately
approves the optional password-submission extension described below. That extension must not delay
or block the readable-PDF fix.

This plan changes the app and its deployment only. The RAG API needs no code change.

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
RAG `/embed` or `/agent/embed`. Node text extraction belongs to the separate `context` path and is
not a fallback for File Search.

The current upload gate scans bytes for `/Encrypt` and rejects both encrypted cases:

| Case | PDF access | Required behavior |
|---|---|---|
| A | Unencrypted | Upload and index normally |
| B | Encrypted but readable without credentials | Upload and index normally |
| C | Open/user password required | Return a typed rejection; password submission is an optional extension |

For the standard PDF security handler, libraries commonly detect case B by attempting the empty
user password. This is an internal probe, not a password users enter. The KK20-232 sample is case B:
`pdfjs-dist` and the RAG API's pinned `pypdf==6.13.3` stack both open and extract all 18 pages
without supplied credentials. If Azure Document Intelligence rejects it, the existing RAG loader
falls back to pypdf. The current `/Encrypt` upload gate is therefore the reported defect.

Dev and prod currently set `KNAUF_ASYNC_FILE_INDEXING_ACCEPT=true`, but GitOps contains no dedicated
indexing-worker service and does not set `KNAUF_INDEXING_WORKER_ENABLED`. Queuing work is not a valid
completion strategy until that deployment mismatch is corrected. This is a rollout prerequisite,
not a reason to keep rejecting case B.

## Core invariants

1. `blob` remains the byte-identical uploaded PDF and the source of content-hash identity,
   provenance, citation, and download.
2. Classification and hashing read the same original upload bytes in the existing order:
   classify, then hash, then reserve/store.
3. Work enters `queued` only when a draining worker deployment is enabled. Otherwise the request
   uses the existing bounded synchronous generation path.
4. Every terminal cleanup path deletes the original blob and all vector generations.
5. PDF permission observations are not authorization controls and are not persisted by KK20-232.

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

### Optional extension - requires separate Knauf approval

The following work is technically designed but is not required to complete KK20-232. Start it only
after product ownership confirms that open-password PDFs are an important Knauf use case.

#### PR 2 - Add the server-side password lifecycle

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

#### PR 3 - Add actionable client behavior

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

#### PR 4 - Complete cleanup, deployment, and rollout

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

## Core acceptance matrix

| Scenario | Expected result |
|---|---|
| Unencrypted PDF | Original stored; indexes normally |
| KK20-232 permission-encrypted PDF readable without credentials | Original stored unchanged; indexes normally |
| Readable signed/certified or DocMDP PDF | Original stored unchanged; indexes normally |
| Readable PDF/A document | Original stored unchanged; indexes normally |
| Open-password PDF | Typed password-required rejection; does not block the readable-PDF release |
| Malformed PDF or MIME spoof | Rejected as invalid, never presented as a password prompt |
| Worker unavailable | No new work is queued; bounded synchronous path is used |

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
| `agentic-karl` | Core classification/tests/docs; optional state machine, qpdf lifecycle, and client UX only if approved |
| `agk-deployment-configs` | Coherent async/worker flags; optional worker deployment and case-C feature gate |
| `agentic-karl-rag-api` | No change; validate the existing PDF fallback and generation contract |

## Completion

KK20-232 is complete when unencrypted, permission-encrypted, signed/certified, and PDF/A documents
that are readable without credentials pass upload and full indexing in dev and prod; malformed PDFs
and open-password PDFs fail with distinct typed errors; and the selected indexing mode demonstrably
drains every state it accepts.

If Knauf later approves the optional extension, its separate completion condition is that case C
passes the optional-extension matrix without exposing a password or internal worker descriptor.

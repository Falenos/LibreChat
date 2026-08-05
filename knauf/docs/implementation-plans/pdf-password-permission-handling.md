# Plan: PDF Password/Permission Handling (KK20-232)

**Generated:** 2026-07-20
**Status:** Proposed — rev 5. First review round (`AlexZahar`, 4 HIGH findings) was addressed in rev 2; rev 5 corrects a routing mistake introduced in rev 3/4 after re-reading the `tool_resource` branch boundaries in `processAgentFileUpload`. The active chat / agent-knowledge `file_search` path stores the raw PDF and sends that durable blob to `rag_api`; only the dormant `context` path extracts text in Node. The plan now preserves a byte-identical original, creates a separate decrypted worker-input PDF for case C, and defines `uploading → needs_password → queued/processing` against the shipped `KnaufFileAsset` machine. Awaiting re-review from `AlexZahar` and `jorgecostak` before any implementation PR is opened
**Owner:** Agentic Karl maintainers
**Ticket:** [KK20-232](https://knauf.atlassian.net/browse/KK20-232) — champion blocked from uploading a PDF that has no open password, only an owner/permissions password
**Related:** [KK20-253](https://knauf.atlassian.net/browse/KK20-253) (unrefined data-governance spike), [KAPF-74](https://knauf.atlassian.net/browse/KAPF-74) (older, similar report)
**Investigation dossier:** `local/kk20-253-pdf-permission-governance/` (git-ignored, not part of this doc's history — the facts-only research that led here: ticket data, screenshots, sample PDF, Confluence search results)

## Objective

Stop rejecting PDFs at upload time that don't actually need a password to read, without inventing a permission-enforcement policy this repo has no mandate to decide. Cover the real failure mode in KK20-232 correctly, add a genuine password-entry path for the rare case where a PDF truly can't be opened without one, and do it in a way that's compliant (never persist the password) and doesn't block the async indexing architecture already in place.

## Scope

**In scope:** the chat / agent-knowledge-base RAG `file_search` upload flow (`POST /api/files` → `processAgentFileUpload`). For PDFs this flow persists the raw PDF and sends that durable blob to `rag_api` for extraction and embedding (see "How PDFs actually flow"). This is KK20-232's actual scenario.

**Explicitly deferred to a follow-up ticket:**
- Assistants-API file upload (sent directly to the OpenAI Files API).
- Native multimodal PDF upload for Anthropic / Bedrock / Google — these providers need real PDF *bytes*, not extracted text, and already have their own separate per-provider encryption checks (e.g. `validateAnthropicPdf`).

**Explicitly out of scope for this plan, deferred to the KK20-253 stakeholder conversation:** any policy decision about *enforcing* PDF permission flags (blocking copy/export/etc. based on a document's classification level). Georgios Kakavas has asked Benjamin Kircher (ADM) how this is handled today; that answer is still outstanding as of this writing. This plan only adds groundwork (capturing permission-flag metadata, see Phase 5) so that policy can be wired in later without another redesign.

## Current decision

The bug is a misclassification, not a missing capability. `packages/api/src/files/validation.ts`'s `detectEncryptedFileAtPath` (the KK20-190 seam) sniffs the PDF trailer for an `/Encrypt` marker and rejects the upload on any match — collapsing two very different cases into one "rejected" outcome:

| Case | Description | Opens without a password? |
|---|---|---|
| **A** | No encryption at all | n/a |
| **B** | Owner/permissions password only (KK20-232's actual PDF: 256-bit AES, editing/commenting/form-fill/assembly/page-extraction restricted, printing/copying/accessibility-extraction allowed) | **Yes** — any viewer/library opens it with an empty password |
| **C** | Real open/user password required | No — genuinely unreadable without the password |

Converting PDFs to markdown for RAG (the `KK20-192` born-digital-routing work) doesn't already solve this: encryption is a lock on the container, beneath any parser. Azure DI / the born-digital local extractor / `pdfjs-dist` all need the file already decrypted before they can extract anything — that work answers *how* to extract once the file is readable, not *whether* it's readable at all. No new decrypt library is needed for case B specifically, because case B was never actually locked for reading.

### How PDFs actually flow (verified in `api/server/services/Files/process.js`)

`processAgentFileUpload` branches on `tool_resource` **before** the document-parser logic:

1. **`file_search` (active Knauf chat / agent-knowledge path): raw binary → durable blob → `rag_api`.** The upload reserves a `KnaufFileAsset`, creates a pending logical `File`, stores the original PDF through the configured file strategy, records that PDF descriptor in `FileAsset.blob`, and then either embeds synchronously or lets `indexingWorker.js` claim it. `generationRagClient.js` materializes `claim.blob` and posts the raw PDF to `/embed` or `/agent/embed`. The worker therefore does receive a PDF container, and retries require a durable readable PDF blob.
2. **`context` (dormant in this deployment): PDF → Node `document_parser` / configured OCR → extracted text.** The `shouldUseOCR` / `resolveDocumentText` / `createTextFile` block is nested inside `tool_resource === context`; it is not reached by `file_search`. `pdfjs-dist` is still useful for the cheap upload-time classification probe, but it is not a downstream fallback for an active `file_search` request.
3. **`processFileUpload` is a separate storage/provider path.** Assistants uploads are explicitly deferred by this plan; it does not share the `context` extract-then-store branch.
4. **Azure DI runs inside `rag_api`.** `rag_api` routes PDFs through `_AzureDIWithFallback`, which falls back from DI to `SafePyPDFLoader` / `PyPDFLoader` on an exception. The born-digital DI-skip is currently OFF in dev and prod (`RAG_AZURE_DI_PDF_MIN_TEXT_CHARS="0"`), so the active `file_search` path sends the uploaded PDF to DI-with-fallback.

The architecture consequence is the opposite of rev 3/4: case C must produce a **durable decrypted PDF worker-input blob** before indexing can proceed. Persisting extracted text in the API would bypass the deployed RAG parser/DI pipeline and change retrieval quality and format semantics.

## Phase 0 result (spike run 2026-08-05 — resolves the "is Phase 1 the whole fix?" question)

The open question was whether "stop rejecting case B at the Node gate" is the entire fix for KK20-232's reported file. Phase 0 was run against the **actual KK20-232 sample PDF** (`local/kk20-253-pdf-permission-governance/attachments/Knauf Group Standard on Local Market Release.pdf`) and the **deployed** rag_api dependency versions. Results:

| Layer | Tool | Result on the case-B sample |
|---|---|---|
| Static encryption dict | raw scan | `/Filter/Standard /V 5 /R 6` AESV3 (256-bit), `/P -1324` → **owner-password-only (case B confirmed)** |
| Node extraction | `pdfjs-dist` (`document_parser`) | Opens with empty password; **18 pages**; page-1 text extracted; `getPermissions()` = `[4,16,512,2048]` (print + copy-for-accessibility + fill-forms + assemble allowed; modify/annotate/extract denied) |
| RAG extraction | `pypdf==6.13.3` + `cryptography` (rag_api's pinned versions) | `is_encrypted = True`, but **reads all 18 pages** via pypdf's empty-password auto-attempt; page-1 text extracted |

**Conclusion for the active `file_search` scope: case B already extracts successfully through the deployed RAG fallback.** The over-rejection is caused by the upload-time `/Encrypt` byte-sniff gate (`detectEncryptedFileAtPath`) — the file is blocked before it can reach `rag_api`. If Azure DI rejects the owner-password-only PDF, `_AzureDIWithFallback` hands the same PDF to pypdf, which opens it with an empty password. The separate `pdfjs-dist` result proves that the proposed Node classification probe can distinguish case B from case C; it is not a second fallback in the same `file_search` request.

Therefore no case-B strip-security branch belongs in this implementation. Whether Azure DI itself accepts the file remains an optional quality investigation; `_AzureDIWithFallback` already guarantees that a DI rejection falls through to pypdf. Case C is a separate workflow and always requires a durable decrypted worker-input PDF.

**Deliberately not run:** a live call to the deployed Foundry Azure DI endpoint (`RAG_AZURE_DI_ENDPOINT = https://foundry-agk-hub-{nonprod,prod}-swedencentral-001.services.ai.azure.com/`) with the sample. It uses a real key and incurs cost, and the answer does not change the correctness verdict.

> Azure DI's documented input requirement remains *"If your PDFs are password-locked, you must remove the lock before submission"* ([Azure DI v4.0 GA layout — Input requirements](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0#input-requirements)), and Microsoft does not distinguish case B from case C in that wording. Here a case-B DI rejection degrades to pypdf; case C is decrypted before it is queued.

## Work packages

### Phase 0 — Verification spike (complete for implementation)
**Status: resolved — see "[Phase 0 result](#phase-0-result-spike-run-2026-08-05--resolves-the-is-phase-1-the-whole-fix-question)" above.** The real KK20-232 PDF is confirmed case B. It opens with an empty password in both `pdfjs-dist` (validating the proposed classification probe) and pypdf (validating the active `rag_api` fallback). A live billed Azure DI probe is optional because its answer cannot change the correctness decision: case B must pass the upload gate and case C must be decrypted before indexing.

#### How this was tested (reproducible)
Run on 2026-08-05 against `local/kk20-253-pdf-permission-governance/attachments/Knauf Group Standard on Local Market Release.pdf`:
- **Encryption dict:** raw byte scan of the trailer `/Encrypt` dictionary → `/Filter/Standard /V 5 /R 6` (AESV3, 256-bit), `/P -1324` (owner-password-only permission mask).
- **Classification probe:** `pdfjs-dist` legacy build (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`), `getDocument({ data })` with **no** password argument → resolved (empty-password auto-attempt), `numPages = 18`, page-1 `getTextContent()` non-empty, `getPermissions()` = `[4,16,512,2048]`. Node v24.16.0.
- **Active RAG path:** a throwaway venv pinned to rag_api's exact deps (`pypdf==6.13.3`, `cryptography`), `PdfReader(path)` → `is_encrypted = True` yet `len(reader.pages) == 18` and `pages[0].extract_text()` non-empty (pypdf's empty-password auto-attempt; this is precisely what `PyPDFLoader`/`SafePyPDFLoader` do). `cryptography` is required for the AESV3 branch and is present in rag_api's `requirements.txt`.
- **Not run:** `POST` of the sample to the live Foundry Azure DI endpoint. `qpdf`/`pdftk` were also not exercised (not installed locally; `qpdf` install is a Phase 2 concern, not Phase 0).

### Phase 1 — Fix the over-broad Node gate
Replace the byte-sniffed `/Encrypt`-trailer heuristic in `detectEncryptedFileAtPath` with a real classification: attempt to open the PDF with an empty password via `pdfjs-dist` (already a dependency) as a cheap upload-time probe.
- Empty-password success → case A/B → continue the existing upload unchanged.
- `PasswordException` (`NeedPassword`/`IncorrectPassword`) → case C → return a distinct classification to the route, not an HTTP/file response.
- For case C, continue file-ID adoption, authorization, hash computation, asset reservation, pending `File` creation, and durable storage of the original encrypted PDF. Enter `needs_password` only after those steps succeed.
- Keep the request-local temp cleanup unchanged; the `needs_password` state must never depend on that temp file surviving the route's `finally`.
- The OOXML CFBF-magic half of KK20-190 is unaffected — no password nuance there.
- This is a `[knauf]` change to an already-`[knauf]`-marked function. `SEAMS.md` is append-only per ticket: **add a new KK20-232 row** for the modified `detectEncryptedFileAtPath` behaviour (and its test attribution) and **leave the existing KK20-190 rows intact** — do not rewrite the KK20-190 history or reassign its test attribution. The two rows together document the seam's evolution.
- **Ordering constraint with content-hash dedup (KK20-204).** In `api/server/routes/files/files.js` the encryption check (`detectEncryptedFileAtPath`, ~L772) and the content hash (`computeContentHash` → `knauf_content_hash`, ~L810) both read the **same** temp file at adjacent points in the upload flow — KK20-204 deliberately takes the hash "at the encryption-check spot." Phase 1 changes the *classification decision* at that spot but **must not reorder or short-circuit the flow** such that the hash is computed on different bytes or skipped: the hash keys off the **original uploaded bytes** and is unaffected by the later creation of `worker_blob`. Preserve the existing sequence — classify, then hash the same original bytes — so dedup identity stays stable.

### Phase 2 — Case-C decrypt pre-processing
Case B needs no strip-security step for correctness. After Phase 1 admits the file, the original PDF follows the existing raw-PDF `file_search` path and the deployed pypdf fallback can open it with an empty password. Do not add an alternate API-side conversion path.

**Case C always needs a durable decrypted PDF before it can be queued.** Use `qpdf` (permissively licensed, mature) to decrypt a server-side materialization of the stored encrypted original.

Implementation requirements:
- Supply the password through stdin with `--password-file=-`, never through argv, filenames, logs, or job payloads.
- Run with a timeout, output-size cap, restrictive temp permissions, and sanitized stderr handling.
- Azure DI has no password parameter, so qpdf must produce the readable PDF that the normal RAG path later submits.
- Persist the qpdf output through the configured file strategy as an internal-only `worker_blob`; do not persist extracted text or the password.
- Preserve PDF MIME/filename metadata so the existing `generationRagClient` and `rag_api` loader selection remain unchanged.
- Only after `worker_blob` is durable may the asset transition `needs_password → queued` or be synchronously claimed.
- On partial failure, delete any newly created `worker_blob`, keep the encrypted original, and leave the asset recoverably in `needs_password`.

The worker and any synchronous claim path use `worker_blob` when present and otherwise use the existing original `blob`. This gives retries a durable readable PDF while keeping the password out of Mongo, queues, and worker execution. Phase 4 defines ownership and cleanup for both artifacts.

- Rejected alternatives: `pdf-lib` (can't load encrypted PDFs at all); MuPDF/PyMuPDF (`fitz`) — AGPL-licensed, a commercial-licensing risk for a closed product. `knauf/parser-eval`'s use of `fitz` is eval-tooling only, never shipped in the production image, so it sets no precedent for shipping AGPL code there.
- Add `qpdf` to the API Docker image — a root Dockerfile change with its own KK20-232 SEAMS.md row.

### Phase 3 — Password-entry UX for case C
- Add a `'needs_password'` state to the existing async-indexing state machine, alongside `uploading/queued/processing/ready/failed/...`. Unlike the other pending states, it does **not** resolve on its own by polling — it requires a user gesture. **This is a net-new extension of the *shipped* KK20-195 machine, not a greenfield state.** The authoritative server-side machine is `packages/data-schemas/src/schema/fileAsset.ts` + `packages/data-schemas/src/methods/fileAsset.ts`; the client mirror is `client/src/knauf/common/fileIndexing.ts`. Define explicit single-document CAS transitions:
  - `uploading → needs_password` after the encrypted original is durable;
  - `needs_password → queued` after the internal decrypted PDF is durable;
  - `needs_password → failed/cancelled` on expiry or cancellation.
  A `needs_password` asset is inert to worker claims and the reconciler's automatic retry loop. Do **not** model it only on the client enum, and do not enter it from `queued`/`processing` as the primary flow.
- **Deployment reality (verified 2026-08-05):** the async pipeline exposes three independent flags (`asyncIndexingConfig.js`): `KNAUF_ASYNC_FILE_INDEXING_ACCEPT` (upload returns 202 + queues), `KNAUF_INDEXING_WORKER_ENABLED` (the dedicated worker claims queued work), and `KNAUF_ASYNC_INDEXING_TENANTS` (canary allow-list). Dev+prod GitOps currently set **only** `..._ACCEPT="true"`; `KNAUF_INDEXING_WORKER_ENABLED` is **unset**, so the dedicated worker process is **not** claiming work in prod today. Phase 3/4 must therefore not assume `indexingWorker.js` is the component performing (re)extraction in prod — the `needs_password` → extraction transition must work whether embedding runs inline in the accept-path / reconciler or in the (currently-off) dedicated worker.
- **Split the single `isIndexingPending` predicate into distinct concerns before adding the state.** Today `isIndexingPending` conflates four behaviours — whether to keep polling, whether to block chat send (`hasPendingIndexing`), whether the state is terminal (`isIndexingTerminal`), and how the per-file status renders. `needs_password` needs different answers to each: it must **stop polling** (no automatic resolution to wait for), stay **non-terminal** (it is not `ready` and not `failed`), stay **visible** with the password action rendered, and keep **send blocked** (the file isn't usable yet). Introduce separate predicates so these can diverge, e.g.:
  - `shouldPollIndexing(indexing)` — true for `queued`/`processing`/`uploading`, **false** for `needs_password` (and for terminal states). Drives the polling loop only.
  - `blocksChatSend(indexing)` — true for every non-`ready` non-terminally-failed state **including** `needs_password`. Drives `hasPendingIndexing` / send-disable.
  - Keep `isIndexingTerminal` for workflow-terminal states (`ready` and terminal failure/cancellation). `needs_password` is non-terminal but polling-inert, so it must not be folded into either the old pending or terminal bucket.
  - The existing `isIndexingPending` either becomes an alias of `blocksChatSend` or is retired at its call sites; every current caller must be re-pointed at whichever of the new predicates matches its actual intent (audit all four call sites: the polling hook, `hasPendingIndexing`, `isIndexingTerminal`, and the list-level `hasPendingIndexing` over query rows).
- On the probe's case-C classification, the upload flow stores the original and responds with the file in `needs_password` state instead of a hard failure.
- Client renders a password-entry modal, reusing the existing per-file status UI slot (`KnaufChatFileIndexingStatus` / `KnaufFileIndexingStatus`).
- User submits the password (request body, never a query string) against the same `file_id`; server re-attempts opening with the supplied password:
  - Wrong password → generic error ("incorrect password"), retry allowed.
  - Rate-limited per `(user, file_id)` — a handful of attempts, then cooldown — this is a password-guessing surface, treated like a login rate limiter.
  - Correct password → create the internal decrypted PDF, then move `needs_password → queued`; normal claim/processing then leads to `ready`.
- The password itself is never logged, never written to Mongo, never put on a queue/job payload, and is never passed to the async indexing worker. It lives only in the memory of the single request that verified it.

### Phase 4 — Own two PDF artifacts, never the password
The direct answer to "persist the password, or do something extra" is: decrypt once, persist the decrypted PDF, never persist the secret.

For case C, `KnaufFileAsset` owns two descriptors with distinct roles:
- **`blob` — encrypted original:** byte-identical user-facing download/citation/provenance artifact and the source for content-hash dedup.
- **`worker_blob` — decrypted PDF:** internal-only RAG input used by synchronous embedding, the dedicated worker, reconciliation, and later retry/re-embed operations. It must never be exposed by download APIs or client payloads.

Cases A and B keep the existing single-artifact shape: `blob` is both the user-facing original and worker input, and `worker_blob` is absent.

#### Two-artifact lifecycle for case C
- **Authorization:** only the uploading user, with the existing parent-message/agent ownership checks, may submit a password for `(user, file_id)`.
- **Success:** materialize `blob`, decrypt to a temp PDF, persist `worker_blob`, then CAS `needs_password → queued`. If the CAS loses a race, clean the newly persisted descriptor unless it is the descriptor already committed by the winner.
- **Worker selection:** centralize selection of `worker_blob ?? blob` so synchronous and asynchronous paths cannot diverge.
- **Expiry / cancellation before success:** purge the encrypted original and any partial worker blob, then move the logical file/asset to the existing terminal deletion/failure semantics.
- **Deletion after success:** `fileAssetDelete.js`, retention jobs, reconciler cleanup, and cancellation paths delete both unique descriptors. Deduplicate by storage identity before deleting in case both fields ever reference the same object.
- **Retry/reconciliation:** preserve `worker_blob` while work can retry; cleanup happens only when the asset is deleted, cancelled, or reaches the repository's normal retention boundary.
- **Download/citation:** resolve only `blob`; never fall back to `worker_blob`.

### Phase 5 — Permission-flag metadata capture (groundwork only, no enforcement)
Capture the observation on the physical `KnaufFileAsset`, not primarily on each logical `File`, because permission flags describe the stored PDF bytes and one physical asset may back multiple logical references.

Use a versioned tri-state record:
- `classification`: `known_restricted | known_unrestricted | unknown`;
- individual normalized permissions (print/copy/modify/annotate/form-fill/assemble/extract);
- `open_password_required`;
- parser/schema version and `observed_at`.

Populate it from the Phase 1 empty-password probe or the successful Phase 3 password-verified open. Existing assets remain `unknown`; this plan does not claim retroactive coverage, and KK20-253 still needs an explicit re-probe/backfill or re-upload strategy for them. Permission flags are governance inputs only, not an authorization boundary: do not gate, block, or filter agent creation, chat, asset listing, download, or RAG behavior in this ticket.

### Phase 6 — Docs and seam bookkeeping
Update `knauf/docs/architecture/files/processing.md`, `knauf/docs/architecture/files/rag-search.md`, `knauf/docs/architecture/files/async-indexing.md`, and `SEAMS.md` to reflect classification, the two-artifact lifecycle, and the production-OFF dedicated worker. Adding `qpdf` to the API image is a root Dockerfile seam with its own KK20-232 row. This plan does not require a `rag_api` code change.

## Compliance / GDPR non-negotiables

1. The password is never written to any log line, including error messages and stack traces — scrub it explicitly.
2. The password is never persisted to Mongo, Redis, a queue/job payload, or any file on disk.
3. The password never crosses into the async indexing worker's execution path — by Phase 4's design, it doesn't need to.
4. Rate-limit password attempts per `(user, file_id)` to bound the password-guessing surface.
5. Audit-log the *event* (attempted / succeeded / failed) without ever logging the *value* — ties into the existing `S4` audit-logging gap already tracked in `knauf/docs/future-work/file-management-roadmap.md`.

## Open risks / questions carried into implementation

- The optional live Azure DI case-B probe remains a quality question only. It is not an implementation gate and must not reintroduce a second case-B storage or parsing branch.
- Azure DI has **no native password/decrypt parameter**. Case C therefore depends on qpdf availability in every API runtime that can accept the password request, plus parity between the worker-enabled and worker-disabled claim paths.
- The two-artifact schema increases cleanup risk. Implementation is blocked until deletion, cancellation, TTL expiry, failed persistence, CAS-race loss, and retention paths all prove they delete both unique descriptors without exposing `worker_blob`.
- Existing assets have no trustworthy permission observation. KK20-253 must explicitly choose re-probe/backfill, re-upload, or permanent `unknown`; this plan cannot promise retroactive governance.
- Rate-limit thresholds/cooldown windows for password attempts aren't decided — proposal is to reuse whatever constants the existing auth login rate-limiter uses rather than invent new ones.
- Whether KK20-232 should be treated as a standalone bug fix (this plan) independent of KK20-253's refinement, or whether it should wait — raised in the investigation dossier, not resolved there; this plan proceeds on the basis that Phases 1–4 (encryption misclassification + password UX) are correct regardless of how KK20-253's policy question resolves, since they don't enforce any permission policy themselves.

## Still pending

- [ ] Review from `AlexZahar` and `jorgecostak` on this plan.
- [x] Phase 0 verification spike — static + library level (see "Phase 0 result", run 2026-08-05).
- [ ] Phases 1–6 implementation, each as its own PR against its own `fix/KK20-232-...` branch once this plan is approved.

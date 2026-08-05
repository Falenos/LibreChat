# Plan: PDF Password/Permission Handling (KK20-232)

**Generated:** 2026-07-20
**Status:** Proposed — rev 4. First review round (`AlexZahar`, 4 HIGH findings) addressed in rev 2; rev 3 corrected the PDF-routing model after verifying `process.js`. **rev 4 folds in a completed Phase 0 spike (run 2026-08-05 against the real KK20-232 PDF) plus a verification of the deployed rag_api / infra reality**: (a) Azure DI runs *inside* the `rag_api` sidecar, not LibreChat's Node `ocr:` strategy; (b) `rag_api` wraps DI in `_AzureDIWithFallback`, which falls back to `PyPDFLoader` on *any* DI error; (c) the empirical result is that case B already extracts end-to-end in **both** paths today; (d) the born-digital DI-skip exists but is OFF in dev+prod; (e) the dedicated async indexing worker is OFF in prod (`KNAUF_INDEXING_WORKER_ENABLED` unset); (f) `needs_password` is a net-new extension of the shipped `KnaufFileAsset` state machine, not greenfield. Awaiting re-review from `AlexZahar` and `jorgecostak` before any implementation PR is opened
**Owner:** Agentic Karl maintainers
**Ticket:** [KK20-232](https://knauf.atlassian.net/browse/KK20-232) — champion blocked from uploading a PDF that has no open password, only an owner/permissions password
**Related:** [KK20-253](https://knauf.atlassian.net/browse/KK20-253) (unrefined data-governance spike), [KAPF-74](https://knauf.atlassian.net/browse/KAPF-74) (older, similar report)
**Investigation dossier:** `local/kk20-253-pdf-permission-governance/` (git-ignored, not part of this doc's history — the facts-only research that led here: ticket data, screenshots, sample PDF, Confluence search results)

## Objective

Stop rejecting PDFs at upload time that don't actually need a password to read, without inventing a permission-enforcement policy this repo has no mandate to decide. Cover the real failure mode in KK20-232 correctly, add a genuine password-entry path for the rare case where a PDF truly can't be opened without one, and do it in a way that's compliant (never persist the password) and doesn't block the async indexing architecture already in place.

## Scope

**In scope:** the chat / agent-knowledge-base RAG upload flow only (`POST /api/files` → `processAgentFileUpload` / `processFileUpload`). For PDFs this flow always extracts text at upload (configured OCR or the `document_parser` fallback) and embeds that text; it does not embed raw PDF bytes (see "How PDFs actually flow"). This is KK20-232's actual scenario.

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

Both `processAgentFileUpload` and `processFileUpload` share the same extract-then-store logic. `application/pdf` is in `documentParserMimeTypes` (`packages/data-provider/src/file-config.ts`), so `shouldUseOCR = shouldUseConfiguredOCR || shouldUseDocumentParser` is **always true for a PDF**. The function therefore **always extracts text and returns `createTextFile(...)` (≈ line 975) before it ever reaches the `tool_resource === 'file_search'` dual-storage / `uploadVectors` → `rag_api` branch** (≈ line 1020). Consequences that reshape this plan:

1. **A PDF is never embedded as raw bytes on the RAG path.** It is converted to a plaintext text file at upload time; the async indexing worker (`indexingWorker.js`) later re-embeds that *text* (via `claim.blob`), never a PDF container. So there is no scenario where an *encrypted PDF blob* is handed to the worker — the earlier framing of "persist stripped-security PDF bytes for the worker" does not apply to this path. What must be decrypted is the single **upload-time extraction call**; what gets persisted is the extracted **text**.
2. **There is already a silent OCR→document_parser fallback** (`resolveDocumentText`, lines 944–958): if the configured OCR strategy throws, the Node code falls back to `document_parser` (`pdfjs-dist`), which opens a case-B PDF with an empty password. This means **case B may already succeed end-to-end today via the fallback**.

3. **Azure DI is *not* LibreChat's Node `ocr:` strategy on this deployment — it runs inside the `rag_api` sidecar** (verified against `agentic-karl-rag-api@origin/main` and the deployed GitOps values, 2026-08-05). `librechat.yaml` has no `ocr:` block; instead `rag_api` is configured with `RAG_AZURE_DI_*` and routes PDFs through `app/utils/document_loader.py`'s `_AzureDIWithFallback`. That loader's `.load()` catches **every** exception from the DI call and silently falls back to `SafePyPDFLoader` → `PyPDFLoader` (pypdf). `rag_api` has **zero** password/decrypt code. So on the `file_search`/rag_api path there is a **second** independent case-B safety net beneath the Node one: even if Azure DI rejects a locked-but-openable PDF, pypdf opens it with an empty password. (A newer KK20-192 born-digital short-circuit — `routing.pdf_needs_di` gated on `RAG_AZURE_DI_PDF_MIN_TEXT_CHARS` — can skip DI entirely for text-dense PDFs, but it is set to `"0"` (OFF) in both dev and prod GitOps, so today every PDF still takes the DI-with-fallback path.)

## Phase 0 result (spike run 2026-08-05 — resolves the "is Phase 1 the whole fix?" question)

The open question was whether "stop rejecting case B at the Node gate" is the *entire* fix for KK20-232, or whether an Azure-DI strip-security step (Phase 2a) is also required. Phase 0 was run against the **actual KK20-232 sample PDF** (`local/kk20-253-pdf-permission-governance/attachments/Knauf Group Standard on Local Market Release.pdf`) and the **deployed** rag_api dependency versions. Results:

| Layer | Tool | Result on the case-B sample |
|---|---|---|
| Static encryption dict | raw scan | `/Filter/Standard /V 5 /R 6` AESV3 (256-bit), `/P -1324` → **owner-password-only (case B confirmed)** |
| Node extraction | `pdfjs-dist` (`document_parser`) | Opens with empty password; **18 pages**; page-1 text extracted; `getPermissions()` = `[4,16,512,2048]` (print + copy-for-accessibility + fill-forms + assemble allowed; modify/annotate/extract denied) |
| RAG extraction | `pypdf==6.13.3` + `cryptography` (rag_api's pinned versions) | `is_encrypted = True`, but **reads all 18 pages** via pypdf's empty-password auto-attempt; page-1 text extracted |

**Conclusion: case B already extracts successfully in *both* code paths today.** The over-rejection is caused solely by the upload-time `/Encrypt` byte-sniff gate (`detectEncryptedFileAtPath`) — the file is blocked *at the door* and never reaches either extractor. There are now **two** independent case-B safety nets downstream of that gate:
1. Node `resolveDocumentText`: on OCR failure, falls back to `document_parser` (`pdfjs-dist`), which opens case B with an empty password.
2. rag_api `_AzureDIWithFallback`: on *any* Azure DI failure, falls back to `PyPDFLoader` (pypdf), which opens case B with an empty password.

So **Phase 2a (case-B strip-security via `qpdf`) is NOT required for correctness** — it is at most a quality optimisation to route case B through Azure DI's richer markdown extraction instead of the pypdf fallback. Whether even that optimisation is worth it depends on one **remaining, deliberately-unresolved empirical gap**: *does the deployed Foundry Azure DI resource actually reject a locked-but-openable (case-B) PDF, or accept it?* That was not probed because it calls a live billed endpoint with a real key (see "Deliberately not run" below). Either way the fallback guarantees correctness; the gap only affects extraction quality, i.e. whether 2a has any value.

Phase 0 has **no bearing on 2b** (case-C decrypt), which is unconditional regardless.

**Deliberately not run:** a live call to the deployed Foundry Azure DI endpoint (`RAG_AZURE_DI_ENDPOINT = https://foundry-agk-hub-{nonprod,prod}-swedencentral-001.services.ai.azure.com/`) with the sample. It uses a real key and incurs cost, and the answer only tunes the optional 2a — it does not change the correctness verdict. If we later want to decide 2a definitively, this is the one call to make.

> Azure DI's documented input requirement remains *"If your PDFs are password-locked, you must remove the lock before submission"* ([Azure DI v4.0 GA layout — Input requirements](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0#input-requirements)), and Microsoft does not distinguish case B from case C in that wording. But because Azure DI here is wrapped by `_AzureDIWithFallback`, a DI rejection degrades to pypdf rather than failing the upload — which is exactly why the doc wording no longer forces Phase 2a.

## Work packages

### Phase 0 — Verification spike (largely complete; one live-DI probe deferred)
**Status: mostly resolved — see "[Phase 0 result](#phase-0-result-spike-run-2026-08-05--resolves-the-is-phase-1-the-whole-fix-question)" above.** The static + library-level questions are answered: the real KK20-232 PDF is confirmed case B, and it extracts successfully via **both** `pdfjs-dist` (Node `document_parser`) and `pypdf` (rag_api's `PyPDFLoader` fallback). The **only** part not yet run is a **live call to the deployed Foundry Azure DI endpoint** to observe whether DI itself accepts or rejects the case-B file — deferred because it calls a billed endpoint with a real key, and its answer only tunes the *optional* Phase 2a (it cannot change the correctness verdict, which the fallbacks already guarantee). Run that one probe only if we want to settle Phase 2a definitively. Phase 0 does **not** gate Phase 2b (case-C decrypt), which is unconditional.

#### How this was tested (reproducible)
Run on 2026-08-05 against `local/kk20-253-pdf-permission-governance/attachments/Knauf Group Standard on Local Market Release.pdf`:
- **Encryption dict:** raw byte scan of the trailer `/Encrypt` dictionary → `/Filter/Standard /V 5 /R 6` (AESV3, 256-bit), `/P -1324` (owner-password-only permission mask).
- **Node path:** `pdfjs-dist` legacy build (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`), `getDocument({ data })` with **no** password argument → resolved (empty-password auto-attempt), `numPages = 18`, page-1 `getTextContent()` non-empty, `getPermissions()` = `[4,16,512,2048]`. Node v24.16.0.
- **RAG path:** a throwaway venv pinned to rag_api's exact deps (`pypdf==6.13.3`, `cryptography`), `PdfReader(path)` → `is_encrypted = True` yet `len(reader.pages) == 18` and `pages[0].extract_text()` non-empty (pypdf's empty-password auto-attempt; this is precisely what `PyPDFLoader`/`SafePyPDFLoader` do). `cryptography` is required for the AESV3 branch and is present in rag_api's `requirements.txt`.
- **Not run:** `POST` of the sample to the live Foundry Azure DI endpoint. `qpdf`/`pdftk` were also not exercised (not installed locally; `qpdf` install is a Phase 2 concern, not Phase 0).

### Phase 1 — Fix the over-broad Node gate
Replace the byte-sniffed `/Encrypt`-trailer heuristic in `detectEncryptedFileAtPath` with a real classification: attempt to open the PDF with an empty password via `pdfjs-dist` (already a dependency) as a cheap upload-time probe.
- Empty-password success → case A/B → allow the upload through unchanged.
- `PasswordException` (`NeedPassword`/`IncorrectPassword`) → case C → do not reject; return a distinct "needs password" outcome (Phase 3).
- The OOXML CFBF-magic half of KK20-190 is unaffected — no password nuance there.
- This is a `[knauf]` change to an already-`[knauf]`-marked function. `SEAMS.md` is append-only per ticket: **add a new KK20-232 row** for the modified `detectEncryptedFileAtPath` behaviour (and its test attribution) and **leave the existing KK20-190 rows intact** — do not rewrite the KK20-190 history or reassign its test attribution. The two rows together document the seam's evolution.
- **Ordering constraint with content-hash dedup (KK20-204).** In `api/server/routes/files/files.js` the encryption check (`detectEncryptedFileAtPath`, ~L772) and the content hash (`computeContentHash` → `knauf_content_hash`, ~L810) both read the **same** temp file at adjacent points in the upload flow — KK20-204 deliberately takes the hash "at the encryption-check spot." Phase 1 changes the *classification decision* at that spot but **must not reorder or short-circuit the flow** such that the hash is computed on different bytes or skipped: the hash keys off the **original uploaded bytes** and is (correctly) unaffected by any later decrypt-at-extraction. Preserve the existing sequence — classify, then hash the same original bytes — so dedup identity stays stable.

### Phase 2 — Strip-security pre-processing
This phase has two separately-scoped decrypt responsibilities. Do not conflate them: Phase 0's outcome governs only the *case-B* branch; the *case-C* branch is unconditional.

**2a — Case-B strip-security (conditional on Phase 0).** Only build if Phase 0 shows the production OCR strategy rejects owner-password-only (case-B) PDFs outright. Mechanism: `qpdf` (permissively licensed, mature) invoked as a subprocess to produce a plaintext-security PDF byte stream before handing bytes to whichever OCR/parsing strategy is active. Skip 2a entirely if Phase 0 shows Phase 1 alone is sufficient for case B — don't add an infra dependency the code doesn't need for the common case.

**2b — Case-C decrypt-at-extraction (unconditional, always ships with Phase 3/4).** This is *not* gated on Phase 0. Because PDFs are always text-extracted at upload (see "How PDFs actually flow"), "decrypt the file" for case C concretely means **supply the verified password to the single upload-time extraction call** and persist the resulting **text**:
- `document_parser` route: pass the password through to `pdfjs-dist`'s `getDocument({ data, password })`; the extracted text is what's stored.
- Azure DI route: Azure DI has no password parameter, so the password must be used to produce a decrypted byte stream first (`qpdf --password=… --decrypt`) which is then handed to Azure DI for extraction. This is the one place case C *does* need `qpdf` even when 2a was skipped for case B.

The invariant Alex's finding #2 protects still holds and is the reason 2b is unconditional: the async indexing worker receives only the persisted artifact (extracted text) and never the password (Compliance §3). What it must **never** receive is a still-encrypted PDF it can't open — and by extracting text at upload with the password in hand, it never does. Phase 4 defines exactly what gets persisted.

- Rejected alternatives: `pdf-lib` (can't load encrypted PDFs at all); MuPDF/PyMuPDF (`fitz`) — AGPL-licensed, a commercial-licensing risk for a closed product. `knauf/parser-eval`'s use of `fitz` is eval-tooling only, never shipped in the production image, so it sets no precedent for shipping AGPL code there.
- If 2b ships (i.e. whenever Phase 3 ships), `qpdf` is added to the API Docker image — a root Dockerfile change, its own SEAMS.md row — regardless of the 2a decision.

### Phase 3 — Password-entry UX for case C
- Add a `'needs_password'` state to the existing async-indexing state machine, alongside `uploading/queued/processing/ready/failed/...`. Unlike the other pending states, it does **not** resolve on its own by polling — it requires a user gesture. **This is a net-new extension of the *shipped* KK20-195 machine, not a greenfield state.** The authoritative server-side machine is `packages/data-schemas/src/schema/fileAsset.ts` + `packages/data-schemas/src/methods/fileAsset.ts` (the 7-state `KnaufFileAsset` with `execution_token` + generation fencing and single-doc CAS transitions), driven by `api/server/services/Files/knauf/fileSearchAssetLifecycle.js`; the client mirror is `client/src/knauf/common/fileIndexing.ts` (`KnaufFileIndexingStatus`). Implementation must define `needs_password` as a first-class state in **both**: which CAS transitions may enter it (from `processing`/`queued` when extraction hits `PasswordException`) and leave it (`needs_password → processing` on verified password, `needs_password → failed`/cancelled on TTL expiry), and how it interacts with the reconciler (`indexingReconciler.js`) — a `needs_password` asset must be inert to the reconciler's retry loop, since there is nothing to retry without the user. Do **not** model it only on the client enum.
- **Deployment reality (verified 2026-08-05):** the async pipeline exposes three independent flags (`asyncIndexingConfig.js`): `KNAUF_ASYNC_FILE_INDEXING_ACCEPT` (upload returns 202 + queues), `KNAUF_INDEXING_WORKER_ENABLED` (the dedicated worker claims queued work), and `KNAUF_ASYNC_INDEXING_TENANTS` (canary allow-list). Dev+prod GitOps currently set **only** `..._ACCEPT="true"`; `KNAUF_INDEXING_WORKER_ENABLED` is **unset**, so the dedicated worker process is **not** claiming work in prod today. Phase 3/4 must therefore not assume `indexingWorker.js` is the component performing (re)extraction in prod — the `needs_password` → extraction transition must work whether embedding runs inline in the accept-path / reconciler or in the (currently-off) dedicated worker.
- **Split the single `isIndexingPending` predicate into distinct concerns before adding the state.** Today `isIndexingPending` conflates four behaviours — whether to keep polling, whether to block chat send (`hasPendingIndexing`), whether the state is terminal (`isIndexingTerminal`), and how the per-file status renders. `needs_password` needs different answers to each: it must **stop polling** (no automatic resolution to wait for), stay **non-terminal** (it is not `ready` and not `failed`), stay **visible** with the password action rendered, and keep **send blocked** (the file isn't usable yet). Introduce separate predicates so these can diverge, e.g.:
  - `shouldPollIndexing(indexing)` — true for `queued`/`processing`/`uploading`, **false** for `needs_password` (and for terminal states). Drives the polling loop only.
  - `blocksChatSend(indexing)` — true for every non-`ready` non-terminally-failed state **including** `needs_password`. Drives `hasPendingIndexing` / send-disable.
  - Keep `isIndexingTerminal` meaning "no further change without user action *or* polling"; `needs_password` is non-terminal but polling-inert, so it must not be folded into either the old pending or the old terminal bucket.
  - The existing `isIndexingPending` either becomes an alias of `blocksChatSend` or is retired at its call sites; every current caller must be re-pointed at whichever of the new predicates matches its actual intent (audit all four call sites: the polling hook, `hasPendingIndexing`, `isIndexingTerminal`, and the list-level `hasPendingIndexing` over query rows).
- On `PasswordException`, the upload flow responds with the file in `needs_password` state instead of a hard failure.
- Client renders a password-entry modal, reusing the existing per-file status UI slot (`KnaufChatFileIndexingStatus` / `KnaufFileIndexingStatus`).
- User submits the password (request body, never a query string) against the same `file_id`; server re-attempts opening with the supplied password:
  - Wrong password → generic error ("incorrect password"), retry allowed.
  - Rate-limited per `(user, file_id)` — a handful of attempts, then cooldown — this is a password-guessing surface, treated like a login rate limiter.
  - Correct password → proceed to extraction/embedding (Phase 4), file moves `processing` → `ready` as normal.
- The password itself is never logged, never written to Mongo, never put on a queue/job payload, and is never passed to the async indexing worker. It lives only in the memory of the single request that verified it.

### Phase 4 — Persist the decrypted artifact, never the password
The direct answer to "persist the password, or do something extra": do the something extra — decrypt once, persist the *output*, never the secret.
- Once a case-C password is verified (Phase 3, used at extraction via Phase 2b) or a case-B file passes through (Phase 1, plus Phase 2a only if Phase 0 required it), extract the plaintext content **once, at upload time**, and store that extracted text as the durable artifact the rest of the pipeline — including the KK20-195 async indexing worker's later retries/re-embeds — operates on. On the verified RAG path for PDFs this is the **only** durable content artifact: there is no persisted PDF blob for the worker, because the worker embeds the extracted text (`createTextFile`, `source: FileSources.text`), so no new storage shape is needed for the *indexed* content at all.
  - The original, byte-identical uploaded file is retained separately for download/citation purposes only — returning it never requires the password again (the user already has their own copy).
  - Content-hash dedup (the `T1` item in `knauf/docs/future-work/file-management-roadmap.md`) keys off the original uploaded bytes and is unaffected — hashing doesn't need decryption.
- Net effect: `indexingWorker.js`, which can retry embeds minutes-to-hours later on backoff, never needs the password again — it only ever touches the already-extracted persisted text.
- (The "persist stripped-security PDF bytes for the worker" storage shape is **not** needed on this path and has been removed from the plan; it would only apply to a hypothetical route that embedded raw PDF bytes, which the deferred native-multimodal follow-up — not this plan — would own.)

#### Retained-ciphertext lifecycle for the `needs_password` window (case C only)
The subtlety is **not** two coexisting *indexed* blobs — the only durable indexed artifact is the extracted text (see above). The subtlety is that case C must **retain the original encrypted bytes across an asynchronous, user-driven gap**: the `needs_password` response is returned and the request ends, but extraction can only happen *later*, once the user supplies the password. Today the upload route unconditionally `fs.unlink`s its temp file in a `finally` block (`files.js`) and `KnaufFileAsset` owns exactly one blob, so there is nowhere for those bytes to live during that gap. That retention must be added, with a full lifecycle:
  - **Storage & ownership:** the original encrypted bytes are moved out of the ephemeral upload temp dir into a durable store keyed by `(user, file_id)` before the `needs_password` response returns (so the `finally` unlink doesn't destroy them). Decide whether they are owned by `KnaufFileAsset` (a new field on `packages/data-schemas/src/schema/fileAsset.ts`, with matching methods in `.../methods/fileAsset.ts`) or a separate short-lived store. If owned by `KnaufFileAsset`, the retained-ciphertext blob is a **second** blob the asset transiently owns — the shipped machine assumes one blob per asset and its delete path cleans exactly that one, so the schema, the CAS transitions, and `fileSearchAssetLifecycle.js`'s cleanup must be extended to know about and reclaim this transient blob (otherwise the "retained originals survive deletion" failure Alex flagged reappears).
  - **Authorization:** only the uploading user (matching `(user, file_id)`) may submit a password against them; these bytes are never returned to any client.
  - **Expiry / cancellation:** a bounded TTL — if no valid password arrives within the window (or the user cancels), purge the bytes and move the file to a terminal `failed`/cancelled state. Independent of the password-attempt rate-limit cooldown.
  - **Reconciliation on success:** on correct password, run extraction *once* with the password, persist the extracted **text** (the indexed artifact), then purge the retained ciphertext (unless it doubles as the download/citation original — below), and transition `needs_password` → `processing`.
  - **Download original:** if the product keeps a downloadable original, decide explicitly whether that role is served by these retained bytes (kept past extraction) or a separate copy — but never silently keep ciphertext forever under the guise of "the original."
  - **Deletion / cascade:** deleting the `File` purges the retained ciphertext (and cancels any TTL-scheduled purge) as well as the extracted-text artifact; nothing orphaned survives.
- Cases A and B never enter `needs_password`, so they need **no** retained ciphertext — they extract inline at upload and follow the existing single-artifact (extracted-text) path unchanged.

### Phase 5 — Permission-flag metadata capture (groundwork only, no enforcement)
While a PDF is open (Phase 1's probe, or Phase 3's password-verified open), also read its permission flags (print/copy/modify/annotate/form-fill/assemble/extract) and store them as metadata on the `File` document. Do not gate, block, or filter anything based on these flags in this plan — this is purely so that whenever KK20-253 lands a policy, it has data to act on retroactively instead of needing a second migration/backfill pass. Tie this back to KK20-253's three boundaries (agent creation / chat / asset list) with a short code comment pointing at the ticket.

### Phase 6 — Docs and seam bookkeeping
Update `knauf/docs/architecture/files/processing.md` and `SEAMS.md` to reflect the new classification and password flow once Phases 1–5 land. If Phase 2b adds `qpdf` to the rag_api or API image or touches `_AzureDIWithFallback`, also reconcile `knauf/docs/architecture/files/rag-search.md` and the `agentic-karl-rag-api` `SEAMS.md`. If Phase 3/4 relies on the dedicated worker, coordinate with `knauf/docs/architecture/files/async-indexing.md` (which records the worker as production-OFF) and the `KNAUF_INDEXING_WORKER_ENABLED` rollout.

## Compliance / GDPR non-negotiables

1. The password is never written to any log line, including error messages and stack traces — scrub it explicitly.
2. The password is never persisted to Mongo, Redis, a queue/job payload, or any file on disk.
3. The password never crosses into the async indexing worker's execution path — by Phase 4's design, it doesn't need to.
4. Rate-limit password attempts per `(user, file_id)` to bound the password-guessing surface.
5. Audit-log the *event* (attempted / succeeded / failed) without ever logging the *value* — ties into the existing `S4` audit-logging gap already tracked in `knauf/docs/future-work/file-management-roadmap.md`.

## Open risks / questions carried into implementation

- Phase 0 is now largely resolved (see "Phase 0 result"): case B extracts end-to-end **today** in both paths, so **Phase 2a** (case-B strip-security) is confirmed *not* a correctness requirement — it is at most a quality optimisation to route case B through Azure DI's markdown extraction instead of a pypdf fallback. The one residual empirical gap is whether the deployed Foundry Azure DI resource itself accepts or rejects case B; it only tunes 2a and does not change correctness. Phase 2b (case-C decrypt-at-extraction) ships regardless. The deferred native-multimodal follow-up commits to strip-security independently of this plan.
- Azure DI has **no native password/decrypt parameter** — confirmed against the v4.0 GA docs, which instead require the caller to *"remove the lock before submission."* On this deployment Azure DI runs inside `rag_api` and is wrapped by `_AzureDIWithFallback`, which degrades to `PyPDFLoader` on any DI error — so a case-**B** rejection by DI is caught by pypdf's empty-password open, and `qpdf` for case B (Phase 2a) stays optional. Case **C** still needs a `qpdf --decrypt` pre-strip (Phase 2b) before Azure DI, because the password can't be handed to DI directly and pypdf cannot open a true open-password PDF without it either.
- Rate-limit thresholds/cooldown windows for password attempts aren't decided — proposal is to reuse whatever constants the existing auth login rate-limiter uses rather than invent new ones.
- Whether KK20-232 should be treated as a standalone bug fix (this plan) independent of KK20-253's refinement, or whether it should wait — raised in the investigation dossier, not resolved there; this plan proceeds on the basis that Phases 1–4 (encryption misclassification + password UX) are correct regardless of how KK20-253's policy question resolves, since they don't enforce any permission policy themselves.

## Still pending

- [ ] Review from `AlexZahar` and `jorgecostak` on this plan.
- [x] Phase 0 verification spike — static + library level (see "Phase 0 result", run 2026-08-05).
- [ ] Phase 0 — optional live Foundry Azure DI probe (only if we want to settle Phase 2a definitively).
- [ ] Phases 1–6 implementation, each as its own PR against its own `fix/KK20-232-...` branch once this plan is approved.

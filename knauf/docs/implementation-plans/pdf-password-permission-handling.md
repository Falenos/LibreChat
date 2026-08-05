# Plan: PDF Password/Permission Handling (KK20-232)

**Generated:** 2026-07-20
**Status:** Proposed — rev 3. First review round (`AlexZahar`, 4 HIGH findings) addressed in rev 2; rev 3 corrects the PDF-routing model after verifying `process.js` (PDFs are always text-extracted at upload, never embedded as raw bytes; a silent OCR→`document_parser` fallback already handles case B). Awaiting re-review from `AlexZahar` and `jorgecostak` before any implementation PR is opened
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
2. **There is already a silent OCR→document_parser fallback** (`resolveDocumentText`, lines 944–958): if the configured OCR strategy (e.g. Azure DI) throws, the code falls back to `document_parser` (`pdfjs-dist`), which opens a case-B PDF with an empty password. This means **case B may already succeed end-to-end today via the fallback**, even against an Azure-DI-configured environment — which materially weakens the "Phase 2a is required" default (see Phase 0). Phase 0 must measure the *fallback* outcome, not just the primary OCR call.

## Open question this plan does not assume an answer to

Whether "stop rejecting case B at the Node gate" is the *entire* fix, or whether more is needed, depends on what happens downstream, and is not yet verified:

- If no OCR is configured for PDFs, `processAgentFileUpload` routes through Node's own `document_parser` strategy (`packages/api/src/files/documents/crud.ts` → `pdfToText` → `pdfjs-dist`'s `getDocument()`), which already tries an empty password automatically and only throws `PasswordException` for a genuine case C. If this is what's active in a given environment, Phase 1 alone is sufficient.
- If Azure Document Intelligence is configured as the OCR strategy for PDFs (which the `KK20-192` "born-digital routing to skip Azure DI" work strongly suggests is the case here), Microsoft's documented input requirement is explicit and unconditional: *"If your PDFs are password-locked, you must remove the lock before submission"* ([Azure DI v4.0 GA layout model — Input requirements](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0#input-requirements)). Microsoft does **not** distinguish an owner/permissions-password-only PDF (case B) from an open-password PDF (case C) in that wording — both are "password-locked." Taken at face value, this means a case-B PDF passed through unchanged would still be rejected one layer down inside Azure DI, so the **Phase 2a strip-security step would be required even for the common case**, not merely a contingency.

**However** — the Azure DI doc wording only tells us the *primary* OCR call may reject a locked PDF. It does not settle the end-to-end outcome, because of the existing silent `resolveDocumentText` fallback (see "How PDFs actually flow" above): when Azure DI throws, the code already retries with `document_parser` (`pdfjs-dist`), which opens case B with an empty password. So the realistic outcomes are:
- Azure DI accepts case B → Phase 2a unnecessary.
- Azure DI rejects case B **but** the `document_parser` fallback extracts it successfully → case B *already works today* end-to-end; Phase 2a still unnecessary (the only cost is a logged Azure DI error + a fallback round-trip, which Phase 2a could optimise away but isn't required for correctness).
- Azure DI rejects case B **and** we want Azure DI's richer extraction (not the pdfjs fallback) for these files → Phase 2a (`qpdf` pre-strip so Azure DI accepts the file) is the only way to get case-B PDFs through the *preferred* extractor.

So Phase 2a is a **quality/consistency optimisation, not a correctness requirement** — a materially weaker claim than "required." **Phase 0** resolves which outcome holds by feeding the real KK20-232 PDF through the *actual configured chain including the fallback*, and recording both whether Azure DI rejects it and whether the fallback then succeeds. Phase 0's result decides 2a in or out; it has **no bearing on 2b** (case-C decrypt), which is unconditional regardless.

## Work packages

### Phase 0 — Verification spike
Bypass the Node encrypted-file gate in a scratch/dev environment and feed the real KK20-232 PDF through the **actual configured extraction chain, including the `resolveDocumentText` OCR→`document_parser` fallback**. Record two things, not one: (a) does the primary OCR strategy (Azure DI, if configured) reject the case-B file? and (b) if so, does the existing `document_parser` (`pdfjs-dist`) fallback then extract it successfully? Only if **both** the primary rejects *and* we deem the fallback's extraction quality inadequate for these files is **Phase 2a** (case-B strip-security via `qpdf`) justified — and even then as a quality optimisation to route case B back through the preferred extractor, not a correctness fix. Phase 0 does **not** gate Phase 2b (case-C decrypt), which is unconditional.

### Phase 1 — Fix the over-broad Node gate
Replace the byte-sniffed `/Encrypt`-trailer heuristic in `detectEncryptedFileAtPath` with a real classification: attempt to open the PDF with an empty password via `pdfjs-dist` (already a dependency) as a cheap upload-time probe.
- Empty-password success → case A/B → allow the upload through unchanged.
- `PasswordException` (`NeedPassword`/`IncorrectPassword`) → case C → do not reject; return a distinct "needs password" outcome (Phase 3).
- The OOXML CFBF-magic half of KK20-190 is unaffected — no password nuance there.
- This is a `[knauf]` change to an already-`[knauf]`-marked function. `SEAMS.md` is append-only per ticket: **add a new KK20-232 row** for the modified `detectEncryptedFileAtPath` behaviour (and its test attribution) and **leave the existing KK20-190 rows intact** — do not rewrite the KK20-190 history or reassign its test attribution. The two rows together document the seam's evolution.

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
- Add a `'needs_password'` state to the existing async-indexing state machine (`client/src/knauf/common/fileIndexing.ts`, `KnaufFileIndexingStatus`), alongside `uploading/queued/processing/ready/failed/...`. Unlike the other pending states, it does **not** resolve on its own by polling — it requires a user gesture.
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
  - **Storage & ownership:** the original encrypted bytes are moved out of the ephemeral upload temp dir into a durable store keyed by `(user, file_id)` before the `needs_password` response returns (so the `finally` unlink doesn't destroy them). Decide whether they are owned by `KnaufFileAsset` (new field) or a separate short-lived store.
  - **Authorization:** only the uploading user (matching `(user, file_id)`) may submit a password against them; these bytes are never returned to any client.
  - **Expiry / cancellation:** a bounded TTL — if no valid password arrives within the window (or the user cancels), purge the bytes and move the file to a terminal `failed`/cancelled state. Independent of the password-attempt rate-limit cooldown.
  - **Reconciliation on success:** on correct password, run extraction *once* with the password, persist the extracted **text** (the indexed artifact), then purge the retained ciphertext (unless it doubles as the download/citation original — below), and transition `needs_password` → `processing`.
  - **Download original:** if the product keeps a downloadable original, decide explicitly whether that role is served by these retained bytes (kept past extraction) or a separate copy — but never silently keep ciphertext forever under the guise of "the original."
  - **Deletion / cascade:** deleting the `File` purges the retained ciphertext (and cancels any TTL-scheduled purge) as well as the extracted-text artifact; nothing orphaned survives.
- Cases A and B never enter `needs_password`, so they need **no** retained ciphertext — they extract inline at upload and follow the existing single-artifact (extracted-text) path unchanged.

### Phase 5 — Permission-flag metadata capture (groundwork only, no enforcement)
While a PDF is open (Phase 1's probe, or Phase 3's password-verified open), also read its permission flags (print/copy/modify/annotate/form-fill/assemble/extract) and store them as metadata on the `File` document. Do not gate, block, or filter anything based on these flags in this plan — this is purely so that whenever KK20-253 lands a policy, it has data to act on retroactively instead of needing a second migration/backfill pass. Tie this back to KK20-253's three boundaries (agent creation / chat / asset list) with a short code comment pointing at the ticket.

### Phase 6 — Docs and seam bookkeeping
Update `knauf/docs/architecture/files/processing.md` and `SEAMS.md` to reflect the new classification and password flow once Phases 1–5 land.

## Compliance / GDPR non-negotiables

1. The password is never written to any log line, including error messages and stack traces — scrub it explicitly.
2. The password is never persisted to Mongo, Redis, a queue/job payload, or any file on disk.
3. The password never crosses into the async indexing worker's execution path — by Phase 4's design, it doesn't need to.
4. Rate-limit password attempts per `(user, file_id)` to bound the password-guessing surface.
5. Audit-log the *event* (attempted / succeeded / failed) without ever logging the *value* — ties into the existing `S4` audit-logging gap already tracked in `knauf/docs/future-work/file-management-roadmap.md`.

## Open risks / questions carried into implementation

- Phase 0's outcome is unknown until run — it decides only whether **Phase 2a** (case-B strip-security) is worth building as a *quality optimisation*. Because the existing `resolveDocumentText` OCR→`document_parser` fallback already extracts case-B PDFs via `pdfjs-dist`, case B is very likely already correct end-to-end today; 2a's only value is routing case B back through the preferred extractor (Azure DI) instead of the fallback. Phase 2b (case-C decrypt-at-extraction) ships regardless. The deferred native-multimodal follow-up commits to strip-security independently of this plan.
- Azure DI has **no native password/decrypt parameter** — confirmed against the v4.0 GA docs, which instead require the caller to *"remove the lock before submission."* This is why case **C** on the Azure-DI route needs a `qpdf --decrypt` pre-strip (Phase 2b) — the password can't be handed to Azure DI directly. For case **B**, the `pdfjs-dist` fallback already sidesteps this, so `qpdf` for case B (Phase 2a) is optional.
- Rate-limit thresholds/cooldown windows for password attempts aren't decided — proposal is to reuse whatever constants the existing auth login rate-limiter uses rather than invent new ones.
- Whether KK20-232 should be treated as a standalone bug fix (this plan) independent of KK20-253's refinement, or whether it should wait — raised in the investigation dossier, not resolved there; this plan proceeds on the basis that Phases 1–4 (encryption misclassification + password UX) are correct regardless of how KK20-253's policy question resolves, since they don't enforce any permission policy themselves.

## Still pending

- [ ] Review from `AlexZahar` and `jorgecostak` on this plan.
- [ ] Phase 0 verification spike.
- [ ] Phases 1–6 implementation, each as its own PR against its own `fix/KK20-232-...` branch once this plan is approved.

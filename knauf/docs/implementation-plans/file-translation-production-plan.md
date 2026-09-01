# Plan: Production file translation

**Generated:** 2026-08-26
**Tickets:** KK20-274, KK20-297
**Complexity:** High
**Provider:** Azure AI Translator 2026-03-01

## Objective

Provide durable, tenant-isolated translation for IDML and every supported non-source format. A chat request starts an idempotent job; the existing `agentic-karl-worker` claims and executes it. API pods never own long Azure operations. Source-code files remain Code Interpreter-only.

## Production invariants

- [x] A pod restart, deployment, browser disconnect, or model timeout cannot lose an accepted job.
- [x] One execution token owns a job. Stale workers cannot publish output or overwrite newer state.
- [x] Duplicate start requests return the same active/completed job; a failed or cancelled job permits one fresh, concurrently deduplicated attempt.
- [x] Per-user and global admission are enforced atomically across pods.
- [x] Input file ownership and tenant scope are revalidated both when queued and when claimed.
- [x] Provider `408`, `429`, and `5xx` failures retry with bounded full-jitter backoff and `Retry-After` as a floor.
- [x] Permanent input failures do not retry. Authentication/configuration failures retry only to a small cap.
- [x] Cancellation stops new work, cancels an accepted Azure batch where possible, and prevents output publication.
- [x] Scratch files and unpublished outputs have compensating cleanup and configured one-day lifecycle cleanup.
- [x] Temporary-chat retention is resolved when the job is accepted and carried to delayed worker outputs.
- [x] Job errors are stable codes with bounded sanitized detail; no contents, keys, glossary terms, or SAS URLs are logged.
- [x] IDML non-story entries remain byte-identical; story XML remains well formed.
- [x] Infrastructure, application image, and GitOps activation have an explicit order; live load, observability, and human InDesign evidence remain release acceptance gates.

## Architecture

```text
Chat translate_file
  -> validate locale + current attachments + ownership
  -> reserve user/global admission slots
  -> insert idempotent Mongo translation job
  -> bounded wait for quick completion
       | completed -> downloadable file artifacts
       ` queued    -> job id + translation_status tool

agentic-karl-worker
  -> atomically claim oldest due job with lease + execution token
  -> heartbeat while reading, translating, rebuilding, and persisting
  -> Azure synchronous or Blob batch translation
  -> token-fenced terminal update
       | success -> publish output file ids
       | retry   -> release admission only at terminal state
       ` cancel  -> cancel Azure batch + compensate unpublished output

translation_status
  -> user/tenant-scoped status, progress, stable errors, downloads
  -> explicit cancellation
```

The existing worker process, MongoDB, Blob Storage, Prometheus endpoint, Key Vault, ExternalSecret, Translator resource, and installed OpenTelemetry/Langfuse SDKs are reused. No new queue product, deployment, or database.

## Sprint 1: Durable job contract and admission

**Demo:** Concurrent duplicate submissions produce one job; a fourth active job for the same user is rejected; global slots cannot be overbooked.

- [x] Add the `knauf_translation_jobs` schema in Knauf-owned server code.
- [x] Store stable input file IDs, owner, tenant, conversation, locales, output IDs, attempts, lease/token, progress, timestamps, sanitized error, cancellation and TTL.
- [x] Create partial unique indexes for idempotency, per-user active slots, and global active slots.
- [x] Cap one job at 20 files and 250 MB aggregate input; retain existing per-format limits.
- [x] Default to three active jobs per user and 100 active/queued jobs globally; make both environment-configurable.
- [x] Derive idempotency from owner, tenant, conversation, ordered current-message file IDs, source mode, target locale, and glossary revision.
- [x] Unit-test concurrent reservation, deduplication, terminal slot release, stale lease reclaim, and tenant isolation.

## Sprint 2: Worker execution and retry

**Demo:** A queued job completes after the initiating request ends; killing one worker allows another to reclaim its expired lease.

- [x] Add a translation claim loop to the existing `agentic-karl-worker` process behind `KNAUF_FILE_TRANSLATION_WORKER_ENABLED`.
- [x] Use atomic oldest-due claim, execution-token fencing, leases and heartbeats.
- [x] Run at bounded process concurrency; stop claiming on SIGTERM and drain within the existing grace period.
- [x] Classify permanent, retryable and auth/config failures.
- [x] Honor `Retry-After`; use bounded full-jitter exponential backoff and attempt caps.
- [x] Revalidate source File ownership/tenant and storage availability after claim.
- [x] Persist each output privately; delete unpublished output when cancellation or lease loss wins the race.
- [x] Unit-test `429`, `503`, network reset, invalid input, missing source, cancellation, lease loss, retry exhaustion and orphan compensation.

## Sprint 3: Tool and user lifecycle

**Demo:** `translate_file` returns an immediate result for a quick job or a durable job ID; `translation_status` later returns downloadable files or cancels the job.

- [x] Change `translate_file` from direct execution to enqueue plus a bounded completion wait.
- [x] Add `translation_status` with `status` and `cancel` actions.
- [x] Scope every status/cancel read to authenticated user and tenant.
- [x] Return stable states: `queued`, `processing`, `retrying`, `completed`, `partial`, `failed`, `cancelled`.
- [x] Preserve streaming artifact projection. Do not expose artifact-returning file tools on unsupported non-streaming compatibility paths until downloads are implemented there.
- [x] Return locale-neutral stable codes and concise model-readable messages; no new direct UI message surface is introduced.

## Sprint 4: Format and quality hardening

**Demo:** Adversarial ZIP/XML fixtures fail closed; non-English input works without silently assuming English; a configured Knauf dictionary is verified before use.

- [x] Replace raw regex IDML `<Content>` discovery with XML-aware source offsets.
- [x] Detect duplicate raw ZIP central-directory paths before JSZip normalization.
- [x] Keep CRC, decompression, path, count, depth and character budgets.
- [x] Require explicit `source_locale` for every deterministic translation so glossary selection and provider behavior never depend on model-side guessing.
- [x] When configured, read the approved dictionary from a private `translation-glossary` Blob container, fail closed, cache by ETag, and include its SHA-256 revision in idempotency.
- [x] Fail closed when a configured glossary is missing or malformed; leave glossary variables unset until an immutable approved blob is deployed.
- [x] Add automated RTL/Unicode, non-English-source, comment/CDATA, and duplicate-path fixtures. Unsupported installed-font glyph coverage remains part of human InDesign acceptance.

## Sprint 5: Operability and release gates

**Demo:** Dev dashboards show queue pressure, latency, outcomes and provider errors; alerts fire in synthetic fault tests.

- [x] Export bounded Prometheus metrics for configuration readiness, admissions, queue depth/age, active jobs, cleanup debt, worker infrastructure errors, duration and terminal/retry/cancellation outcomes.
- [x] Add draft Datadog monitors for Translator `BlockedCalls`/`ServerErrors`, configuration/telemetry readiness, queue and cleanup age, worker errors, ambiguous publication, terminal failures and admission capacity, plus an environment-selectable rollout/production evidence dashboard.
- [x] Emit one redacted background translation observation to Datadog APM and Langfuse with job ID, locales, file count, attempt/generation, outcome and stable error code; never filename, content, user or tenant data.
- [x] Configure worker concurrency, whole-job age, attempt caps, lease/heartbeat, admission and kill switches in dev/stage/prod GitOps; activate only after the infrastructure and compatible image are deployed.
- [ ] Verify private endpoint/DNS, ExternalSecret readiness, storage lifecycle and glossary mount before enabling dev.
- [ ] Run a ramped multi-user load test without production traffic: 1, 5, 10, then 25 concurrent jobs; stop on elevated `429`, queue age, memory or error ratio.
- [ ] Complete signed human InDesign acceptance on at least three representative IDML files, including the longest fixture and one RTL target.

## Test matrix

Checkboxes below are release-evidence sign-offs, not unit-test TODOs. Repository coverage is recorded in the implementation evidence section; items requiring Azure, workload, or InDesign evidence stay open until that evidence is attached.

### Repository and authorization

- [ ] Foreign-user and foreign-tenant file IDs cannot be queued.
- [ ] Foreign-user job IDs cannot be inspected or cancelled.
- [ ] Duplicate attachment IDs do not duplicate work.
- [ ] Concurrent identical starts converge on one idempotent job.
- [ ] User/global active slots cannot exceed configured limits under concurrent inserts.
- [ ] Terminal jobs release slots; TTL removes history without deleting retained output files.

### Worker lifecycle

- [ ] Only one worker claims a job.
- [ ] Heartbeats extend a live lease.
- [ ] Expired leases are reclaimed with a new token.
- [ ] A stale token cannot complete, fail or publish outputs.
- [ ] SIGTERM stops claims and drains; hard termination is recovered by lease expiry.
- [ ] Explicit cancellation wins before persistence and compensates after persistence.

### Provider behavior

- [ ] `429` honors numeric and HTTP-date `Retry-After`.
- [ ] `408`, `500`, `502`, `503`, reset and timeout retry to the configured cap.
- [ ] `400` unsupported/corrupt input fails permanently.
- [ ] `401`/`403` use the smaller auth cap and produce an alert signal.
- [ ] Lost batch POST response leaves scratch for lifecycle cleanup.
- [ ] Accepted batch cancellation confirms terminal state before immediate deletion.

### Formats

- [x] IDML identity round trip preserves non-story hashes.
- [ ] IDML translation/edit output reopens in InDesign without repair warning.
- [ ] XML/JSON/Markdown/SVG structure remains valid and protected content remains unchanged.
- [ ] DOCX/PPTX/XLSX/CSV/TXT/PDF/PNG/JPEG/WebP preserve their provider-supported output type.
- [ ] Source-code extensions remain excluded from deterministic translation and RAG.
- [ ] Unsupported, encrypted, empty, oversized and malformed files fail with stable codes.

### Operations

- [ ] Metrics contain no user ID, filename, locale text, glossary term, content, key or SAS URL labels.
- [ ] Queue-age and Translator `429`/`5xx` alerts fire in fault injection.
- [ ] Scratch lifecycle deletes abandoned source/target/glossary blobs.
- [ ] Kill switch removes start/status tools and workers stop accepting new jobs.

## Implementation evidence — 2026-08-26

- [x] Translation parser/provider/tool/repository/worker suites: 7 suites, 90 tests passed.
- [x] Request-scoped tools, metrics and shipped-skill suites: 5 suites, 187 tests passed.
- [x] Native ToolService registration regression passed.
- [x] `@librechat/api` production build passed.
- [x] Terraform `fmt -check` and `validate` passed for nonprod and prod roots.
- [x] All six dev/stage/prod API/worker values files parsed as YAML; image lockstep passed.
- [x] Seam manifest whole-repository check and diff check passed.
- [x] Full `@librechat/api` regression reached 6,710 passing tests. Two unrelated local-only LibreOffice failures remain because `sample.pptx` is absent while LibreOffice is installed; no translation, attachment, skill, metric, or initialization suite failed.
- [x] Local production acceptance used all eight supplied Knauf IDML fixtures: every file passed parse, identity rebuild and reparse with identical segment counts; the largest contained 41 stories and 183 segments.
- [x] A real upload-to-edit round trip inspected 61 segments, persisted an edited IDML, reparsed it with 61 segments and preserved all 12 non-story package hashes.
- [x] The durable worker completed a real Azure Translator English-to-German IDML job on its first attempt. The translated output reparsed with 61 segments and preserved all 12 non-story package hashes.
- [x] Local durable-job acceptance verified immediate cancellation releases the active slot without output and duplicate starts converge on one job.
- [x] Prompt-driven local browser acceptance passed for first-turn inspection and same-chat follow-up inspection, segment edit/export, and Azure English-to-German translation/export. Follow-up initialization now restores owner-authorized attachments from the active message branch before request-scoped tools load; its server regression suite passes 19 tests.
- [ ] Repeat live Azure provider smoke, multi-user load, fault injection and InDesign acceptance against each deployed environment; repository checks do not substitute for this evidence.

## Production hardening re-review — 2026-08-26

- [x] Expired cancelled claims are finalized by the worker reaper and release admission slots.
- [x] Expired leases enter configured backoff and stop at the general attempt cap.
- [x] Every job reserves deterministic output IDs; retries and ambiguous Mongo acknowledgements reconcile before any blob deletion.
- [x] First-turn outputs are rebound to the actual conversation/message and response `attachments[]` participate in cascade cleanup.
- [x] Transient Mongo recovery/claim errors no longer terminate the combined indexing and translation worker.
- [x] Terminal TTL starts on completion/failure/cancellation instead of while work is queued or processing.
- [x] Failed and cancelled idempotency records no longer block a user retry for the seven-day history window.
- [x] A transient failure in any multi-file member rolls back unpublished sibling outputs and retries instead of completing as `partial`.
- [x] Required glossary bytes are SHA-256 verified against the configured and job-pinned revision.
- [x] Native documents and images receive the complete language-pair glossary instead of relying on optional RAG text extraction. Files route to batch translation when the glossary exceeds the synchronous limit; oversize applicable glossaries fail closed instead of truncating.
- [x] Required glossaries fail closed when the target locale column is absent.
- [x] Compatibility API paths remain unable to expose artifact-returning file tools after server-side attachment resolution.
- [x] Translation can run independently when indexing is disabled; disabling both roles exits cleanly.
- [x] Immediate queued-job cancellation records a bounded cancellation metric.
- [x] Dev/stage/prod explicitly configure lease, heartbeat, polling, retry caps/backoff, history, shutdown grace, and one-job/one-file concurrency. The Node heap ceiling is 768 MiB under the 1 GiB pod limit.
- [x] The Knauf-only SAX parser dependency is owned and exported by `@knauf/knauf`, not the upstream API package.
- [x] Whole-job age is bounded at 60 minutes; dev/stage/prod use a three-minute lease, 30-second heartbeat, and one-job/one-file worker concurrency.
- [x] Expired-lease recovery rechecks the lease/deadline in its final compare-and-set, so a concurrent heartbeat cannot be overwritten.
- [x] Failed cleanup attempts receive a durable future retry time; terminal expiry cannot bypass pending cleanup, and one poison job cannot starve the bounded scan.
- [x] Azure Blob output uploads receive the worker cancellation signal, while late completion remains covered by deterministic locators and the cleanup ledger.
- [x] API and worker share the same persisted output-retention decision and whole-job age in every environment.
- [x] Inline IDML ACE segment IDs (`sN-cN-pN`) are accepted by the model-facing edit schema.
- [ ] Do not deploy the enabling GitOps revision until infrastructure, secrets, containers, private DNS, and a compatible worker image are present.

## Local browser and provider evidence — 2026-08-27

- [x] Historical owner-authorized attachments remain available to IDML/XML/translation tools without being persisted again on each follow-up message.
- [x] Multi-file translation requires exact `filenames` or explicit `all_files: true`; ambiguous scope fails closed.
- [x] Azure file-mode batch targets use a unique target filename with a container-scoped create/write/list SAS, matching the provider contract.
- [x] Optional unfiltered native-document glossary rejection falls back once without the glossary and records `reason: provider_rejected`; a required glossary still fails closed.
- [x] Azure batch `ValidationFailed` is classified as a permanent rejection instead of consuming the transient retry budget.
- [x] Local browser acceptance completed for exact IDML selection, a 7-slide PPTX, and a 3-page PDF. All produced downloadable file cards.
- [x] PPTX QA: valid OOXML ZIP, 7/7 slides and 122/122 text runs retained; all slides rendered without visible clipping or structural damage.
- [x] PDF QA: valid unencrypted PDF, 3/3 A4 pages retained; German text remained extractable and all pages rendered without visible clipping or structural damage.
- [ ] Linguistic acceptance remains human-owned. Current Azure output showed terminology/tone defects (`Agentic Karl` changed to `Agent Karl`; mixed German `du`/`Sie`; awkward literal wording). The supplied GPDM glossary contains no `Agentic Karl`/`Karl` entry, so production terminology governance needs approved dictionary entries or a later custom translation category.

### Live rollout audit — 2026-08-26

- [x] Read-only Azure inventory completed without reading secret values.
- [ ] Nonprod Translator public access is still enabled; disable it only through the reviewed Terraform apply after private DNS/connectivity verification.
- [ ] Nonprod private endpoint `pe-agentic-karl-translator-nonprod` is not deployed.
- [ ] Nonprod Key Vault does not yet contain `agentic-karl-AZURE-TRANSLATOR-ENDPOINT`.
- [x] Stage Langfuse project secret exists and is enabled; API/worker mappings can now be validated without reading its value.
- [ ] Nonprod Blob Storage does not yet contain the `translation-glossary` container.
- [ ] Production Translator and private endpoint are not deployed.
- [ ] After infrastructure apply, repeat these checks before deploying the enabling GitOps revision. Glossary deployment is a separate optional quality rollout.

## Rollout and rollback

1. Merge and apply infrastructure; verify private DNS, Key Vault key names, containers, storage policy, and monitors.
2. Merge the application and promote its compatible image through dev, stage, and prod.
3. Merge GitOps last; its Translator/Langfuse secret mappings and API/worker flags require the preceding resources/image. Never merge it before the Terraform apply because the chart's ExternalSecret mappings are non-optional.
4. Verify each ExternalSecret, roll both Deployments, and run controlled translation plus metric checks in dev, then stage, then prod.
5. Complete load, fault, linguistic, and human InDesign acceptance; deploy an immutable glossary separately when approved.
6. Roll back API acceptance first, allowing accepted jobs to drain. Disable the worker only after queue depth reaches zero or jobs are explicitly cancelled.

## Explicit non-goals

- Automatic InDesign frame resizing, rendering, overset repair or visual approval.
- Deterministic translation of executable source code.
- A second translation provider.
- Translation-memory campaign management or one-click multi-locale publishing.

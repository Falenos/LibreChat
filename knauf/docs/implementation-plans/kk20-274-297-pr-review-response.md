# KK20-274 / KK20-297 file handling — PR review response

**Date:** 2026-08-26

**Audience:** Agentic Karl maintainers, infrastructure reviewers, Marketing localisation testers

**Application PR:** [Knauf-Group/agentic-karl#327](https://github.com/Knauf-Group/agentic-karl/pull/327)

**Infrastructure PR:** [Knauf-Group/agk-infrastructure#114](https://github.com/Knauf-Group/agk-infrastructure/pull/114)

**GitOps PR:** [Knauf-Group/agk-deployment-configs#488](https://github.com/Knauf-Group/agk-deployment-configs/pull/488)

## Outcome

The review was directionally correct. We applied the correctness, security, cleanup, rollout, and fork-maintenance findings. We did not adopt the proposed full translation-platform redesign for this functional spike.

The resulting boundary is:

- IDML: upload, parse, inspect, exact text replacement, deterministic translation, rebuild, and download.
- XML: upload, inspect structure/text, exact text replacement, deterministic text translation, and download.
- Supported native documents, structured text, PDF, and images: deterministic Azure translation and download.
- Source code such as HTML, CSS, JS/JSX, TS/TSX, Python, Vue, Svelte, and Astro: upload to Code Interpreter for prompt-driven inspection/modification. No raw whole-file deterministic translation.
- Layout acceptance: human review in the native application. No automated InDesign rendering or layout validation.

## Ticket scope correction

Two related Jira stories are involved:

- **KK20-274** is the Marketing IDML story: parse, translate, manipulate, and export IDML.
- **KK20-297** expands upload/analysis support for requested file types.

The implementation branch covers both concerns because the product request was explicitly broadened from IDML translation to reusable file translation. PR and release notes should name both tickets so reviewers do not interpret the general translation routes as accidental KK20-297 scope growth.

## Review findings applied

| Finding | Adaptation |
| --- | --- |
| IDML limits were enforced after retaining all stories/segments | Added cumulative story-XML, `Content`-node, segment, and source-character budgets. Oversized documents fail during the scan, before more story objects are retained. |
| Azure `translateTextWithinImage` contract was wrong/incomplete | Synchronous requests send the query parameter. Batch requests send top-level `options.translateTextWithinImage`. DOCX/PPTX use the option on either path. |
| Batch SAS permissions covered whole containers | Replaced container SAS with per-blob SAS: source/glossary read-only; target create/write only. Signed URLs remain short-lived and are never logged. |
| Timed-out/aborted Azure jobs could continue after scratch deletion | Added batch cancellation and bounded terminal-state confirmation. Immediate deletion happens only after success or confirmed cancellation. Uncertain jobs are left for storage lifecycle cleanup. |
| Scratch blobs had no infrastructure fallback | Added one-day lifecycle rules for `translation-source/` and `translation-target/` in dev, stage, and prod storage accounts. |
| Saved output could become an orphan if Mongo metadata creation failed | Added compensating storage deletion after a successful blob write followed by retention/metadata failure. Public error remains `storage_write_failed`. |
| One stale attachment aborted every file | Translation now resolves each requested attachment independently and returns `completed`, `partial`, or `failed` with stable per-file results. Other valid files still complete. |
| IDML could enter Agent/Project Knowledge RAG | Added a server-side rejection for IDML with `tool_resource=file_search`, plus an EN/DE user message. Chat attachment handling remains available for IDML tools. |
| Per-file upload routing appended a second `tool_resource` | Changed the FormData operation to replace the original knowledge-routing value. A test verifies source files submit only `execute_code`. |
| Translation had no deployment kill switch | Added `KNAUF_FILE_TRANSLATION_ENABLED`. Tool injection requires the flag plus Translator endpoint/key. GitOps defaults the flag to `false` in every environment. |
| Upstream schema seams exceeded the fork protocol's inline threshold | Moved the large IDML/XML edit schemas into `packages/api/src/knauf/tools/fileEditSchemas.ts`; the upstream registry now contains only a small import/registration seam. |
| Weak seam reason and missing `handleTools` behavior anchor | Expanded the runtime-injection reason and added a direct constructor/context test. |
| JSON, Markdown, SVG, and XML parser complexity was not bounded consistently | Added 10,000-segment/500,000-character retention limits, strict streaming XML-family preflight limits, maximum XML depth, and linear-time structured-text/XML path rebuilding. |
| Source files could fall back to TXT translation | Reused the extension-aware source classifier in both request-time tool exposure and authoritative backend format resolution. Source files cannot enter Azure file translation. |
| Source-file RAG exclusion was client-only | Added an authoritative `file_search` rejection for source code and forwarded the existing Code Interpreter-required user message. |
| Project Knowledge could associate a Code Interpreter-only upload forever | `addProjectFile` now requires an embedded file or File Asset pointer before creating a project source. |
| Ambiguous Azure batch acceptance could delete live inputs | Scratch becomes unsafe before dispatch. Only a definite non-202 rejection restores immediate deletion; lost responses use lifecycle cleanup. |
| Request abort did not stop local work | Abort now stops storage reads and scheduling, propagates through translation, and is checked again before output persistence. |
| XML/Markdown round trips could corrupt structure | XML is strict UTF-8 only, rejects malformed markup and forbidden XML 1.0 characters; Markdown preserves destinations, reference identifiers/definitions, indented code, and correctly matched fences. |
| Storage lifecycle policy was owned by the application child state | Moved the account-wide singleton rules into the parent tenant storage modules that create each storage account. |

## Findings accepted in principle but intentionally deferred

### Move generic translation out of the `idml` namespace

The naming criticism is valid: the translation engine now serves more than IDML. A directory move was not mixed into this hardening pass because it would enlarge the current upstream/review diff without changing runtime behavior. Do this as a mechanical follow-up when the generic translation capability gets its own story. Preserve public tool names and tests during the move.

### One generated capability registry for every UI/backend/config surface

Format knowledge is still repeated across upload configuration, request-time tool injection, and translation adapters. Centralising executable TypeScript constants is reasonable. Generating YAML and every UI surface from a new registry is not required for the spike and would introduce build/config machinery. Follow up only if another format change demonstrates real drift.

### Durable background worker and queue

The current implementation has bounded per-file bytes, retained segments/characters, XML complexity, polling time, and concurrency of three per tool call. That is enough for a controlled spike, not a guarantee for dozens of large simultaneous uploads. Before broad production enablement, load-test representative batches. Add a durable worker only if observed latency, pod cancellation, or concurrency exceeds the bounded chat lifecycle.

### Automatic IDML layout repair/validation

Not required. Translation changes text length; overset text, frame sizing, fonts, glyphs, RTL, and page flow require InDesign review. The ticket discussion explicitly scopes the first version to text translation/manipulation with human acceptance.

## Changes not made

- No second translation provider. Azure remains the deterministic bulk path; the model only decides when to call it.
- One runtime dependency declaration: `saxes@^6.0.0`, already present transitively, is now direct because strict streaming XML validation depends on it.
- No raw Azure translation for executable source files. Translating identifiers and syntax as natural language can corrupt code.
- No automatic frame resizing, image/style changes, InDesign preview, or InDesign Server integration.
- No Terraform plan/apply from a developer workstation. Existing CI/CD state ownership remains authoritative.
- No parallel authorization system. The new flag is an operational readiness/kill switch layered on existing attachment, user, tenant, tool, and capability checks.

## Rollout order

1. Merge/apply infrastructure PR #114: Translator/private endpoint, Key Vault values, private containers, lifecycle rules. The imported nonprod spike stays publicly reachable during adoption; verify private endpoint/DNS, then disable public access in a follow-up apply before enabling translation.
2. Merge GitOps PR #488 with `KNAUF_FILE_TRANSLATION_ENABLED: "false"`.
3. Merge/deploy application PR #327. Translation stays absent while disabled; IDML/XML inspection and manipulation remain independent.
4. Verify private DNS, ExternalSecret sync, endpoint/key presence, storage access, and a cancelled-job cleanup in dev.
5. Set the dev flag to `"true"`, deploy, and run representative translation tests.
6. Complete human InDesign acceptance on at least three supplied fixtures before stage/prod enablement.
7. Enable stage, then prod, with the same one-line flag change. Roll back by setting the flag to `"false"`.

## Human acceptance checklist

For each selected IDML output, record target locale, reviewer, InDesign version, page count, repair warning, missing/untranslated text, overset/clipping, font/glyph/RTL issues, terminology/fluency score, and manual repair minutes. Acceptance requires clean reopen, intact source assets/styles, and documented layout corrections.

## Verification completed

- Application API focused suites: 8 suites, 215 tests passed.
- Package API focused suites: 4 suites, 179 tests passed.
- Client upload-routing suite: 57 tests passed.
- Terraform validation: nonprod and prod application roots passed; changed parent storage files passed `terraform fmt -check` and were checked against the pinned `storage14.2.0` module contract. No local remote-state plan/apply was run.
- GitOps dev/stage/prod values: YAML parsed successfully.
- Seam manifest checks, package build, lint, and diff checks: see the latest PR #327 checks.

## Remaining release risks

- Azure document/image translation fidelity varies by format and locale.
- IDML page layout can change even when package structure is preserved.
- Durable Mongo-backed jobs now run in the existing worker with admission limits, leases, retries, cancellation, and status lookup; the remaining gate is ramped load validation.
- Generic translation code still lives under the historical `idml` directory until the mechanical namespace follow-up.
- The rollout flag is intentionally disabled in Git; translation will not appear after deployment until an environment is explicitly enabled.
- Production metrics/monitors, raw ZIP duplicate inspection, regex-free IDML extraction, durable jobs, private glossary delivery, and output compensation are now implemented. Artifact-returning file tools are deliberately absent from compatibility APIs until those APIs support file downloads.
- Remaining release gates: upload the pinned glossary Blob, verify private DNS/secrets, run fault/load tests, and complete signed human InDesign acceptance. See `file-translation-production-plan.md`.
- The pre-existing Terraform workflow plan-comment defect and unrelated Datadog plan drift require separate infrastructure-owner review; this feature pass does not rewrite shared CI workflows or dashboard state.

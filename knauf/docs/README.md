# KARL fork docs

Documentation for the Knauf "Agentic Karl" fork of LibreChat. Docs are organized **by purpose** — start in the folder that matches your question.

| Folder | Purpose |
|---|---|
| [architecture/](architecture/) | **How the product works** — feature & subsystem reference (the running system, not the rollout) |
| [contributing/](contributing/) | **How we work on this fork** — change protocol, git/merge workflow, seam testing, upstream sync, fork history |
| [implementation-plans/](implementation-plans/) | **Work in flight** — time-bound, multi-PR workstreams (see the folder's own [README](implementation-plans/README.md) for the lifecycle) |
| [upstream-releases/](upstream-releases/) | **Per-version upstream sync notes** — what each merged LibreChat release means for the fork (features, security, seam interactions) |
| [proposals/](proposals/) | **Designs being decided** — not yet approved or implemented |
| [future-work/](future-work/) | **Backlog & roadmaps** — work we've decided we want but haven't scheduled (ready-to-file ticket drafts) |

When a doc graduates: an implementation plan that finishes is deleted, archived, or **promoted to `architecture/`** (keep the architecture model, drop the rollout steps). A proposal that's accepted becomes a plan, then graduates the same way.

---

## Architecture — how the product works

| Doc | When to read it |
|---|---|
| [architecture/files/overview.md](architecture/files/overview.md) | **Start here for files** — the six upload paths, what the model receives, message-vs-agent binding, visibility matrix, lifecycle, delete behaviour, config knobs |
| [architecture/files/storage.md](architecture/files/storage.md) | Where the bytes live — `fileStrategy` adapters + the Azure Blob / SAS-signed-URL machinery (anatomy, refresh chain, TTL math, signing modes, before/after diagrams) |
| [architecture/files/rag-search.md](architecture/files/rag-search.md) | How file search works — `rag_api` + pgvector, embed/query/delete contract, `entity_id` scoping, the `file_search` tool, citations |
| [architecture/files/processing.md](architecture/files/processing.md) | Which formats each upload mode accepts (MIME allow-lists) and how each is processed — image transforms, document parser, OCR, speech-to-text, RAG embedding; plus what's active vs dormant today |
| [architecture/image-gen-toggle.md](architecture/image-gen-toggle.md) | How the image-generation toggle works on agent chats and the default Knauf model spec (admin opt-in + per-chat chip + visibility hook + backend gate) — sequence + flowchart + component map |

> The `files/` docs are a set: **overview** is the map; **storage**, **rag-search**, and **processing** are the domain deep-dives it links into.

## Contributing — how we work on this fork

| Doc | When to read it |
|---|---|
| [contributing/code-change-protocol.md](contributing/code-change-protocol.md) | Tier ladder, `[knauf]` marker / SEAMS.md format, anti-patterns, refusals — **read before any non-trivial change** |
| [contributing/git-workflow.md](contributing/git-workflow.md) | Merge protocol, CI automation |
| [contributing/testing-and-rollback.md](contributing/testing-and-rollback.md) | Seam tests, emergency rollback |
| [contributing/upstream-sync.md](contributing/upstream-sync.md) | Step-by-step ritual for picking up an upstream-sync issue |
| [contributing/migration.md](contributing/migration.md) | Historical record — how this repo was created and why we re-forked (the one-time event behind today's native shared ancestry) |

## Implementation plans

Time-bound, multi-PR workstreams being executed. See [implementation-plans/README.md](implementation-plans/README.md) for the delete / promote / archive lifecycle.

| Doc | What it covers |
|---|---|
| [implementation-plans/azure-blob-and-private-files.md](implementation-plans/azure-blob-and-private-files.md) | Azure Blob private-container rollout — upstream PR status, deployment-configs changes, prod hardening checklist, end-to-end verification recipes |
| [implementation-plans/langfuse-rollout.md](implementation-plans/langfuse-rollout.md) | Deploying Langfuse (LLM observability) on AGK via the agk-deployment-configs ApplicationSet, bundled in-cluster stores, Traefik + Okta |
| [implementation-plans/agent-publishing-governance.md](implementation-plans/agent-publishing-governance.md) | AI Champions controlled agent-publishing pilot |
| [implementation-plans/admin-panel-dev-deployment-plan.md](implementation-plans/admin-panel-dev-deployment-plan.md) | Deploy the LibreChat Admin Panel as a pinned AGK dev service |
| [implementation-plans/adobe-analytics-onetrust.md](implementation-plans/adobe-analytics-onetrust.md) | Adobe Analytics + OneTrust consent integration |

## Upstream releases

Per-version notes on each upstream LibreChat release merged into the fork — features, security hardening, `[knauf]` seam interactions, and the config/env actions each release requires. See [upstream-releases/README.md](upstream-releases/README.md) for the index; the [upstream-sync ritual](contributing/upstream-sync.md) is how these merges are performed.

| Doc | What it covers |
|---|---|
| [upstream-releases/v0.8.6.md](upstream-releases/v0.8.6.md) | Observability + hardening release — Prometheus `/metrics`, OpenTelemetry, readiness endpoints, MCP SSRF hardening, unauth `/api/config` field stripping (the config.js payload split) |
| [upstream-releases/v0.8.7.md](upstream-releases/v0.8.7.md) | Agent-capability + usage-visibility release — Skills/Subagents, keyboard shortcuts, token/context tracking, pinned & archived chats; admin-session-secret + shared-file authz hardening; three operator config actions |

## Proposals

Designs under discussion — not approved, not implemented.

| Doc | What it proposes |
|---|---|
| [proposals/seams-yaml-source-of-truth.md](proposals/seams-yaml-source-of-truth.md) | Making a structured `seams.yaml` the authoritative source for `[knauf]` markers (today SEAMS.md is hand-authored) |
| [proposals/pii-masking-and-anonymization.md](proposals/pii-masking-and-anonymization.md) | PII masking & data anonymization strategy (KK20-207) — data-classification, per-category handling matrix, LibreChat-OOTB verdict, engine options (Presidio / Azure AI Language), phased roadmap + follow-up tickets; includes an [interactive demo](proposals/assets/pii-masking-demo.html) |

## Future work

Backlog and roadmaps — decided we want it, not yet scheduled. Ready-to-file ticket drafts.

| Doc | What it covers |
|---|---|
| [future-work/file-management-roadmap.md](future-work/file-management-roadmap.md) | File lifecycle & governance follow-ups to KK20-190 — dedup, cascade cleanup on chat delete, 90-day retention sweep, and the security gap matrix (malware scan, MIME-spoof, quota, audit, encryption-at-rest, DLP) |

# Implementation plans

Time-bound, multi-PR workstreams currently being executed. Each plan in this folder represents a piece of work that:

- Spans more than one PR (often more than one repo).
- Has a clear start and a clear end — it's not authoritative reference material, it's the *record of what we're doing right now*.
- Tracks the architecture context needed to understand the rollout alongside the rollout itself.

This folder is **not** for:

- How a product feature or system works (stable architecture reference) → use [`../architecture/`](../architecture/).
- Engineering-process docs and step-by-step rituals (tier ladder, git workflow, seam testing, upstream sync) → use [`../contributing/`](../contributing/).
- Designs we're still deciding on → use [`../proposals/`](../proposals/).

---

## Lifecycle

Every plan in this folder ends in one of three ways. **Don't let them accumulate.**

| Outcome | When | Action |
|---|---|---|
| **Delete** | Plan was purely operational; no enduring value once the work shipped. | `git rm` the file in the same PR that completes the last rollout step. |
| **Promote to `../architecture/`** | The architecture context is worth keeping but the rollout steps are stale. | Move + trim aggressively. Drop the "Still pending" section, the rollout sequence, the dated verifications. Keep the architecture model, the env-var spec, and any post-mortem-worthy decisions. |
| **Archive to `archive/`** | The history of the rollout is worth keeping for postmortem / institutional memory, but the doc shouldn't sit in the active list. | Move to `knauf/docs/implementation-plans/archive/`. Date-prefix the filename (`2026-05-azure-blob-…md`) so it's clear it's frozen. |

If you can't decide between promote and archive: archive.

---

## Currently in flight

| Plan | Owner(s) | Started | Target completion |
|---|---|---|---|
| [`azure-blob-and-private-files.md`](./azure-blob-and-private-files.md) | jorgecostak | 2026-05-22 | KK20-167 — KARL prod rollout of private Azure Blob with SAS signing |
| [`agent-publishing-governance.md`](./agent-publishing-governance.md) | Zahar / KARL admins | 2026-06-02 | Working direction for AI Champions controlled agent publishing pilot |
| [`admin-panel-dev-deployment-plan.md`](./admin-panel-dev-deployment-plan.md) | Zahar / KARL admins | 2026-06-05 | Deploy LibreChat Admin Panel as a pinned AGK dev service |
| [`file-lifecycle-dedup-cleanup.md`](./file-lifecycle-dedup-cleanup.md) | jorgecostak | 2026-06-26 | KK20-203 cascade cleanup on chat delete, then KK20-204 per-user content-hash dedup |
| [`agent-retrieval-and-langgraph-reliability-plan.md`](./agent-retrieval-and-langgraph-reliability-plan.md) | Agentic Karl / RAG / agents SDK maintainers | 2026-07-16 | Correct dual-backend retrieval, compaction, termination, and tracing |
| [`file-upload-model-router-remediation.md`](./file-upload-model-router-remediation.md) | Agentic Karl maintainers | 2026-07-17 | Bound router failures, correct document routing/dedup, repair cost attribution, and validate dev retrieval paths |
| [`pdf-password-permission-handling.md`](./pdf-password-permission-handling.md) | Agentic Karl maintainers | 2026-07-20 | KK20-232 — admit all PDFs readable without credentials and distinguish invalid files from open-password files; keep password submission as an optional follow-up |
| [`pii-privacy-workstream.md`](./pii-privacy-workstream.md) | jorgecostak / DPO / Security | 2026-08-28 | KK20-207 follow-through — Langfuse PII gate, config baseline, log hygiene, retention & DSAR, engine PoC; carries the GDPR / EU AI Act mapping |

When that table empties, this folder can be reconsidered — maybe it stays as a known home for the next workstream, maybe it gets dropped. For now it has a clear purpose.

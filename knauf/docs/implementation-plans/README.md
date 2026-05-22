# Implementation plans

Time-bound, multi-PR workstreams currently being executed. Each plan in this folder represents a piece of work that:

- Spans more than one PR (often more than one repo).
- Has a clear start and a clear end — it's not authoritative reference material, it's the *record of what we're doing right now*.
- Tracks the architecture context needed to understand the rollout alongside the rollout itself.

This folder is **not** for:

- Stable how-tos or process docs → use [`../reference/`](../reference/).
- Step-by-step rituals reviewers walk through repeatedly → use [`../guides/`](../guides/).
- Designs we're still deciding on → use [`../proposals/`](../proposals/).

---

## Lifecycle

Every plan in this folder ends in one of three ways. **Don't let them accumulate.**

| Outcome | When | Action |
|---|---|---|
| **Delete** | Plan was purely operational; no enduring value once the work shipped. | `git rm` the file in the same PR that completes the last rollout step. |
| **Promote to `../reference/`** | The architecture context is worth keeping but the rollout steps are stale. | Move + trim aggressively. Drop the "Still pending" section, the rollout sequence, the dated verifications. Keep the architecture model, the env-var spec, and any post-mortem-worthy decisions. |
| **Archive to `archive/`** | The history of the rollout is worth keeping for postmortem / institutional memory, but the doc shouldn't sit in the active list. | Move to `knauf/docs/implementation-plans/archive/`. Date-prefix the filename (`2026-05-azure-blob-…md`) so it's clear it's frozen. |

If you can't decide between promote and archive: archive.

---

## Currently in flight

| Plan | Owner(s) | Started | Target completion |
|---|---|---|---|
| [`azure-blob-and-private-files.md`](./azure-blob-and-private-files.md) | jorgecostak | 2026-05-22 | KK20-167 — KARL prod rollout of private Azure Blob with SAS signing |

When that table empties, this folder can be reconsidered — maybe it stays as a known home for the next workstream, maybe it gets dropped. For now it has a clear purpose.

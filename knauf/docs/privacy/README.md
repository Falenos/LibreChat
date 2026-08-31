# Privacy, PII & data protection

Everything about how Agentic Karl handles personal data: what it collects, where that data lives,
how long it stays, and what we are doing about it. This folder is the single home for the topic —
strategy, executable plan, and the compliance mapping that connects them.

It follows the same pattern as [`../code-execution/`](../code-execution/): once a topic grows past
a single proposal, its docs graduate out of `proposals/` into a dedicated folder.

## Read in this order

| Doc | What it is | Status |
|---|---|---|
| [`workstream.md`](./workstream.md) | **Start here.** The executable plan — verified delta against current `main`, phase-by-phase impact and priority, the GDPR / EU AI Act / BetrVG mapping, a paste-ready ticket set, and the bundling recommendation | ✅ current (2026-08-28) |
| [`pii-masking-and-anonymization.md`](./pii-masking-and-anonymization.md) | The KK20-207 discovery assessment — data classification, per-category handling matrix, engine options, the original phased roadmap | ⚠️ **v1.0, stale** — carries a banner explaining what changed; superseded in part by `workstream.md` |

## The one-paragraph version

Agentic Karl handles personal data everywhere a chat assistant does: prompts and responses,
uploaded files and their extracted text, long-lived memories about users, a full-text search
replica, observability traces, logs, and identity records. **LibreChat ships no PII masking,
anonymization, or redaction out of the box**, so whatever protection Knauf wants, Knauf builds or
buys. The load-bearing decision is to **protect the durable copies and the logs first, and not to
mask prompts before the model** — the model call runs inside Knauf's own Azure tenancy under the EU
Data Boundary, while the real exposure is data that persists without a purpose. Masking
`Frau Müller` before the model would wreck the product and push people to public ChatGPT, which is
a strictly worse privacy outcome.

## What is NOT here

Docs that are privacy-relevant but belong to their own workstream. `workstream.md` links to each
where it matters:

| Doc | Why it stays put |
|---|---|
| [`../implementation-plans/langfuse-rollout.md`](../implementation-plans/langfuse-rollout.md) | Langfuse deployment plan. It is a *PII surface* the workstream governs, but the doc itself is an observability rollout |
| [`../implementation-plans/adobe-analytics-onetrust.md`](../implementation-plans/adobe-analytics-onetrust.md) | The analytics consent stack — the fork's one already-shipped privacy control, used as the model pattern for new data-emitting features |
| [`../architecture/files/`](../architecture/files/) | File lifecycle and the delete cascade that erasure depends on |
| [`../future-work/file-management-roadmap.md`](../future-work/file-management-roadmap.md) | Its S6 (DLP) and T3 (retention sweep) rows are refined into `workstream.md`'s phases |

## Removed

- `assets/pii-masking-demo.html` — a v1.0 interactive companion (data-flow map, handling matrix,
  options comparison, masking playground). Deleted 2026-08-31: its map and matrix showed none of
  the sinks added since it was built (Langfuse, `auditLog`, Azure AI Search), so it actively
  misrepresented the system on the tabs it existed for. Recoverable from git history if a refreshed
  version is ever wanted.

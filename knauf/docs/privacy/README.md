# Privacy, PII & data protection

Everything about how Agentic Karl handles personal data: what it collects, where that data lives,
how long it stays, and what we are doing about it. This folder is the single home for the topic —
strategy, executable plan, and the compliance mapping that connects them.

It follows the same pattern as [`../code-execution/`](../code-execution/): once a topic grows past
a single proposal, its docs graduate out of `proposals/` into a dedicated folder.

## Read in this order

| Doc | What it is | Status |
|---|---|---|
| [`workstream.md`](./workstream.md) | **Start here.** The executable plan — verified delta against current `main`, phase-by-phase impact and priority, the GDPR / EU AI Act / BetrVG mapping, the **audit-log retention analysis (§3.4 — 12 months, with the legal basis)**, the **mandatory-vs-convention necessity map (§4.4)**, a paste-ready ticket set, and the **five-wave execution plan (§6)** | ✅ current (2026-09-03 — implementation started; KK20-327 and KK20-328 in open PRs) |
| [`runbooks/dsar-access.md`](./runbooks/dsar-access.md) | **Art. 15 access-request runbook** (KK20-331 / P2-6a) — the nine sinks with per-sink lookup, the Art. 15(4) admin-redaction rule, the Art. 12(3) clock, and the read-only collector `knauf/scripts/dsar-collect.js` | ✅ written 2026-09-03 — **rehearsal pending** |
| [`runbooks/erasure-verify.md`](./runbooks/erasure-verify.md) | **Art. 17 erasure-verification runbook** (P2-5, KK20-TBD) — deletion through the real product paths, the Langfuse public-API leg, the per-environment sink manifests (`erasure-sinks/<env>.json`) in which every store must resolve, and the verifier `knauf/scripts/erasure-verify.js` | ✅ written 2026-09-04, reworked 2026-09-24 after review. **No evidence run is possible until the RAG adapter ships and the manifests' open facts are recorded** (runbook §5); in PR |
| [`anonymization-design.md`](./anonymization-design.md) | The design rationale for *where* anonymization/pseudonymization belongs — per-surface decision framework across all seven copies (chat send / store / private files / shared knowledge files / memory / derived sinks / model reasoning), the round-trip ("does it map back?") analysis, and the EU legal frame (EDPB 01/2025, CJEU *EDPS v SRB*) | ✅ current (2026-08-31) |
| [`pii-masking-and-anonymization.md`](./pii-masking-and-anonymization.md) | The KK20-207 discovery assessment — data classification, per-category handling matrix, engine options, the phased roadmap, plus §11's verification log and §12's future-problem register | **v1.2** (2026-07-06 recheck, restored 2026-09-01) — carries a banner listing what post-dates it; the v1.3 delta lives in `workstream.md` §2 |

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

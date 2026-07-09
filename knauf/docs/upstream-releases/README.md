# Upstream releases — LibreChat sync notes for the Knauf fork

Per-version technical notes for each upstream LibreChat release merged into `Knauf-Group/agentic-karl-v2`. One doc per upstream tag, written for the developers and operators who run and extend the fork: what landed, what it means for Knauf's `[knauf]` seams, and what to configure or follow up on.

This is a **durable per-version record**. Unlike [`../implementation-plans/`](../implementation-plans/) (time-bound rollouts) or [`../contributing/upstream-sync.md`](../contributing/upstream-sync.md) (the ritual for *performing* a sync), these notes stay put as the standing answer to "what changed in vX.Y.Z, and how did we absorb it?"

---

## What each version doc contains

- **New features available to Knauf** — grouped by area, each with an enable/config note and whether the fork already exposes it, hasn't wired it up, or intentionally hides it.
- **Security hardening now in place** — the security-relevant commits, with upstream PR references and a Knauf-relevant risk class (SSRF, ReDoS, auth/session, tenant isolation, log/telemetry redaction, shared-link, authz).
- **Seam interactions** — a table of how each upstream change met a `[knauf]` seam during the merge (what moved, what was preserved, how it was resolved).
- **Config & env changes** — deltas an operator must apply (or an explicit "none").
- **Follow-ups / action items** — decisions the fork still owes (adopt/hide a feature, bump config version, set a new secret).

## How these are built

Content is derived from the **verified git commit ranges** between upstream tags (`git log upstream/vA..upstream/vB`) — authoritative for what is actually in the fork — cross-referenced against the marketing changelog at [`librechat.ai/changelog`](https://www.librechat.ai/changelog). The merges themselves are recorded in [`../../../SEAMS.md`](../../../SEAMS.md) and landed via the [upstream-sync ritual](../contributing/upstream-sync.md).

---

## Versions

| Version | Upstream tag | Merged | Notes |
|---|---|---|---|
| **v0.8.6** | `v0.8.6` (2026-05-31) | 2026-07-08 | [v0.8.6.md](v0.8.6.md) — Prometheus `/metrics`, OpenTelemetry + SSE tracing, readiness endpoints + graceful shutdown, MCP proxy SSRF hardening, unauthenticated `/api/config` field stripping, People-Picker ReDoS fix |
| **v0.8.7** | `v0.8.7` (2026-06-24) | 2026-07-08 | [v0.8.7.md](v0.8.7.md) — Agent Skills / Subagents, keyboard shortcuts, real-time token/context usage, pinned & archived chats, message timestamps; admin-panel session-secret requirement, shared-file cookie authz, `execute_code` re-authz, YouTube-URL ReDoS fix |

Both versions were merged onto the `chore/upstream-v0.8.7` integration branch, with v0.8.7 stacked on the v0.8.6 merge. The upstream baseline before this sync was `v0.8.5`.

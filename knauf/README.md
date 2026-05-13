# knauf/

Knauf-specific layer for `agentic-karl-v2` — a thin fork of [LibreChat](https://github.com/danny-avila/LibreChat).

## What's here

| Directory / File | Purpose |
|---|---|
| `docs/` | Fork management documentation |
| `scripts/seams.js` | Seam manifest validator (`check`, `scan`, `diff-check`) |
| `MIGRATION.md` | How this repo was created and why we re-forked |

---

## Context

**What we're forking.** LibreChat is an open-source AI chat platform — Node.js/Express backend, React frontend, MongoDB storage. It moves fast: multiple minor releases per month, frequent component refactors, evolving TypeScript migration.

**Why we fork.** We need to layer enterprise features, integrations, and UX adaptations that go beyond what configuration alone can provide.

**Why agentic-karl-v2 exists.** Two predecessors (`cst-karl-webui` with 86 module-aliased override files, `agentic-karl` with 127 untracked commits) had accumulated enough drift that upstream sync was impossible in practice. This repo was re-forked with native shared ancestry at upstream `v0.8.5`, using the thin fork pattern below. Every customization is either a config value, a net-new file in a `knauf/` directory, or a tracked `[knauf]` marker.

---

## The Core Rule

> **Default to the lowest tier that can express the change. Escalate only when the lower tiers genuinely cannot.**

---

## Documentation

### Guides

| Doc | When to read it |
|---|---|
| [docs/guides/customization-guide.md](docs/guides/customization-guide.md) | Deciding where a change belongs + how to track it in SEAMS.md |
| [docs/guides/upstream-sync.md](docs/guides/upstream-sync.md) | Step-by-step ritual for picking up an upstream sync issue |

### Reference

| Doc | When to read it |
|---|---|
| [docs/reference/quick-start.md](docs/reference/quick-start.md) | Commands cheat-sheet, anti-patterns, known limitations |
| [docs/reference/git-workflow.md](docs/reference/git-workflow.md) | Merge protocol, best practices, CI automation |
| [docs/reference/testing-and-rollback.md](docs/reference/testing-and-rollback.md) | Seam tests, emergency rollback |
| [docs/migration.md](docs/migration.md) | Historical record: how this repo was created, why we re-forked |

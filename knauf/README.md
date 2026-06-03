# knauf/

Knauf-specific layer for `agentic-karl` — a thin fork of [LibreChat](https://github.com/danny-avila/LibreChat).


## Context

**What we're forking.** LibreChat is an open-source AI chat platform — Node.js/Express backend, React frontend, MongoDB storage. It moves fast: multiple minor releases per month, frequent component refactors, evolving TypeScript migration.

**Why we fork.** We need to layer enterprise features, integrations, and UX adaptations that go beyond what configuration alone can provide.

**Why agentic-karl exists.** Two predecessors (`cst-karl-webui` with 86 module-aliased override files, `agentic-karl-old`) had accumulated enough drift that upstream sync was hard in practice. This repo was re-forked with native shared ancestry at upstream `v0.8.5`, using the thin fork pattern below. Every customization is either a config value, a net-new file in a `knauf/` directory, or a tracked `[knauf]` marker.

---


## The Core Rule

> **Default to the lowest tier that can express the change. Escalate only when the lower tiers genuinely cannot.**

---

## Local development

```bash
# Install
nvm use            # Node v24, per .nvmrc
npm ci

# Build
npm run build:packages     # data-provider, data-schemas, api, client-package — run first
npm run frontend           # full client build
npm run build              # turbo build across all workspaces

# Supporting services (mongo, meilisearch, vectordb, rag_api — not the api service)
docker compose up -d mongodb meilisearch vectordb rag_api

# Dev (two terminals — backend on host, frontend on host)
npm run backend:dev        # nodemon Express on :3080
npm run frontend:dev       # Vite dev server on :3090, proxies to :3080

# Test
npm run test:api           # api tests
npm run test:client        # client tests
npm run e2e:ci             # Playwright (no test cases yet)
```

---

## Making a change — the process

Follow this order. Each step assumes the previous one is complete.

1. **Read the protocol.** Open [docs/reference/code-change-protocol.md](docs/reference/code-change-protocol.md). The tier ladder decides where your change goes; the Anti-Patterns and Refusals sections list what reviewers will reject.
2. **Pick the lowest tier that works.** Walk the Decision Framework: Tier 0 config → Tier 1 MCP/Action → Tier 2 asset overlay → Tier 3 net-new Knauf code → Tier 4a/b/c/d upstream modification. Stop at the first "yes".
3. **If Tier 4c (inline `[knauf]` marker):** wrap the change in `[knauf] <reason> ... End [knauf]` and add a row to [SEAMS.md](../SEAMS.md). Easiest path: invoke the `seam-manifest` skill at [.agents/skills/seam-manifest](../.agents/skills/seam-manifest) — it handles the marker, the SEAMS.md row, and re-runs the validator. Manual reference: [code-change-protocol.md § Tracking Changes](docs/reference/code-change-protocol.md#tracking-changes-tier-4c).
4. **Run the seam tooling before opening the PR:**
   ```bash
   node knauf/scripts/seams.js check --all                 # validate SEAMS.md ↔ markers
   node knauf/scripts/seams.js scan --all                  # list every seam found in source
   node knauf/scripts/seams.js diff-check --base=<sha>     # check the PR diff for untagged upstream mods
   ```
   `check` and `diff-check` are the CI merge gate; both must exit 0.
5. **Write a seam test.** Every `[knauf]` marker needs a corresponding test — see [docs/reference/testing-and-rollback.md](docs/reference/testing-and-rollback.md). Untested seams fail silently when upstream refactors.
6. **If you're working with AI:** the two skills at [.agents/skills/](../.agents/skills/) wrap steps 2–4. Invoke [`fork-management`](../.agents/skills/fork-management) *before* the change (tier selection + anti-pattern checks) and [`seam-manifest`](../.agents/skills/seam-manifest) *after* adding or editing a `[knauf]` marker or net-new `knauf/`-directory file (runs the seam tooling and authors the SEAMS.md row). Don't relitigate the tier choice once a skill has done it.

**Picking up an upstream-sync issue instead?** Skip the steps above and follow [docs/guides/upstream-sync.md](docs/guides/upstream-sync.md).

---

## Documentation

### Guides

| Doc | When to read it |
|---|---|
| [docs/guides/upstream-sync.md](docs/guides/upstream-sync.md) | Step-by-step ritual for picking up an upstream sync issue |

### Reference

| Doc | When to read it |
|---|---|
| [docs/reference/code-change-protocol.md](docs/reference/code-change-protocol.md) | Tier ladder, marker / SEAMS.md format, anti-patterns, refusals |
| [docs/reference/git-workflow.md](docs/reference/git-workflow.md) | Merge protocol, CI automation |
| [docs/reference/testing-and-rollback.md](docs/reference/testing-and-rollback.md) | Seam tests, emergency rollback |
| [docs/reference/azure-blob-storage.md](docs/reference/azure-blob-storage.md) | How file storage works on Azure — SAS-token anatomy, refresh chain, TTL math, signing modes, before/after diagrams |
| [docs/reference/image-gen-toggle.md](docs/reference/image-gen-toggle.md) | How the image-generation toggle works on agent chats and default Knauf model spec chats (admin opt-in + per-chat chip + visibility hook + backend gate) — sequence + flowchart + component map |
| [docs/migration.md](docs/migration.md) | Historical record: how this repo was created, why we re-forked |

### Implementation plans

Time-bound, multi-PR workstreams being executed. Plans get deleted, promoted to `reference/`, or archived once the rollout finishes — see [docs/implementation-plans/README.md](docs/implementation-plans/README.md) for the lifecycle convention.

| Doc | What it covers |
|---|---|
| [docs/implementation-plans/azure-blob-and-private-files.md](docs/implementation-plans/azure-blob-and-private-files.md) | Azure Blob private-container rollout — upstream PR status, deployment-configs changes, prod hardening checklist, end-to-end verification recipes |

---

# Copilot Instructions — agentic-karl

## What This Repo Is

A **thin fork** of [LibreChat](https://github.com/danny-avila/LibreChat) maintained by Knauf. We track upstream releases and apply minimal, well-documented modifications. The goal is to stay as close to upstream as possible to make merges painless.

- **Upstream remote:** `https://github.com/danny-avila/LibreChat.git`
- **Current base:** see `SEAMS.md` for the tracked upstream version
- **Our tags:** `knauf/base-*` (upstream baseline), `v*` (our releases)

## Thin Fork Rules

1. **Never modify upstream files without marking them.** Add a `// [knauf] <reason>` comment at the modification site.
2. **Every `[knauf]` marker must have a matching entry in `SEAMS.md`** (Inline Modifications table).
3. **Prefer the extension system over inline modifications.** LibreChat supports `api/extend/` and `client/src/extend/` override directories with module aliases.
4. **Net-new Knauf code goes in `knauf/` directories:** `api/knauf/`, `client/src/knauf/`, `packages/knauf/`.
5. **Knauf-specific dependencies go in `packages/knauf/package.json`**, not in the root or other workspace `package.json` files.

## Extension System

LibreChat uses module aliasing for overrides:

- **Backend:** `api/extend/` — aliases defined in `api/package.json` (`_moduleAliases`) and `api/babel.config.js` (`module-resolver` plugin). Both must stay in sync.
- **Frontend:** `client/src/extend/` — aliases in `client/vite.config.ts` (`resolve.alias`).
- **Always prefer extending** over modifying upstream files. Extensions don't create merge conflicts.

## Project Structure

```
agentic-karl/
├── api/                    # Express backend
│   ├── extend/             # Backend extension overrides
│   └── knauf/              # Knauf net-new backend code
├── client/                 # React frontend (Vite)
│   └── src/
│       ├── extend/         # Frontend extension overrides
│       └── knauf/          # Knauf net-new frontend code
├── packages/
│   ├── data-provider/      # Shared data types + React Query hooks
│   ├── data-schemas/       # Shared schemas + utilities
│   ├── api/                # Shared API utilities
│   ├── client/             # Shared client utilities
│   └── knauf/              # Knauf-specific shared package
├── SEAMS.md                # Upstream modification manifest
├── librechat.yaml          # App configuration (models, endpoints, UI toggles)
└── .env                    # Environment variables (gitignored)
```

## Build & Test

```bash
# Build workspace packages (required before tests or dev)
npm run build:packages

# Development
npm run backend:dev    # Express server on :3080
npm run frontend:dev   # Vite dev server on :3090

# Tests
npm run test:all       # All suites, no coverage (fast local)
npm run test:coverage  # Client with coverage + all others (CI)
npm run test:client    # Client tests only
npm run test:api       # API tests only (uses --forceExit)
```

**Important:** Always run `npm run build:packages` after a fresh clone or after changing code in `packages/*`. Client and API tests depend on built package output.

## Key Config Surfaces

| File | What it controls |
|---|---|
| `librechat.yaml` | Model endpoints, agent config, interface toggles, welcome text, rate limits |
| `.env` | Azure OpenAI keys, MongoDB URI, RAG API URL, MeiliSearch, auth providers |
| `.nvmrc` | Node.js version (v24 for local dev; Dockerfile uses node:20 for production) |

## CI Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `test_pipeline.yaml` | PR to main | Runs all tests via shared workflow + SonarCloud |
| `seam-validator.yml` | PR to main | Validates `[knauf]` markers ↔ SEAMS.md |
| `upstream-release-watcher.yml` | Weekday cron + manual | Creates issues when upstream has new releases |
| `release_pipeline.yaml` | Push to main | Docker build → ACR → ArgoCD |
| `cleanup-gh-cache.yml` | PR close | Cleans GitHub Actions cache |

## Known Gotchas

- **API tests hang without `--forceExit`** — open DB handles in test teardown (upstream issue)
- **`packages/*` must be built before tests** — `Cannot find module 'librechat-data-provider'` means you need `npm run build:packages`
- **API tests need ~4GB heap on CI** — `NODE_OPTIONS="--max-old-space-size=6144"` is set in the test pipeline
- **Our `v*` tags overlap upstream's** — use `knauf/base-*` tags for upstream version tracking

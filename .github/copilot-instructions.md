# Copilot Instructions — agentic-karl

## What This Repo Is

A **thin fork** of [LibreChat](https://github.com/danny-avila/LibreChat) maintained by Knauf. We track upstream releases and apply minimal, well-documented modifications.

- **Upstream:** `https://github.com/danny-avila/LibreChat.git` — see `SEAMS.md` for tracked version
- **Tags:** `knauf/base-*` (upstream baseline), `v*` (our releases)

## Thin Fork Rules

1. **Never modify upstream files without marking them.** Add a `// [knauf] <reason>` comment at the modification site.
2. **Every `[knauf]` marker must have a matching entry in `SEAMS.md`** (Inline Modifications table).
3. **Prefer the lowest-risk tier that can express the change.** Tier ladder: config (`librechat.yaml`/.env) → MCP/Actions → asset overlay → `knauf/` directories → inline `[knauf]` markers → full file override (last resort).
4. **Net-new Knauf code goes in `knauf/` directories:** `api/knauf/`, `client/src/knauf/`, `packages/knauf/`.
5. **Knauf-specific dependencies go in `packages/knauf/package.json`**, not in the root or other workspace `package.json` files.

## Customization Tiers (Lowest Risk First)

| Tier | Approach | Merge Risk |
|---|---|---|
| **0** Config | `librechat.yaml`, `.env`, Admin API | None |
| **1** MCP/Actions | Custom tools via MCP servers or OpenAPI Actions | None |
| **2** Asset Overlay | Logos, favicons via Docker layer | None |
| **3** Knauf Code | `packages/knauf/`, `api/knauf/`, `client/src/knauf/` | Minimal |
| **4c** Inline Mods | `[knauf]`-marked changes (≤20 lines), tracked in `SEAMS.md` | Medium |
| **4d** File Override | Module aliasing — full file replacement. **Last resort.** | High |

> ⚠️ This repo does **not** use `api/extend/` or `client/src/extend/` module aliasing from cst-karl-webui. That pattern (86 overrides, 47 aliases) is what we're avoiding.

## Project Structure

```
agentic-karl/
├── api/                    # Express backend
│   └── knauf/              # Knauf net-new backend code
├── client/                 # React frontend (Vite)
│   └── src/
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

## Known Gotchas

- **`packages/*` must be built before tests** — `Cannot find module 'librechat-data-provider'` means you need `npm run build:packages`
- **API tests need `--forceExit`** — open DB handles in test teardown (upstream issue)
- **Our `v*` tags overlap upstream's** — use `knauf/base-*` tags for upstream version tracking

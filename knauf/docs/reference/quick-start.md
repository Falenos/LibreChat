# Quick Start

---

## Common Commands

**Node version:** `v24` (local dev, see [.nvmrc](../../.nvmrc)). Docker builds use `node:20-alpine`.

```bash
# Install
npm ci

# Build
npm run build:packages     # run this first — data-provider, data-schemas, api, client-package
npm run frontend           # full client build
npm run build              # turbo build (all workspaces)

# Dev
npm run backend:dev        # nodemon Express on :3080
npm run frontend:dev       # Vite dev server on :3090 (proxies to :3080)

# Docker (starts mongodb, meilisearch, vectordb, rag_api — NOT the api service)
docker compose up -d

# Test
npm run test:coverage      # all 5 suites (client coverage + api + packages)
npm run test:api           # api tests only
npm run test:client        # client tests only
npm run e2e:ci             # Playwright (no test cases yet)


# Seam tooling
node knauf/scripts/seams.js check --all               # validate before every PR
node knauf/scripts/seams.js scan --all                # list all seams
node knauf/scripts/seams.js diff-check --base=<sha>   # check PR diff for untagged upstream mods
```

---

## Anti-Patterns

Patterns that increase maintenance cost disproportionately. Avoid unless explicitly justified.

| ✕ | Why |
|---|---|
| **Building custom auth/permission infrastructure** | LibreChat has `PermissionTypes`, `useHasAccess`, `requireCapability`, per-role config, admin APIs. Use them. |
| **Defaulting to module aliasing** | Full-file ownership for small changes. Use only when explicitly justified. |
| **Modifying upstream without `[knauf]` markers** | Invisible during merge — creates hidden merge obligations. |
| **`git rebase` for upstream sync** | Re-resolves conflicts on every rebase, loses merge history. Use `merge --no-ff`. |
| **Assuming env vars are runtime** | Vite bakes `REACT_APP_*` at build time. Changing theme = rebuild + redeploy. |
| **Seams without tests** | Every `[knauf]` marker needs a corresponding test. Untested seams fail silently on upstream refactor. |
| **Overengineering for hypothetical needs** | Document the option. Implement when the need materializes. |

## Refusals

Hard stops — reject in code review.

| ✕ | Why |
|---|---|
| **Pulling `:latest`** | Pin to versioned upstream tags. `docker-compose.yml` currently pulls `:latest` — that is a known issue, not a precedent. |
| **Parallel flag system** | Don't build a second feature-flag system alongside LibreChat's `PermissionTypes`. |
| **Skipping upstream merges** | The next one costs 2×. Every skipped release increases drift exponentially. |
| **Custom dependency machinery** | Don't invent `knauf-dependencies.json` with a post-install merge script. Use `packages/knauf/package.json`. |
| **Merging without CI green** | Seam validator + tests are the merge gate. No exceptions. |

---

## Known Limitations

| Gap | Detail |
|---|---|
| **Upstream sync at v0.8.5** | Fork is ~12 minor versions behind (`v0.20.0`). Fresh re-fork is likely the right path at this drift level. |
| **`Dockerfile.knauf` not created** | Branding Tier 2 pattern is designed but not implemented. Brand changes currently require source commits. |
| **`REACT_APP_THEME_*` env prefix unset** | Adding `'REACT_APP_'` to `envPrefix` in `vite.config.ts` is a Tier 4c seam not yet applied. Theme color env vars do not function. |
| **`packages/knauf/src/` empty** | The workspace is ready but no shared Knauf code has been extracted yet. |
| **Smoke tests not authored** | Playwright config exists but has no test cases. First merges rely on manual staging verification. |

---

## Related

- [customization.md](customization.md) — where a change belongs and how to track it

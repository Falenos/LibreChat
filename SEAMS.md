# SEAMS.md — Knauf Upstream Modifications

## Upstream Base

| Field | Value |
|---|---|
| LibreChat tag | `v0.8.5` |
| Base tag | `knauf/base-v0.8.5` |
| Last synced | 2026-05-07 |

The `LibreChat tag` row is the upstream baseline used by [`upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) to compute `upstream/<base>..upstream/<latest>` diffs. It must be a real tag in `danny-avila/LibreChat`. The `Base tag` row is the Knauf-side anchor used by humans to identify the merge commit on the fork.

## Inline Modifications

<!-- seams:auto:begin -->
| File | Symbol/Anchor | Lines | Purpose | Tests |
|---|---|---|---|---|
| `api/server/index.js` | `app.use('/api/knauf', ...)` | 189–191 | Mount-point — Knauf-only Express router under `/api/knauf` | `api/server/routes/knauf/autogeneratePrompt.spec.js` |
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig` | 32–36 | Import swap — replaces upstream `AgentConfig` with `AgentConfigSwitch`, a Knauf-only router that picks between upstream `AgentConfig` (admin detailed) and `KnaufAgentConfig` (everyone else, and admins toggled to simplified). KK20-125 / FEAT-03 | Manual (builder renders correctly per role) |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `KNAUF_HIDE_ADVANCED`, `KNAUF_HIDE_DUPLICATE`, `knauf-admin-builder-mode-switch` | 21–30, 49–56, 99–136, 137–139, 181–185 | Inline gate + UI: simplification flags are computed at runtime from role + persisted builder mode (admins in detailed mode see Advanced + Duplicate); the admin-only view toggle sits at the top of the footer (above Version) as a full-width `Button` styled like Version / Admin Settings. Icon + label are *action-oriented* — they describe the mode clicking will land in, not the current mode (LayoutDashboard + "Detailed view" while simplified is active; minimalist `List` + "Simplified view" while detailed is active). `aria-pressed` still carries the current state for assistive tech. KK20-125 / FEAT-03 | `AgentFooter.spec.tsx` |
| `client/src/components/SidePanel/Agents/__tests__/AgentFooter.spec.tsx` | `[knauf]` assertions + builder-mode mock | 158–178, 180–197, 300–305, 312–319, 469–496, 524–550, 570–653 | Test adaptation — mocks the Recoil `useRecoilState` and Knauf builder-mode atom + the upstream `Button` primitive used by the toggle; pins the runtime gate behaviour (Advanced/Duplicate absent in admin-simplified and non-admin paths; present in admin-detailed) and exercises the toggle button click | Self |
| `client/src/components/SidePanel/Agents/AgentPanel.test.tsx` | `KnaufAgentConfig` + `AgentConfigSwitch` mocks | 149–163 | Test adaptation — mocks both the original `KnaufAgentConfig` and the new `AgentConfigSwitch` router (KK20-125) to cut the deep import chain that breaks IconContext | Self |
| `Dockerfile` | `COPY librechat.yaml` | 31–33 | Embeds librechat.yaml at build time — Knauf config, not shipped by upstream | Manual |
| `api/test/__mocks__/logger.js` | `mockFormatFunction` | 2–5 | Return a factory `(fn) => () => ({ transform: fn })` so `winston.format(fn)()` matches the shape `@librechat/data-schemas/dist/config/winston.cjs` expects; the upstream `(fn) => fn` mock causes `info.level` undefined throws when the data-schemas dist code calls `parsers.redactFormat()` at module-load | `api/config/__tests__/parsers.spec.js` |
| `packages/api/src/agents/__tests__/memory.test.ts` | `jest.mock('winston', ...)` | 15–38 | Replace plain-object `format` with a callable factory + full method surface (printf, timestamp, errors, splat, json, addColors, transports.DailyRotateFile) so `@librechat/data-schemas` dist loads at module-init when this spec pulls in `~/agents/memory` | Self |
| `packages/api/src/agents/__tests__/run-summarization.test.ts` | `jest.mock('winston', ...)` | 14–37 | Same mock-shape fix as memory.test.ts — `winston.format` callable, full method surface — so data-schemas dist loads via `~/agents/run` import | Self |
| `packages/api/src/agents/__tests__/initialize.test.ts` | `jest.mock('winston', ...)` | 16–39 | Same mock-shape fix as memory.test.ts — data-schemas dist is pulled in via `src/utils/axios` and needs the full callable-format surface | Self |
<!-- seams:auto:end -->

## Configuration

| File             | Purpose |
|------------------|---|
| `librechat.yaml` | Interface toggles, agent config, model specs, welcome text |
| `.env`           | Azure OpenAI keys, MongoDB URI, RAG API URL, MeiliSearch config |
| `Dockerfile`     | `# [knauf] Keep workspace runtime deps...` | 
| `packages/api/package.json` | `"mongodb": "^6.14.2"` moved from `devDependencies` → `peerDependencies` | Fixes production `MODULE_NOT_FOUND` crash — `mongodb` was externalized by rollup but not declared as a peer, so prod installs omitted it |
| `api/package.json` | `"mongodb": "^6.14.2"` added to `dependencies` | Peer dep fulfillment — ensures `mongodb` is present in production `node_modules` so `@librechat/api` dist can resolve it |
| `client/src/locales/en/translation.json` | `com_knauf_*` namespace — Knauf-only i18n keys added inline to the upstream locale JSON (JSON has no comment syntax, so no `[knauf]` marker is possible). Current keys: `com_knauf_builder_simplified_view` (KK20-125 / FEAT-03, admin builder toggle label). Future Knauf-only keys must reuse the `com_knauf_*` prefix so they are greppable and namespaced away from upstream |

## Net-New Files

<!-- seams:new:begin -->
| File | Upstream Imports | Coupling Risk | Tests |
|---|---|---|---|
| `api/server/routes/knauf/index.js` | `express` | Low — additive router | — |
| `api/server/routes/knauf/autogeneratePrompt.js` | `requireJwtAuth`, `getProviderConfig`, `initializeModel` (`@librechat/agents`) | Low/Medium — upstream middleware + the same single-entry-point `initializeModel` the agent graph uses (provider-agnostic, no provider-specific deps) | `autogeneratePrompt.spec.js` |
| `client/src/knauf/components/Agents/KnaufAgentConfig.tsx` | `~/{hooks,components}/*` (12+ upstream imports) | High — builds on upstream form context, hooks, components | Manual |
| `client/src/knauf/components/Agents/KnaufFileSearch.tsx` | `~/{hooks,components}/*` | Medium — fork of upstream `FileSearch`, drops checkbox | Manual |
| `client/src/knauf/components/Agents/*.tsx` | Various upstream hooks/components | Low-Medium — UI-only, no upstream file modifications | `agents-types.spec.ts`, `usePersonalities.spec.ts` |
| `client/src/knauf/data-provider/*.ts` | `librechat-data-provider` types | Low — pure data layer, no upstream modifications | `usePersonalities.spec.ts` |
| `client/src/knauf/common/*.ts` | `librechat-data-provider` types | Low — shared constants and types | `agents-types.spec.ts` |
| `client/src/knauf/store/builderMode.ts` | `~/store/utils` (`atomWithLocalStorage` helper) | Low — pure Recoil atom with localStorage persistence; no upstream contract surface | `builderMode.spec.ts` |
| `client/src/knauf/store/builderMode.spec.ts` | Subject only (`./builderMode`) | Low — smoke test pinning the localStorage key + atom default | Self |
| `client/src/knauf/components/Agents/AgentConfigSwitch.tsx` | `recoil`, `librechat-data-provider` (`SystemRoles`), `~/components/SidePanel/Agents/AgentConfig` (upstream builder), `~/hooks/AuthContext`, `./KnaufAgentConfig`, `~/knauf/store/builderMode` | Medium — renders upstream `AgentConfig` directly; an upstream rename or default-export change would surface here as a wrapper-side import error | `AgentConfigSwitch.knauf.spec.tsx` |
| `client/src/knauf/components/Agents/AgentConfigSwitch.knauf.spec.tsx` | Subject under test + mocks for upstream auth/Recoil/AgentConfig | Low — test-only | Self |
<!-- seams:new:end -->

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

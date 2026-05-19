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
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig` | 32–34 | Import swap — replaces upstream `AgentConfig` with `KnaufAgentConfig` | Manual (builder renders correctly) |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `KNAUF_HIDE_ADVANCED`, `KNAUF_HIDE_DUPLICATE` | 22–29, 89–93, 135–139 | Inline gate — hides Advanced panel button and Duplicate agent button for simplified builder | `AgentFooter.spec.tsx` |
| `client/src/components/SidePanel/Agents/__tests__/AgentFooter.spec.tsx` | `[knauf]` assertions | 269–276, 426–453, 481–507 | Test adaptation — expects Advanced/Duplicate buttons to be absent (matches seam behavior) | Self |
| `client/src/components/SidePanel/Agents/AgentPanel.test.tsx` | `KnaufAgentConfig` mock | 149–156 | Test adaptation — mocks KnaufAgentConfig to cut deep import chain that breaks IconContext | Self |
| `Dockerfile` | `COPY librechat.yaml` | 31–33 | Embeds librechat.yaml at build time — Knauf config, not shipped by upstream | Manual |
| `api/test/__mocks__/logger.js` | `mockFormatFunction` | 2–5 | Return a factory `(fn) => () => ({ transform: fn })` so `winston.format(fn)()` matches the shape `@librechat/data-schemas/dist/config/winston.cjs` expects; the upstream `(fn) => fn` mock causes `info.level` undefined throws when the data-schemas dist code calls `parsers.redactFormat()` at module-load | `api/config/__tests__/parsers.spec.js` |
| `packages/api/src/agents/__tests__/memory.test.ts` | `jest.mock('winston', ...)` | 15–38 | Replace plain-object `format` with a callable factory + full method surface (printf, timestamp, errors, splat, json, addColors, transports.DailyRotateFile) so `@librechat/data-schemas` dist loads at module-init when this spec pulls in `~/agents/memory` | Self |
| `packages/api/src/agents/__tests__/run-summarization.test.ts` | `jest.mock('winston', ...)` | 14–37 | Same mock-shape fix as memory.test.ts — `winston.format` callable, full method surface — so data-schemas dist loads via `~/agents/run` import | Self |
| `packages/api/src/agents/__tests__/initialize.test.ts` | `jest.mock('winston', ...)` | 16–39 | Same mock-shape fix as memory.test.ts — data-schemas dist is pulled in via `src/utils/axios` and needs the full callable-format surface | Self |
| `client/src/hooks/Nav/useUnifiedSidebarLinks.ts` | `useUnifiedSidebarLinks` | 4–11, 29–32, 74–84, 88–90 | Inject a primary-nav marketplace `NavLink` immediately after the Conversations link, gated by `useShowMarketplace`. `onClick` navigates to `/agents`; no side-panel `Component`, since `NavIconButton` honours `link.onClick` directly. Promotes the marketplace from the hidden Favorites card to a top-level sidebar entry (KK20-124 / FEAT-02) | `client/src/knauf/hooks/Nav/useUnifiedSidebarLinks.knauf.spec.tsx` |
| `client/src/components/Nav/Favorites/FavoritesList.tsx` | `FavoritesList` | 131–137 | Force `showAgentMarketplace = false` so the favorites-section marketplace skeleton/card no longer renders. Existing gates downstream (lines 344, 352, 366, 375) all key off this constant. Pairs with the sidebar promotion in `useUnifiedSidebarLinks.ts` (KK20-124) | `FavoritesList.spec.tsx` |
| `client/src/components/Conversations/Conversations.tsx` | `Conversations` | 169–175 | Force `showAgentMarketplace = false` so the favorites CellMeasurerCache key and section-visibility logic (lines 182, 184, 267) no longer keep the marketplace alive in the chat-history panel. Pairs with the sidebar promotion (KK20-124) | `Conversations.test.tsx` |
| `client/src/components/Conversations/__tests__/Conversations.test.tsx` | `[knauf] should NOT invalidate` | 157–178 | Test adaptation — pins the seam behavior: with `showAgentMarketplace` hard-coded to false, marketplace visibility no longer participates in the favorites cache key, so the cache must NOT be invalidated when the underlying hook value flips (KK20-124) | Self |
<!-- seams:auto:end -->

## Configuration

| File             | Purpose |
|------------------|---|
| `librechat.yaml` | Interface toggles, agent config, model specs, welcome text |
| `.env`           | Azure OpenAI keys, MongoDB URI, RAG API URL, MeiliSearch config |
| `Dockerfile`     | `# [knauf] Keep workspace runtime deps...` | 
| `packages/api/package.json` | `"mongodb": "^6.14.2"` moved from `devDependencies` → `peerDependencies` | Fixes production `MODULE_NOT_FOUND` crash — `mongodb` was externalized by rollup but not declared as a peer, so prod installs omitted it |
| `api/package.json` | `"mongodb": "^6.14.2"` added to `dependencies` | Peer dep fulfillment — ensures `mongodb` is present in production `node_modules` so `@librechat/api` dist can resolve it |

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
| `client/src/knauf/hooks/Nav/useUnifiedSidebarLinks.knauf.spec.tsx` | `~/hooks/Nav/useUnifiedSidebarLinks` (subject under test); all transitive upstream deps mocked | Low — test-only; mocks every upstream dependency so it pins the seam without bleeding into upstream contracts | Self |
<!-- seams:new:end -->

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

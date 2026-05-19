# SEAMS.md — Knauf Upstream Modifications

## Upstream Base

| Field | Value |
|---|---|
| LibreChat tag | `v0.8.5` |
| Base tag | `knauf/base-v0.8.5` |
| Last synced | 2026-05-07 |

The `LibreChat tag` row is the upstream baseline used by [`upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) to compute `upstream/<base>..upstream/<latest>` diffs. It must be a real tag in `danny-avila/LibreChat`. The `Base tag` row is the Knauf-side anchor used by humans to identify the merge commit on the fork.

## Inline Modifications

> **Append-only.** Each ticket appends its own row(s); prior rows are never edited. A single upstream file may appear in multiple rows, one per ticket that touched it. The `Ticket` column carries the originating Jira ID (`KK20-XXX`), or `—` for rows that predate the convention. `Lines` is captured at the commit that added the seam; drift after subsequent reformats is accepted. See [.claude/skills/seam-manifest/SKILL.md](.claude/skills/seam-manifest/SKILL.md).

<!-- seams:auto:begin -->
| File | Symbol/Anchor | Lines | Purpose | Tests | Ticket |
|---|---|---|---|---|---|
| `api/server/index.js` | `app.use('/api/knauf', ...)` | 189–191 | Mount-point — Knauf-only Express router under `/api/knauf` | `api/server/routes/knauf/autogeneratePrompt.spec.js` | — |
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig`, `composeAgentUpdatePayload` | 32–34, 81–83, 109–111 | Import swap — replaces upstream `AgentConfig` with `KnaufAgentConfig`; forwards `spec` field through PATCH/POST agent payloads (BUG-01) | Manual (builder renders correctly), `AgentPanel.test.tsx` | KK20-120 |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `KNAUF_HIDE_ADVANCED`, `KNAUF_HIDE_DUPLICATE` | 22–29, 89–93, 135–139 | Inline gate — hides Advanced panel button and Duplicate agent button for simplified builder | `AgentFooter.spec.tsx` | — |
| `client/src/components/SidePanel/Agents/__tests__/AgentFooter.spec.tsx` | `[knauf]` assertions | 269–276, 426–453, 481–507 | Test adaptation — expects Advanced/Duplicate buttons to be absent (matches seam behavior) | Self | — |
| `client/src/components/SidePanel/Agents/AgentPanel.test.tsx` | `KnaufAgentConfig` mock | 149–156 | Test adaptation — mocks KnaufAgentConfig to cut deep import chain that breaks IconContext | Self | — |
| `Dockerfile` | `COPY librechat.yaml` | 31–33 | Embeds librechat.yaml at build time — Knauf config, not shipped by upstream | Manual | — |
| `api/test/__mocks__/logger.js` | `mockFormatFunction` | 2–5 | Return a factory `(fn) => () => ({ transform: fn })` so `winston.format(fn)()` matches the shape `@librechat/data-schemas/dist/config/winston.cjs` expects; the upstream `(fn) => fn` mock causes `info.level` undefined throws when the data-schemas dist code calls `parsers.redactFormat()` at module-load | `api/config/__tests__/parsers.spec.js` | — |
| `packages/api/src/agents/__tests__/memory.test.ts` | `jest.mock('winston', ...)` | 15–38 | Replace plain-object `format` with a callable factory + full method surface (printf, timestamp, errors, splat, json, addColors, transports.DailyRotateFile) so `@librechat/data-schemas` dist loads at module-init when this spec pulls in `~/agents/memory` | Self | — |
| `packages/api/src/agents/__tests__/run-summarization.test.ts` | `jest.mock('winston', ...)` | 14–37 | Same mock-shape fix as memory.test.ts — `winston.format` callable, full method surface — so data-schemas dist loads via `~/agents/run` import | Self | — |
| `packages/api/src/agents/__tests__/initialize.test.ts` | `jest.mock('winston', ...)` | 16–39 | Same mock-shape fix as memory.test.ts — data-schemas dist is pulled in via `src/utils/axios` and needs the full callable-format surface | Self | — |
| `client/src/hooks/Nav/useUnifiedSidebarLinks.ts` | `useUnifiedSidebarLinks` | 4–11, 29–32, 74–84, 88–90 | Inject a primary-nav marketplace `NavLink` immediately after the Conversations link, gated by `useShowMarketplace`. `onClick` navigates to `/agents`; no side-panel `Component`, since `NavIconButton` honours `link.onClick` directly. Promotes the marketplace from the hidden Favorites card to a top-level sidebar entry (KK20-124 / FEAT-02) | `client/src/knauf/hooks/Nav/useUnifiedSidebarLinks.knauf.spec.tsx` | KK20-124 |
| `client/src/components/Nav/Favorites/FavoritesList.tsx` | `FavoritesList` | 131–137 | Force `showAgentMarketplace = false` so the favorites-section marketplace skeleton/card no longer renders. Existing gates downstream (lines 344, 352, 366, 375) all key off this constant. Pairs with the sidebar promotion in `useUnifiedSidebarLinks.ts` (KK20-124) | `FavoritesList.spec.tsx` | KK20-124 |
| `client/src/components/Conversations/Conversations.tsx` | `Conversations` | 169–175 | Force `showAgentMarketplace = false` so the favorites CellMeasurerCache key and section-visibility logic (lines 182, 184, 267) no longer keep the marketplace alive in the chat-history panel. Pairs with the sidebar promotion (KK20-124) | `Conversations.test.tsx` | KK20-124 |
| `client/src/components/Conversations/__tests__/Conversations.test.tsx` | `[knauf] should NOT invalidate` | 157–178 | Test adaptation — pins the seam behavior: with `showAgentMarketplace` hard-coded to false, marketplace visibility no longer participates in the favorites cache key, so the cache must NOT be invalidated when the underlying hook value flips (KK20-124) | Self | KK20-124 |
| `client/src/common/agents-types.ts` | `AgentForm.spec` | 53–55 | Form-level spec field so setValue('spec', …) is typed. Mirrors Conversation.spec. BUG-01. | Self (TS compile) | KK20-120 |
| `client/src/components/SidePanel/Agents/AgentSelect.tsx` | `resetAgentForm` | 87–89 | Hydrate persisted spec on agent reload — the per-field loop below skips keys not in defaultAgentFormValues. Without this the pill falls back to derive-from-model. BUG-01. | Manual (pill round-trips on agent switch) | KK20-120 |
| `packages/api/src/agents/validation.ts` | `agentBaseSchema.spec` | 99–101 | Accept spec through agent create/update payloads. UI round-trip only — not consumed by chat completion. BUG-01. | Self (Zod) | KK20-120 |
| `packages/data-provider/src/types/assistants.ts` | `Agent.spec`, `AgentCreateParams.spec`, `AgentUpdateParams.spec` | 275–277, 303–305, 330–332 | Persist chosen modelSpec name on the agent (mirrors Conversation.spec). UI round-trip only — not consumed by chat completion. BUG-01. | Self (TS compile) | KK20-120 |
| `packages/data-schemas/src/schema/agent.ts` | `agentSchema.spec` | 119–124 | Persist chosen modelSpec name on the agent (mirrors Conversation.spec at packages/data-schemas/src/schema/defaults.ts). UI round-trip only — not consumed by chat completion. Lays groundwork for FEAT-04 / FEAT-05. BUG-01. | Self (schema integrity) | KK20-120 |
| `packages/data-schemas/src/types/agent.ts` | `IAgent.spec` | 45–47 | Companion TS type for the spec schema field — see schema/agent.ts. BUG-01. | Self (TS compile) | KK20-120 |
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig` (to `AgentConfigSwitch`) | 32–36 | Re-target the V6 builder body to `AgentConfigSwitch`, the Knauf router that picks between upstream `AgentConfig` (admin detailed) and `KnaufAgentConfig` (everyone else, and admins toggled to simplified). Layers on top of the KK20-120 row for the same file (different anchor) — append-only per the convention | Manual (builder renders correctly per role), `AgentPanel.test.tsx` | KK20-125 |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `knauf-admin-builder-mode-switch` + role-aware extension of `KNAUF_HIDE_*` flags | 21–30, 49–56, 99–134, 135–137, 179–183 | Extends the existing hide flags to be role+mode-aware (admins in detailed mode see Advanced + Duplicate); adds the admin-only view toggle button at the top of the footer (above Version) as a full-width `Button` styled like Version / Admin Settings. Icon + label are action-oriented (LayoutDashboard + "Detailed view" while simplified is active; `List` + "Simplified view" while detailed); `aria-pressed` carries current state | `AgentFooter.spec.tsx` | KK20-125 |
| `client/src/components/SidePanel/Agents/AgentConfig.tsx` | `Support Contact (Optional) section` | 392–497 | Hide the upstream Support Contact section even from admins (the only audience for the detailed builder); wrap in `{false && …}` so the upstream JSX shape stays mergeable | Manual (admin-detailed builder no longer renders the Support Contact fields) | KK20-125 |
| `client/src/components/SidePanel/Agents/__tests__/AgentFooter.spec.tsx` | builder-mode mock + role-aware assertions | 158–178, 180–197, 300–305, 312–319, 469–496, 524–550, 570–653 | Extends the existing KK20-* spec to mock Recoil `useRecoilState` + the Knauf builder-mode atom + the upstream `Button` primitive used by the toggle; pins runtime gate behavior across admin-simplified / admin-detailed / non-admin paths and exercises the toggle click | Self | KK20-125 |
| `client/src/components/SidePanel/Agents/AgentPanel.test.tsx` | `AgentConfigSwitch` mock | 149–163 | Adds a mock for the new `AgentConfigSwitch` router alongside the existing `KnaufAgentConfig` mock — needed to cut the deeper import chain pulled in by the router | Self | KK20-125 |
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
| File | Upstream Imports | Coupling Risk | Tests | Ticket |
|---|---|---|---|---|
| `api/server/routes/knauf/index.js` | `express` | Low — additive router | — | — |
| `api/server/routes/knauf/autogeneratePrompt.js` | `requireJwtAuth`, `getProviderConfig`, `initializeModel` (`@librechat/agents`) | Low/Medium — upstream middleware + the same single-entry-point `initializeModel` the agent graph uses (provider-agnostic, no provider-specific deps) | `autogeneratePrompt.spec.js` | — |
| `client/src/knauf/components/Agents/KnaufAgentConfig.tsx` | `~/{hooks,components}/*` (12+ upstream imports) | High — builds on upstream form context, hooks, components | Manual | — |
| `client/src/knauf/components/Agents/KnaufFileSearch.tsx` | `~/{hooks,components}/*` | Medium — fork of upstream `FileSearch`, drops checkbox | Manual | — |
| `client/src/knauf/components/Agents/*.tsx` | Various upstream hooks/components | Low-Medium — UI-only, no upstream file modifications | `agents-types.spec.ts`, `usePersonalities.spec.ts` | — |
| `client/src/knauf/data-provider/*.ts` | `librechat-data-provider` types | Low — pure data layer, no upstream modifications | `usePersonalities.spec.ts` | — |
| `client/src/knauf/common/*.ts` | `librechat-data-provider` types | Low — shared constants and types | `agents-types.spec.ts` | — |
| `client/src/knauf/hooks/Nav/useUnifiedSidebarLinks.knauf.spec.tsx` | `~/hooks/Nav/useUnifiedSidebarLinks` (subject under test); all transitive upstream deps mocked | Low — test-only; mocks every upstream dependency so it pins the seam without bleeding into upstream contracts | Self | KK20-124 |
| `client/src/knauf/store/builderMode.ts` | `~/store/utils` (`atomWithLocalStorage` helper) | Low — pure Recoil atom with localStorage persistence; no upstream contract surface | `builderMode.spec.ts` | KK20-125 |
| `client/src/knauf/store/builderMode.spec.ts` | Subject only (`./builderMode`) | Low — smoke test pinning the localStorage key + atom default | Self | KK20-125 |
| `client/src/knauf/components/Agents/AgentConfigSwitch.tsx` | `recoil`, `librechat-data-provider` (`SystemRoles`), `~/components/SidePanel/Agents/AgentConfig` (upstream builder), `~/hooks/AuthContext`, `./KnaufAgentConfig`, `~/knauf/store/builderMode` | Medium — renders upstream `AgentConfig` directly; an upstream rename or default-export change would surface here as a wrapper-side import error | `AgentConfigSwitch.knauf.spec.tsx` | KK20-125 |
| `client/src/knauf/components/Agents/AgentConfigSwitch.knauf.spec.tsx` | Subject under test + mocks for upstream auth/Recoil/AgentConfig | Low — test-only | Self | KK20-125 |
<!-- seams:new:end -->

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

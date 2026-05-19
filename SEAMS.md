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
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig`, `composeAgentUpdatePayload` | 32–34, 81–83, 109–111 | Import swap — replaces upstream `AgentConfig` with `KnaufAgentConfig`; forwards `spec` field through PATCH/POST agent payloads (BUG-01) | Manual (builder renders correctly), `AgentPanel.test.tsx` |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `KNAUF_HIDE_ADVANCED`, `KNAUF_HIDE_DUPLICATE` | 22–29, 89–93, 135–139 | Inline gate — hides Advanced panel button and Duplicate agent button for simplified builder | `AgentFooter.spec.tsx` |
| `client/src/components/SidePanel/Agents/__tests__/AgentFooter.spec.tsx` | `[knauf]` assertions | 269–276, 426–453, 481–507 | Test adaptation — expects Advanced/Duplicate buttons to be absent (matches seam behavior) | Self |
| `client/src/components/SidePanel/Agents/AgentPanel.test.tsx` | `KnaufAgentConfig` mock | 149–156 | Test adaptation — mocks KnaufAgentConfig to cut deep import chain that breaks IconContext | Self |
| `Dockerfile` | `COPY librechat.yaml` | 31–33 | Embeds librechat.yaml at build time — Knauf config, not shipped by upstream | Manual |
| `api/test/__mocks__/logger.js` | `mockFormatFunction` | 2–5 | Return a factory `(fn) => () => ({ transform: fn })` so `winston.format(fn)()` matches the shape `@librechat/data-schemas/dist/config/winston.cjs` expects; the upstream `(fn) => fn` mock causes `info.level` undefined throws when the data-schemas dist code calls `parsers.redactFormat()` at module-load | `api/config/__tests__/parsers.spec.js` |
| `packages/api/src/agents/__tests__/memory.test.ts` | `jest.mock('winston', ...)` | 15–38 | Replace plain-object `format` with a callable factory + full method surface (printf, timestamp, errors, splat, json, addColors, transports.DailyRotateFile) so `@librechat/data-schemas` dist loads at module-init when this spec pulls in `~/agents/memory` | Self |
| `packages/api/src/agents/__tests__/run-summarization.test.ts` | `jest.mock('winston', ...)` | 14–37 | Same mock-shape fix as memory.test.ts — `winston.format` callable, full method surface — so data-schemas dist loads via `~/agents/run` import | Self |
| `packages/api/src/agents/__tests__/initialize.test.ts` | `jest.mock('winston', ...)` | 16–39 | Same mock-shape fix as memory.test.ts — data-schemas dist is pulled in via `src/utils/axios` and needs the full callable-format surface | Self |
| `client/src/common/agents-types.ts` | `AgentForm.spec` | 53–55 | Form-level spec field so setValue('spec', …) is typed. Mirrors Conversation.spec. BUG-01. | Self (TS compile) |
| `client/src/components/SidePanel/Agents/AgentSelect.tsx` | `resetAgentForm` | 87–89 | Hydrate persisted spec on agent reload — the per-field loop below skips keys not in defaultAgentFormValues. Without this the pill falls back to derive-from-model. BUG-01. | Manual (pill round-trips on agent switch) |
| `packages/api/src/agents/validation.ts` | `agentBaseSchema.spec` | 99–101 | Accept spec through agent create/update payloads. UI round-trip only — not consumed by chat completion. BUG-01. | Self (Zod) |
| `packages/data-provider/src/types/assistants.ts` | `Agent.spec`, `AgentCreateParams.spec`, `AgentUpdateParams.spec` | 275–277, 303–305, 330–332 | Persist chosen modelSpec name on the agent (mirrors Conversation.spec). UI round-trip only — not consumed by chat completion. BUG-01. | Self (TS compile) |
| `packages/data-schemas/src/schema/agent.ts` | `agentSchema.spec` | 119–124 | Persist chosen modelSpec name on the agent (mirrors Conversation.spec at packages/data-schemas/src/schema/defaults.ts). UI round-trip only — not consumed by chat completion. Lays groundwork for FEAT-04 / FEAT-05. BUG-01. | Self (schema integrity) |
| `packages/data-schemas/src/types/agent.ts` | `IAgent.spec` | 45–47 | Companion TS type for the spec schema field — see schema/agent.ts. BUG-01. | Self (TS compile) |
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
<!-- seams:new:end -->

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

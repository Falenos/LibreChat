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
<!-- seams:auto:end -->

## Configuration

| File             | Purpose |
|------------------|---|
| `librechat.yaml` | Interface toggles, agent config, model specs, welcome text |
| `.env`           | Azure OpenAI keys, MongoDB URI, RAG API URL, MeiliSearch config |
| `Dockerfile`     | `# [knauf] Keep workspace runtime deps...` | 
| `package.json`   | `"mongodb": "^6.14.2"` | add it to peerDependencies |

## Net-New Files

| File | Upstream Imports | Coupling Risk | Tests |
|---|---|---|---|
| `api/server/routes/knauf/index.js` | `express` | Low — additive router | — |
| `api/server/routes/knauf/autogeneratePrompt.js` | `requireJwtAuth`, `getProviderConfig`, `initializeModel` (`@librechat/agents`) | Low/Medium — upstream middleware + the same single-entry-point `initializeModel` the agent graph uses (provider-agnostic, no provider-specific deps) | `autogeneratePrompt.spec.js` |
| `client/src/knauf/components/Agents/KnaufAgentConfig.tsx` | `~/{hooks,components}/*` (12+ upstream imports) | High — builds on upstream form context, hooks, components | Manual |
| `client/src/knauf/components/Agents/KnaufFileSearch.tsx` | `~/{hooks,components}/*` | Medium — fork of upstream `FileSearch`, drops checkbox | Manual |
| `client/src/knauf/components/Agents/*.tsx` | Various upstream hooks/components | Low-Medium — UI-only, no upstream file modifications | `agents-types.spec.ts`, `usePersonalities.spec.ts` |
| `client/src/knauf/data-provider/*.ts` | `librechat-data-provider` types | Low — pure data layer, no upstream modifications | `usePersonalities.spec.ts` |
| `client/src/knauf/common/*.ts` | `librechat-data-provider` types | Low — shared constants and types | `agents-types.spec.ts` |

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

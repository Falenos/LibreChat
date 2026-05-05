# SEAMS.md — Knauf Upstream Modifications

## Upstream Base

| Field | Value |
|---|---|
| LibreChat version | `v0.8.5-rc1` |
| Base tag | `knauf/base-v0.8.5-rc1` |
| Last synced | 2026-05-04 |

## Inline Modifications

| File | Symbol/Anchor | Lines | Purpose | Tests |
|---|---|---|---|---|
| `api/server/index.js` | `app.use('/api/knauf', ...)` | 189–191 | Mount-point — Knauf-only Express router under `/api/knauf` | `api/server/routes/knauf/autogeneratePrompt.spec.js` |
| `client/src/components/SidePanel/Agents/AgentPanel.tsx` | `import AgentConfig` | 32–34 | Import swap — replaces upstream `AgentConfig` with `KnaufAgentConfig` | Manual (builder renders correctly) |
| `client/src/components/SidePanel/Agents/AgentFooter.tsx` | `KNAUF_HIDE_ADVANCED`, `KNAUF_HIDE_DUPLICATE` | 22–29, 89–93, 135–139 | Inline gate — hides Advanced panel button and Duplicate agent button for simplified builder | Manual (buttons hidden in builder footer) |

## Configuration

| File | Purpose |
|---|---|
| `librechat.yaml` | Interface toggles, agent config, model specs, welcome text |
| `.env` | Azure OpenAI keys, MongoDB URI, RAG API URL, MeiliSearch config |

## Net-New Files

| File | Upstream Imports | Coupling Risk | Tests |
|---|---|---|---|
| `api/server/routes/knauf/index.js` | `express` | Low — additive router | — |
| `api/server/routes/knauf/autogeneratePrompt.js` | `requireJwtAuth`, `getResponseSender` | Medium — uses upstream middleware + Azure OpenAI client | `autogeneratePrompt.spec.js` |
| `client/src/knauf/components/Agents/KnaufAgentConfig.tsx` | `~/{hooks,components}/*` (12+ upstream imports) | High — builds on upstream form context, hooks, components | Manual |
| `client/src/knauf/components/Agents/KnaufFileSearch.tsx` | `~/{hooks,components}/*` | Medium — fork of upstream `FileSearch`, drops checkbox | Manual |
| `client/src/knauf/components/Agents/*.tsx` | Various upstream hooks/components | Low-Medium — UI-only, no upstream file modifications | `agents-types.spec.ts`, `usePersonalities.spec.ts` |
| `client/src/knauf/data-provider/*.ts` | `librechat-data-provider` types | Low — pure data layer, no upstream modifications | `usePersonalities.spec.ts` |
| `client/src/knauf/common/*.ts` | `librechat-data-provider` types | Low — shared constants and types | `agents-types.spec.ts` |

## Static Assets

| File | Purpose | Merge Strategy |
|---|---|---|

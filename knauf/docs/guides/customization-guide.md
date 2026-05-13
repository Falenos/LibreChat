# Making Changes

> **The Core Rule:** Default to the lowest tier that can express the change. Escalate only when the lower tiers genuinely cannot.

---

## Tier Ladder

Walk down to the first "yes". Stop there.

| Tier | Use when... |
|---|---|
| **0 — Config** | `librechat.yaml`, `.env`, or the Admin API can express it |
| **1 — MCP / Action** | It's a new tool, integration, or external capability |
| **2 — Asset Overlay** | It's a logo, favicon, or static branding asset |
| **3 — Knauf Code** | It's entirely new Knauf code with no upstream file changes |
| **4c — Inline Markers** | It needs ≤30 lines of change in 1–3 upstream files |
| **4d — File Override** | Last resort: the entire upstream file must be replaced |

---

## Tiers in Detail

### Tier 0: Configuration

`librechat.yaml`, `.env`, and the Admin API control interface toggles, agent builder capabilities, tool filtering, model selection, theme colors, per-role permissions, welcome text, and SSO.

**Rule:** If the answer is a config value, it belongs here. Don't write code for something `librechat.yaml` can already express.

`librechat.yaml` is 100% Knauf-controlled — upstream doesn't ship one. Don't split it into a base + overlay; that would only add complexity.

---

### Tier 1: Capability Extension

MCP servers (external, any language) and OpenAPI Actions add new tools and integrations without touching source. Declare them in `librechat.yaml` under `mcpServers` or `endpoints.custom`.

**Rule:** If the MCP server code lives inside the monorepo, that code is Tier 3. The YAML declaration that points LibreChat at it is still Tier 1.

---

### Tier 2: Asset Overlay

A `Dockerfile.knauf` that does `FROM` on the built image and `COPY`s in logos, favicons, and `librechat.yaml`. Zero merge surface — fully external.

**Rule:** Branding belongs here, never under `client/src/knauf/theme/`.

---

### Tier 3: Knauf-Owned Code

Net-new Knauf code in dedicated directories. No upstream file changes — zero merge conflicts possible. Connected to upstream via one-line `[knauf]` import seams where needed.

**Use these paths — the seam validator treats everything else as upstream-class:**

```
api/server/routes/knauf/     Express routes
client/src/knauf/            React components, hooks, data-provider
packages/knauf/              Shared workspace (types, schemas, constants)
```

**Rule:** Knauf-only dependencies go in `packages/knauf/package.json`, never in root or workspace `package.json`.

---

### Tier 4c: Inline `[knauf]` Markers

Small, targeted changes in upstream files. Mark every modification and track it in [SEAMS.md](../../SEAMS.md).

**Size rules:**

| Lines changed | Action |
|---|---|
| ≤20 | Inline `[knauf]` marker |
| 20–30 | Judgment call — extract to `knauf/` if logic is self-contained |
| 30+ | Always extract to `knauf/`, leave a 1-line import seam |
| Same pattern in 5+ files | Extract shared logic to `packages/knauf/` |

**Rule:** Each marker is a merge obligation. Keep the total marker count below 20.

---

### Tier 4a / 4b: Infrastructure and Build Transforms

- **4a (proxy):** Nginx/HAProxy intercepts requests — useful for per-user config and CSS supplements. Config is external; assumptions about response shape are not.
- **4b (transforms):** Vite/Babel plugins modify source at build time. More powerful but invisible and fragile. Prefer explicit `[knauf]` markers.

---

### Tier 4d: Full File Override — Last Resort

Module aliasing replaces an entire upstream file. You own every line; every upstream change to the original is silently lost. `cst-karl-webui`'s 86 override files with zero upstream syncs is the cautionary tale. Justify in SEAMS.md before using.

---

## Decision Framework

```
1. Can librechat.yaml / .env / admin API express it?         → Tier 0
2. Can a native extension (MCP, OpenAPI Action) handle it?   → Tier 1
3. Is it a branding or static asset change?                  → Tier 2
4. Is it entirely new Knauf code, no upstream changes?       → Tier 3
5. Must modify upstream behavior?
   a. Can a proxy handle it?                                 → Tier 4a
   b. Can a build-time transform handle it?                  → Tier 4b
   c. Small change in 1-3 upstream files?                    → Tier 4c
      Add [knauf] marker. Update SEAMS.md. Write seam test.
   d. Entire file must be replaced?                          → Tier 4d
      Last resort. Justify in SEAMS.md.
```

---

## Tracking Changes (Tier 4c)

### Marker format

```js
// [knauf] <reason — what this does and why a lower tier cannot express it>
const myChange = ...;
// End [knauf]
```

```tsx
{/* [knauf] <reason> */}
{myChange}
{/* End [knauf] */}
```

- Reason must be non-trivial — `// [knauf] change` is not acceptable
- Every opening `[knauf]` needs a paired `End [knauf]`
- Multiple unrelated changes in the same file → multiple separate blocks

### SEAMS.md entry

Rows live inside the auto-sentinel block. Write them directly — do not use `seams.js write`. Run `seams.js check --all` to validate.

```markdown
<!-- seams:auto:begin -->
| File | Symbol/Anchor | Lines | Purpose | Tests |
|---|---|---|---|---|
| `path/to/upstream/file.tsx` | `FunctionOrVariableAnchor` | 10–15 | One-line purpose | `path/to/spec.tsx` |
<!-- seams:auto:end -->
```

Fill all five columns — never leave `—` placeholders:

| Column | What to put |
|---|---|
| File | Exact path from repo root |
| Symbol/Anchor | Nearest function or variable name to the marker |
| Lines | Confirmed by reading the file |
| Purpose | What the seam does and why it exists |
| Tests | Spec path; `Manual` only if purely visual |

---

## Repository Layout

`✅` exists today · `❌` planned, not yet created

```
agentic-karl/
├── .github/workflows/
│   ├── release_pipeline.yaml        ✅  CD: build → ACR → ArgoCD
│   ├── test_pipeline.yaml           ✅  CI: test (ct-shared-workflows@v2.9.0)
│   ├── upstream-release-watcher.yml ✅  Polls upstream, creates sync issues
│   └── seam-validator.yml           ✅  Validates [knauf] ↔ SEAMS.md
├── api/
│   ├── knauf/                       ✅  Reserved (.gitkeep)
│   └── server/
│       ├── index.js                 ✅  Tier 4c seam — Knauf router mount-point
│       └── routes/knauf/           ✅  Tier 3 — autogeneratePrompt route
├── client/src/
│   ├── components/SidePanel/Agents/ ✅  Tier 4c seams — AgentPanel, AgentFooter
│   └── knauf/                       ✅  Tier 3 — KnaufAgentConfig, KnaufFileSearch, etc.
├── packages/knauf/                  ✅  Workspace stub (src/ not yet created)
├── knauf/scripts/seams.js           ✅  Seam manifest tooling
├── Dockerfile.knauf                 ❌  Tier 2 — branding overlay
├── librechat.yaml                   ✅  Tier 0 — all Knauf config
├── SEAMS.md                         ✅  Manifest — every modification tracked
└── overlay-allowlist.yml            ❌  CI allowlist for overlay paths
```

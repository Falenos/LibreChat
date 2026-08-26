---
name: fork-management
description: Use this skill before ANY change to this repository — whether choosing where a change belongs, creating a seam, tracking a new file, or syncing after an upstream merge. Covers tier selection, agent-native seam authoring, infrastructure file tracking, and anti-patterns. Replaces the old fork-guard, create-seam, and tier-select skills.
---

# Fork Management

This is a thin fork of LibreChat (`danny-avila/LibreChat`). Every modification to an upstream file is a future merge conflict. The goal is always the smallest possible diff.

## Step 0 — Load current seam state

Read `SEAMS.md` before doing anything else — it is the live inventory of every existing seam and shows the exact auto-sentinel format you must follow.

> If you hit a decision the tier table below doesn't resolve, consult `knauf/docs/contributing/code-change-protocol.md` for the full tier rationale and decision framework. Don't read it proactively.

If the change touches React/TypeScript in `client/` or `packages/`, also invoke the [`knauf-coding-style`](../knauf-coding-style/SKILL.md) skill once you've picked the tier — it codifies the i18n flow, list-rendering patterns, useRef-for-unstable-closures pattern, Knauf-namespaced schema additions, and other style rules you'll otherwise re-learn through review.

---

## Phase 1 — Choose the tier

Walk the ladder from the top. Stop at the first "yes".

| Question | If yes → |
|---|---|
| Does `librechat.yaml`, `.env`, or the Admin API express it? | **Tier 0** — edit config only |
| Is it a new tool, integration, or external capability? | **Tier 1** — MCP server or OpenAPI Action |
| Is it a logo, favicon, or static asset? | **Tier 2** — `client/public/` + SEAMS.md Static Assets section |
| Is it entirely new Knauf code (no existing upstream file changes)? | **Tier 3** — `knauf/` directory |
| Must it modify ≤30 lines in 1–3 upstream files? | **Tier 4c** — `[knauf]` inline markers |
| Must it replace an entire upstream file? | **Tier 4d** — last resort, justify in SEAMS.md |

If stuck, check `knauf/docs/contributing/code-change-protocol.md` for the full tier rationale and decision framework.

---

## Phase 2 — Apply the change

### Tier 0 (config)

Edit `librechat.yaml` or `.env`. No SEAMS.md update needed — these files are already tracked in the Configuration section.

### Tier 1 (MCP / Action)

Build or configure the MCP server externally. Declare in `librechat.yaml` under `mcpServers`. No SEAMS.md update needed unless the server code lives inside the monorepo (then it's also Tier 3 — add a Net-New Files row).

### Tier 2 (assets) · Tier 3 (net-new Knauf code) · Tier 4c (inline markers)

Once you've picked the tier, **invoke the `seam-manifest` skill**. It owns the entire SEAMS.md authoring loop:

- the **append-only-per-ticket** convention (each ticket adds its own row(s); prior rows are never edited; a single file can legitimately appear in multiple rows, one per ticket)
- the `scan` / `check` / `diff-check` workflow
- what `seams.js` reports vs what the agent must write
- per-section row format (Inline Modifications, Net-New Files, Configuration, Static Assets) — including the `Ticket` column
- marker syntax and the depth/case/comment-token rules
- seam-test patterns

Quick recap of what tier maps to which SEAMS.md section, so you know what to expect:

| Tier | SEAMS.md section | What you add |
|---|---|---|
| Tier 2 | Static Assets | One free-form row |
| Tier 3 | Net-New Files | One row inside `<!-- seams:new:begin --> / <!-- seams:new:end -->` |
| Tier 4c | Inline Modifications | A `[knauf]` / `End [knauf]` block in source + one row inside `<!-- seams:auto:begin --> / <!-- seams:auto:end -->` |

The hard rule that lives in `seam-manifest` and is repeated here only because it is the most common mistake: **never run `seams.js write`**. The agent authors rows directly with the Edit tool. The tool only validates.

### Tier 4c — adding a field to a persisted upstream entity

When a Tier 4c marker adds a new field to a Mongoose schema (`packages/data-schemas/src/schema/`) or to the TypeScript type that describes a persisted entity (`packages/data-schemas/src/types/`, `packages/data-provider/src/types/`), the field's **name** needs a rule, not just the marker. The `[knauf]` block is on our code; it can't catch a future upstream field landing under the same name on the same entity.

| Case | Name |
|---|---|
| Mirroring an upstream concept onto a new entity (the same field already exists upstream on a sibling entity, e.g. `Agent.spec` mirrors `Conversation.spec`) | **No prefix.** A future upstream merge becomes a no-op rather than a rename. |
| Fork-only field with no upstream analogue (audit IDs, Knauf-specific permission flags, Knauf workflow state) | **`knauf_` prefix required.** Prevents future-upstream collision; visually self-documenting at every call site. |

Out of scope (no prefix): form-only/UI-only TS fields that never persist (`avatar_action`, `avatar_preview`); net-new Knauf entities under `packages/knauf/` (already path-isolated). Zod validators inherit the rule from the type they validate.

When in doubt, prefix — the cost of a `knauf_` prefix is cosmetic; renaming a persisted field post-launch costs a data migration. Full rationale in `knauf/docs/contributing/code-change-protocol.md` (Schema / Type Extensions).

---

## Phase 3 — Infrastructure file tracking

Infrastructure files that are Knauf-controlled (not upstream-vanilla) must be tracked in the **Configuration** section of `SEAMS.md`.

Add a row when:
- A GitHub Actions workflow is added or significantly modified for Knauf purposes (e.g., `upstream-release-watcher.yml`, `seam-validator.yml`)
- `docker-compose.override.yml` gains a Knauf-specific bind mount or service
- `Dockerfile.knauf` is created (Tier 2 branding overlay)
- A new `.env*` variant is added that carries Knauf-specific defaults
- `librechat.yaml` gains a new top-level section that didn't exist in the upstream schema

Format:
```markdown
| `path/to/infra/file` | One-line purpose, what Knauf controls here |
```

Do NOT add rows for:
- Standard upstream workflows (`release_pipeline.yaml`, `test_pipeline.yaml`) unless Knauf added significant Knauf-specific logic to them
- `package-lock.json`, lockfiles, build artifacts
- `.husky/`, `dependabot.yml` (these are meta, not Knauf config)

---

## Runtime limit documentation

If a change introduces or modifies an operational size/count/token limit,
timeout, retry, lease, retention interval, concurrency or queue bound, rate
limit, resource limit, provider quota, or platform ceiling, update
`knauf/docs/reference/runtime-limits.md` in the same change.

Keep source defaults separate from `.env.example`, deployment overrides, and
external platform ceilings. Document cross-layer interactions and non-obvious
zero/disabled semantics. Do not copy mutable live state into the repository;
verify current deployed values in their owning GitOps, Terraform, Azure,
Kubernetes, or ArgoCD source.

---

## Phase 4 — Pre-PR checklist

Run these before opening any PR that touches seams or config:

```bash
node knauf/scripts/seams.js check         # Inline Modifications in sync — must exit 0
node knauf/scripts/seams.js diff-check    # no unregistered upstream edits or new files — must exit 0
npm run test:client                       # or relevant workspace suite
```

Then verify manually:
- [ ] All `[knauf]` markers have a paired `End [knauf]`
- [ ] All new SEAMS.md rows have `Symbol/Anchor`, `Lines`, `Purpose`, `Tests`, and `Ticket` filled (no `—` on new rows, except `Ticket` for pre-convention rows)
- [ ] New rows were **appended** to the table; no prior rows were edited or rewrapped
- [ ] Seam test written and passes
- [ ] Net-New Files section updated if any `knauf/` files were created
- [ ] Configuration section updated if any infrastructure files changed
- [ ] Static Assets section updated if any assets were added

---

## Anti-patterns — flag immediately

| Developer says or does | Correct response |
|---|---|
| Edits an upstream file without `[knauf]` markers | Seam validator will block the PR. Wrap it. |
| Edits `Dockerfile` or `Dockerfile.multi` without `[knauf]` markers | They are `upstream`-class — same rule. Wrap the Knauf-specific lines. |
| Adds dep to `client/package.json` | Goes in `packages/knauf/package.json` only |
| Creates `client/src/components/KnaufThing.tsx` | Wrong path — seam validator treats it as upstream-class. Use `client/src/knauf/components/` |
| "I'll run `seams.js write` to update the manifest" | **Never.** The loop is: scan → agent writes → check. `seams.js write` is a human escape hatch only. |
| "I'll run `seams.js write --yes` to auto-apply" | **Never.** Same as above. The agent writes SEAMS.md entries directly with the Edit tool. |
| Leaves `Symbol/Anchor` or `Tests` as `—` | Fill them before the PR. No placeholder rows. |
| Syncs an ordinary PR branch by merging `origin/main` | Rebase it: `git fetch origin && git rebase origin/main`, then `git push --force-with-lease`. |
| Rebases a LibreChat upstream-version import | Vendor imports are the exception: merge `upstream/<tag>` to preserve ancestry and atomic rollback. |
| Pulls `:latest` images | Pin to versioned tags. The existing `:latest` in docker-compose is a known issue. |
| Splits `librechat.yaml` into base + overlay | It's already 100% Knauf-owned. Don't. |

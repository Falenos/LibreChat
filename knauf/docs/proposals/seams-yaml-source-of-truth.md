# Proposal — Make `seams.yaml` the source-of-truth (H1)

**Status:** Design only. Not approved, not implemented. This document exists so the migration can be scoped and reviewed before a single line of code moves.

**Owner:** TBD — needs sign-off from whoever owns the agent-authoring workflow (see [.claude/skills/seam-manifest/SKILL.md](../../../.claude/skills/seam-manifest/SKILL.md)) and the upstream-sync ritual.

**Effort estimate:** ~1 week of focused work spread across 3 PRs. Single-PR delivery is not advised — the change touches every contributor's mental model.

---

## Why

`SEAMS.md` currently holds structured data inside markdown tables wrapped in HTML-comment sentinels. The tool ([knauf/scripts/seams.js](../../scripts/seams.js)) pays a markdown round-trip tax on every operation: cell escaping, separator detection, column-order coupling, em-dash placeholders, backtick stripping. About 40% of the script (and several of its remaining bug classes — escaped pipes, schema drift, near-miss row formats) exists *only* to ferry data through markdown.

A structured source-of-truth (`seams.yaml` or `seams.json`) would:

1. Eliminate the markdown round-trip and the bug classes that come with it.
2. Make schema enforcement trivial (single JSON-schema or Zod schema).
3. Make the data programmatically queryable for other tools (release notes, upstream-sync reports, telemetry).
4. Let `SEAMS.md` become a derived artifact — pretty, human-readable, generated.

What it does **not** solve:
- The marker scanning (lib/scan.js) still operates on source files; that stays.
- The `[knauf]` marker contract is unchanged.
- CI gates still apply; only what they read changes.

---

## Target shape

```yaml
# seams.yaml — Knauf fork-management manifest
# Generated SEAMS.md is the human-readable rendering of this file.

upstreamBase:
  libreChatTag: v0.8.5
  baseTag: knauf/base-v0.8.5
  lastSynced: 2026-05-07

inlineModifications:
  - file: api/server/index.js
    symbol: "app.use('/api/knauf', ...)"
    lines: [[189, 191]]            # list-of-ranges; supports "a–b, c–d"
    purpose: Mount-point — Knauf-only Express router under /api/knauf
    tests: api/server/routes/knauf/autogeneratePrompt.spec.js

  - file: client/src/components/SidePanel/Agents/AgentFooter.tsx
    symbol: KNAUF_HIDE_ADVANCED, KNAUF_HIDE_DUPLICATE
    lines: [[22, 29], [89, 93], [135, 139]]
    purpose: Inline gate — hides Advanced panel and Duplicate buttons
    tests: AgentFooter.spec.tsx

configuration:
  - file: librechat.yaml
    purpose: Interface toggles, agent config, model specs, welcome text
  # ...

netNewFiles:
  - file: api/server/routes/knauf/index.js
    upstreamImports: [express]
    couplingRisk: low
    couplingNote: additive router
    tests: null

  - file: client/src/knauf/components/Agents/*.tsx   # globs still allowed
    upstreamImports: [~/hooks/*, ~/components/*]
    couplingRisk: low-medium
    couplingNote: UI-only, no upstream file modifications
    tests:
      - agents-types.spec.ts
      - usePersonalities.spec.ts

staticAssets:
  - file: client/public/assets/logo.svg
    purpose: Knauf branding
    overlay: Knauf-only
```

Notes:
- `lines` is structured (list of `[start, end]` pairs) instead of a string `"189–191"`. The em-dash rendering is purely a presentation concern.
- `couplingRisk` is an enum (`low`, `low-medium`, `medium`, `medium-high`, `high`). Free-text nuance moves to `couplingNote`.
- `tests` accepts `null` (was `—`), a single path, or a list. This is more honest than the current placeholder scheme.
- `upstreamImports` is a list, not a comma-joined string.

---

## Schema

A JSON Schema (or Zod schema in `seams.config.js`) validates the file on every read. Strict mode — unknown keys reject, missing required keys reject with the path.

Suggested schema fields per section: see `seams.schema.json` (created as part of Phase 1 below).

---

## Migration phases

### Phase 1 — Mirror, don't replace (1 PR, ~1 day)

Goal: prove the data shape works without changing any developer workflow.

- Add `seams.schema.json` (JSON Schema for the target shape).
- Add `knauf/scripts/seams-migrate.js` — one-shot script that parses the existing `SEAMS.md` tables and emits `seams.yaml`. Run once, commit the result, archive the script.
- Add a CI step that re-derives a *throwaway* `seams.yaml` from `SEAMS.md` and diffs it against the committed one. Both must match. If they ever diverge, the canary fires.
- Authors keep editing `SEAMS.md`. The yaml file is dead weight at this point — it only proves the round-trip is loss-less.

Exit criteria: yaml mirror is identical to derived-from-md for at least one upstream sync cycle.

### Phase 2 — Flip the SoT direction (2 PRs, ~3 days)

Goal: yaml becomes canonical; md becomes generated.

PR 2a — *renderer*:
- Add `knauf/scripts/lib/render-md.js`: pure function `(seamsYaml) → markdownString`.
- Add `seams.js render` subcommand: regenerates `SEAMS.md` from yaml.
- Add a pre-commit hook that runs `seams.js render` and stages the result whenever `seams.yaml` is touched.
- `seams.js check` now also confirms `SEAMS.md` matches `render(seams.yaml)`.

PR 2b — *flip authoring*:
- Update [.claude/skills/seam-manifest/SKILL.md](../../../.claude/skills/seam-manifest/SKILL.md): the agent edits `seams.yaml`, never `SEAMS.md` directly.
- Update CLAUDE.md and the upstream-sync guide.
- Deprecate the sentinel comments in `SEAMS.md` (they're harmless but no longer load-bearing).
- `seams.js write` becomes `seams.js sync` — adds/updates yaml entries from discovered markers, prompts for human-curated columns.

Exit criteria: a full upstream sync cycle (`chore/upstream-vX.Y.Z` integration branch) completes without anyone editing `SEAMS.md` by hand.

### Phase 3 — Drop md parsing (1 PR, ~1 day)

Goal: remove the now-unused markdown parser.

- Delete `lib/manifest.js`'s `parseAutoBlockRows` / `parseNewFileRows` / `splitAutoBlock` / `splitNewBlock`.
- Keep only the renderer.
- Drop the sentinel comments from `SEAMS.md` (cosmetic).
- Drop `seams-migrate.js` (already archived after Phase 1).

Exit criteria: `lib/manifest.js` is now just `lib/render-md.js`. Net: -300 lines.

---

## What breaks (and how we soften it)

| Breakage | Mitigation |
|---|---|
| Every contributor's muscle memory ("edit SEAMS.md") | Phase 2b lands with a loud CHANGELOG entry, a banner in the README, and `seams.js write` failing loudly if you try to edit md by hand (until Phase 3) |
| The agent skill doc | Rewritten as part of PR 2b. The `seam-manifest` SKILL.md becomes simpler — yaml is easier to edit programmatically than markdown tables |
| CI workflow | `seams check` already gates SEAMS.md/yaml consistency once Phase 2 lands. The existing [.github/workflows/seam-validator.yml](../../../.github/workflows/seam-validator.yml) needs one line changed (the file it watches) |
| Upstream-sync ritual ([knauf/docs/guides/upstream-sync.md](../guides/upstream-sync.md)) | Update during PR 2b. The line-number-shift step now edits structured `lines: [[200, 202]]` arrays instead of `200–202` strings — easier for humans, trivial for tools |
| External consumers of SEAMS.md | The md still exists; it's just generated. Read paths don't change |

---

## Why not now

I'm not executing this in the current session because:

1. **Phase 2b changes the agent-authoring contract.** Doing it without a stakeholder review burns trust. The skill doc rewrite needs the person who designed the seam workflow to sign off.
2. **The win is real but not urgent.** The current implementation works; it just costs about 40% extra script complexity. That's not pulling anyone's hair out today.
3. **The risk is concentrated in Phase 2.** A bad render-md.js could silently corrupt SEAMS.md on every commit. That deserves its own PR cycle with its own review.

If/when this is approved:
- Phase 1 is low-risk and could ship in a single PR.
- Phase 2 wants two PRs and a quiet week (no upstream merges in flight).
- Phase 3 is a cleanup PR that can wait indefinitely.

---

## Open questions

1. **YAML or JSON?** YAML is friendlier to humans (comments, multi-line strings). JSON is friendlier to tools and has zero dialect surprises. Given that authors will edit this file directly, I lean YAML — but the schema is identical either way.

2. **Where does `Configuration` belong?** Today's table mixes "files that ARE Knauf-controlled config" (librechat.yaml) with "files where Knauf moved a dep" (packages/api/package.json). The yaml model could separate these into `configuration` (purpose: ownership) and `dependencyOverrides` (purpose: package surgery). Worth doing during the migration.

3. **Should `lines` be 1-indexed or 0-indexed in yaml?** Today it's 1-indexed (display-format). I'd keep 1-indexed — matches every other line-number representation in the codebase and the agent's mental model.

4. **Does `Static Assets` deserve to stay separate from `Net-New Files`?** A logo under `assets/knauf/` is functionally a net-new file. Today it's a separate table for editorial reasons. Could collapse to a single `netNewFiles` with a `type: asset | code | test` field.

These questions should resolve in the PR review for Phase 1, not before.

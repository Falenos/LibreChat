---
name: seam-manifest
description: INVOKE THIS SKILL after you've added or modified a [knauf] seam, added a file under any `knauf/` directory, or edited a root Dockerfile — anything that needs a row in SEAMS.md. Covers the run-the-tool / read-the-source / write-the-row / re-run loop, the strict boundary between what `seams.js` reports and what you must author, and the format of each SEAMS.md section. Do NOT invoke before tier selection — use `fork-management` first; this skill assumes you already know the change is Tier 4c (inline marker), Tier 3 (net-new Knauf file), or Tier 2 (asset).
---

# Seam Manifest

The `[knauf]` seam manifest in `SEAMS.md` is the contract between this fork and upstream LibreChat. This skill manages it.

**Two rules above all others:**

1. **Append-only per ticket.** Each Jira ticket appends its own row(s) for the files it touched. Prior rows are never edited. A single upstream file legitimately appears in multiple rows, one per ticket that introduced seams in it. This is what keeps SEAMS.md merge-conflict-free across concurrent feature branches — combined with `SEAMS.md merge=union` in `.gitattributes`, Git auto-merges concurrent appends without conflict markers.
2. **The agent never runs `seams.js write`.** That subcommand exists as a human escape hatch. The agent's loop is **tool reports → agent reads source → agent appends to SEAMS.md → tool validates**.

---

## What the tool provides vs what you must write

The tool (`node knauf/scripts/seams.js`) is good at mechanical work: finding markers, counting lines, diffing rows, detecting structural errors. It cannot read intent, judge meaning, or invent test paths.

### What `seams.js` reports — trust the tool here

| Subcommand | What you get |
|---|---|
| `scan --diff` | Markers in changed files: file, line range, raw description, plus any unpaired/malformed/nested |
| `scan --diff --json` | Same, machine-readable (use this in scripts) |
| `check` | "in sync" or a unified diff showing rows missing for marker-bearing files / rows whose file lost all its markers. Does NOT auto-update the `Lines` column under append-only — drift after a prettier reformat is accepted |
| `check --json` | `{ inSync, removedRows, unregisteredNewFiles }` |
| `diff-check` | Upstream files modified without a `[knauf]` marker; new `knauf/` files missing from Net-New Files |
| `diff-check --json` | `{ base, untaggedUpstreamFiles, unregisteredNewFiles }` |

### What you must write — the tool cannot help you here

| Cell or artifact | Why it has to be the agent |
|---|---|
| **The marker itself** (`// [knauf] <reason>` in the source file) | Requires understanding why the change wouldn't fit a lower tier |
| **`Symbol/Anchor`** | Requires reading the file and naming the nearest meaningful identifier (function, JSX component, constant) |
| **`Lines`** | Read from the file at commit time — the line range covering the marker(s) for *this row's anchor only*, not every `[knauf]` block in the file. Drift after later prettier reformats is accepted; the tool no longer rewrites this column |
| **`Purpose`** | One-line semantic description of what the seam does and why |
| **`Tests`** | Knowing where this codebase keeps tests and which spec asserts the seam's behavior |
| **`Ticket`** | The Jira ID this change is anchored to — `KK20-XXX`. If the change predates the convention, leave it as `—`; if the change has no Jira ticket, stop and use the `knauf-change-workflow` skill to draft one |
| **The seam test itself** | A behavior anchor that fails when the seam is removed or its upstream dependency renamed |
| **Net-New `Upstream Imports`** | Read the file's import block |
| **Net-New `Coupling Risk`** | Low / Medium / High judgment based on how the file ties into upstream contracts |
| **Configuration `Purpose`** | What Knauf controls in that infrastructure file |

If you find yourself wanting to skip one of these — fill in `—`, leave a TODO, ask the user to do it later — stop. The placeholder is what the manifest is supposed to prevent.

---

## The loop

### 1. Ask the tool what changed

```bash
node knauf/scripts/seams.js scan --diff      # what markers exist on this branch
node knauf/scripts/seams.js diff-check       # what's still missing
```

`scan --diff` lists every paired marker plus warnings: `open-without-close`, `close-without-open`, `nested-open`, `malformed-marker`. Address those before continuing — they mean the source itself is broken.

`diff-check` lists:
- **Untagged upstream files** — modified files in `api/`, `client/`, `packages/{api,client,data-provider,data-schemas}/`, or root `Dockerfile*` that have no `[knauf]` marker. Each one needs either a marker wrap or to be moved under a `knauf/` directory.
- **Unregistered new files** — files added under any `knauf/` path that don't have a row in the Net-New Files block.

### 2. Read source to fill the gaps

For each marker `scan --diff` reported, **read the file at the marker's line range**:

- The nearest function / constant / component name above or around the marker is the `Symbol/Anchor`. Pick what a reader would search for, not the closest token.
- The `Purpose` is one sentence answering "what does this seam do, and why couldn't a lower tier express it?" Don't paraphrase the description that's already in the marker — say something new about the *intent*.
- The `Tests` cell points at a spec that would fail if the seam were removed. If none exists, write one (see "Seam tests" below) before filling this cell.

For each unregistered file, **read its import block**:

- `Upstream Imports` is a compact summary of which upstream paths it pulls from. `~/{hooks,components}/*` is fine; an exhaustive list is not the goal.
- `Coupling Risk` follows three buckets:
  - **Low** — no upstream imports, or imports types only.
  - **Medium** — uses upstream hooks, components, or middleware but doesn't extend their contracts.
  - **High** — builds on upstream form context, deep hook chains, or component internals. First to break on an upstream refactor.

### 3. Append the row directly into SEAMS.md

Open `SEAMS.md` with the Edit tool. Find the right block by its HTML-comment sentinels. **Append** the row at the bottom of the table inside the sentinels — never edit a row another ticket wrote, never replace a row, never rewrap rows. If your ticket touches a file that already has a row, add a *second* row pointing at the same file with the symbol/lines specific to *your* change.

**Inline Modifications** (Tier 4c — upstream file with inline markers):

```markdown
<!-- seams:auto:begin -->
| File | Symbol/Anchor | Lines | Purpose | Tests | Ticket |
|---|---|---|---|---|---|
| `path/to/upstream/file.tsx` | `KNAUF_HIDE_ADVANCED` | 22–29, 89–93 | Inline gate — hides Advanced panel for simplified builder | `AgentFooter.spec.tsx` | KK20-125 |
<!-- seams:auto:end -->
```

**Net-New Files** (Tier 3 — file under any `knauf/` path):

```markdown
<!-- seams:new:begin -->
| File | Upstream Imports | Coupling Risk | Tests | Ticket |
|---|---|---|---|---|
| `client/src/knauf/components/Agents/MyComp.tsx` | `~/{hooks,components}/*` | Medium | `MyComp.spec.tsx` | KK20-125 |
<!-- seams:new:end -->
```

**Configuration** (Knauf-controlled infrastructure file):

```markdown
| `path/to/infra/file` | What Knauf controls in this file |
```

**Static Assets** (Tier 2 — logos, favicons):

```markdown
| `client/public/assets/logo.svg` | Knauf logo | Knauf-only |
```

#### Formatting rules that look minor but break things

- **En-dash, not hyphen** in the `Lines` column: `189–191`, not `189-191`. A hyphen will be picked up by the next person reading the table as drift.
- **Backtick-wrap the File cell** exactly: `` `path/to/file` `` — including for net-new globs like `` `client/src/knauf/components/Agents/*.tsx` ``.
- **No `—` placeholders** on new rows for Symbol/Lines/Purpose/Tests. Every functional column has content the first time the row exists. `Ticket` may be `—` only if the change predates the Jira convention.
- **Six columns** for Inline Modifications, **five** for Net-New Files. The parser throws with a line number if you miscount.
- **Append at the end of the block.** Don't insert your row in the middle; concurrent appends from other branches merge cleanly only when each branch adds to the tail.

### 4. Re-run the tool until it exits 0

```bash
node knauf/scripts/seams.js check        # must exit 0
node knauf/scripts/seams.js diff-check   # must exit 0
```

If `check` exits 1 with a unified diff:
- It's showing what the renderer *would* produce vs what you wrote. The mismatch is structural — either a row references a file that no longer has any `[knauf]` markers, or a file has markers but no row at all. `check` does not flag Lines drift under the append-only convention.
- Fix by either adding the missing row, or — if the marker was intentionally deleted — removing the now-orphaned row.

If `diff-check` exits 1:
- "upstream file has no marker" — you forgot to wrap the edit. Add `[knauf]` / `End [knauf]` around the modified lines, redo from step 1.
- "new knauf-only file not registered" — your row's File pattern doesn't match the path. Globs use `*` (no slashes) or `**` (slashes ok). Exact paths must match exactly.

**Never run `seams.js write` to "fix" failing checks.** It overwrites the rows you just authored with placeholders, and it doesn't understand the per-ticket multi-row structure.

---

## Path classification (what the tool considers each file)

Five classes. Only `upstream` requires a marker.

| Path | Class | Marker required | SEAMS.md section |
|---|---|---|---|
| `api/`, `client/`, `packages/{api,client,data-provider,data-schemas}/` source files | `upstream` | **yes** | Inline Modifications |
| Root `Dockerfile`, `Dockerfile.*` | `upstream` | **yes** | Inline Modifications |
| Anything with `knauf/` in the path (except top-level `knauf/`) | `knauf-only` | no | Net-New Files |
| `librechat.yaml`, `.env*`, `docker-compose.override.yml` | `config` | no | Configuration (if Knauf-controlled) |
| Top-level `knauf/`, `.github/`, `.husky/`, root `*.md`, lockfiles, `package.json`, `turbo.json` | `meta` | no | Not tracked |
| `node_modules/`, `dist/`, `build/`, `.turbo/`, `.git/` | `ignore` | no | Not tracked |

If you're unsure, ask `seams.js` directly: `node knauf/scripts/seams.js diff-check --base=<sha>` will tell you which files it flagged and why.

---

## Writing the marker in source

The marker is what makes the seam discoverable. Five rules:

1. **Use the host language's comment syntax.** `// [knauf]` in JS/TS/TSX, `{/* [knauf] */}` inside JSX expressions, `#` in Dockerfile/YAML, `/* */` in CSS. The tool rejects mismatches (`#` in a .tsx is silently dropped).
2. **Exact case, no whitespace inside brackets.** `[knauf]` only. `[Knauf]`, `[ knauf ]`, `[knauf-test]` are flagged as `malformed-marker`.
3. **Paired open/close.** Every `[knauf]` needs an `End [knauf]` in the same file.
4. **One block per concern.** Multiple unrelated changes to the same file = multiple separate blocks. Don't wrap everything in one big block.
5. **The description on the open line is content.** Write a real reason: `// [knauf] hide Advanced for simplified builder`. Not `// [knauf] change` or `// [knauf]`.

```js
// [knauf] hide Advanced panel button for simplified builder
const KNAUF_HIDE_ADVANCED = true;
// End [knauf]
```

```tsx
{/* [knauf] swap upstream AgentConfig for KnaufAgentConfig */}
import KnaufAgentConfig from '~/knauf/components/Agents/KnaufAgentConfig';
{/* End [knauf] */}
```

---

## Seam tests

The `Tests` cell points at a spec that fails when the seam is removed or its upstream dependency renamed. This is what makes the seam load-bearing instead of decorative.

Patterns by seam type:

- **Hidden element** — `expect(screen.queryByRole(...)).not.toBeInTheDocument()`
- **Import swap** — mock the replaced component, assert the mock was rendered
- **Backend mount-point** — request the route, assert status + shape
- **Config flag** — render the consumer with the flag set, assert the rendered output reflects it

Place the spec alongside the file it tests, or in a companion `<file>.knauf.spec.ts(x)`. `Manual` is only acceptable for purely visual changes (a CSS color, a logo position) — never use it as a TODO.

---

## Failure modes worth memorizing

| Symptom | Cause | Fix |
|---|---|---|
| `check` exits 1 with "removed row" diff | A file your row references no longer has any `[knauf]` markers in source | Restore the marker if the row's seam is still needed, or drop the row if the seam was intentionally removed |
| `check` exits 1 with "new row" diff | An upstream file gained `[knauf]` markers without a corresponding row | Append a row pointing at the file with your ticket in the Ticket column |
| Parser throws "has N cell(s), expected 6/5" | You appended a row but miscounted columns | Inline Modifications = 6 columns (File / Symbol/Anchor / Lines / Purpose / Tests / Ticket); Net-New Files = 5 columns (File / Upstream Imports / Coupling Risk / Tests / Ticket) |
| `diff-check` says file is unregistered after I added the row | Glob pattern doesn't match (`*` doesn't cross `/`), or wrong path | Read the path the tool printed verbatim; if you want to match across directories use `**` |
| `scan --diff` reports `malformed-marker` | Wrong case or whitespace in brackets | Lowercase, no spaces: `[knauf]` |
| `scan --diff` reports `nested-open` | A `[knauf]` was opened before the previous one closed | Add the missing `End [knauf]`, or refactor to a single block |
| `scan --diff` reports `open-without-close` for a marker that has its close | Wrong comment syntax for the file type (e.g. `//` in a Dockerfile) | Use the host language's comment style; see "Writing the marker in source" |
| My row collided with another branch's edit during merge | Someone (you or them) edited an existing row instead of appending a new one | Resolve by keeping both rows (one per ticket). The `merge=union` driver in `.gitattributes` only saves you when both sides *append* — rewrites still surface as conflicts |

---

## Pre-PR check

```bash
node knauf/scripts/seams.js check         # exit 0
node knauf/scripts/seams.js diff-check    # exit 0
npm run test:seams                        # 68/68 pass
```

If any of these fail, do not push. Fix the row, fix the marker, or fix the test — never silence the tool.

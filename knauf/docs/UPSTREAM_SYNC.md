# UPSTREAM_SYNC.md — Merging LibreChat upstream into Knauf

This is the live ritual for picking up an `upstream-sync` issue (opened weekday mornings by [`upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml)) and landing the corresponding LibreChat release into `Knauf-Group/agentic-karl-v2`.

If you are reading this for the first time, run **One-time local setup** before anything else.

---

## How upstream sync works in this repo

`Knauf-Group/agentic-karl-v2` has native shared ancestry with `danny-avila/LibreChat` anchored at `v0.8.5`. `git merge upstream/<tag>` produces normal 3-way merges with no special setup — no replace refs, no preflight to fetch a graft, no `--allow-unrelated-histories`. See [`MIGRATION.md`](MIGRATION.md) for the one-time event that established this state.

Upstream `v*` tags are fetched into the `upstream/v*` namespace so they don't collide with Knauf's own `v*` release tags. Baseline anchors (the Knauf-side merge commits that integrated each upstream release) are tagged `knauf/base-vX.Y.Z`. This convention is enforced by the watcher and the per-merge ritual below.

---

## One-time local setup

Only the developer picking up an `upstream-sync` issue needs the `upstream` remote configured. Add it with a non-colliding tag refspec so upstream tags will live under `refs/tags/upstream/v*` instead of competing with Knauf's own `v*` release tags:

```bash
git remote add upstream https://github.com/danny-avila/LibreChat.git
git config --add remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
git config --replace-all remote.upstream.tagOpt --no-tags
git fetch upstream

# Optional but recommended: block accidental pushes to upstream
git remote set-url --push upstream DISABLE
```

Confirm it's in place:

```bash
git remote -v        # origin + upstream listed
```

Normal feature work (branching from `main`, merging back via PR) is **not** affected by upstream remote configuration. The upstream remote only matters when you reach across the boundary — running an upstream-sync workflow or picking up an `upstream-sync` issue.

---

## Branching strategy for an upstream sync

Feature-branch-from-main does not fit upstream merges: even a single upstream version can bring thousands of commits, and `main` must stay continuously deployable through the whole sync. The default model is a **single long-running integration branch** scoped to one upstream version:

```
main
 │
 ├── chore/upstream-v0.X.Y      (integration branch — resolve all conflicts here)
 │    │
 │    (integration absorbs latest main periodically)
 │
 │    when integration is green + staging-validated: PR to main, --no-ff
```

**Rules:**

1. **One integration branch per upstream version.** Open from `main`. Push immediately so the merge state is visible to collaborators.
2. **Resolve conflicts directly on the integration branch.** At current customization scale (a handful of seam files), this is the simple, fast path. The [seam validator](.github/workflows/seam-validator.yml) and [test pipeline](.github/workflows/test_pipeline.yaml) both fire on PRs targeting `chore/upstream-*`, so commits on the integration branch are still gated when you push them through a PR — but a single PR back to main is usually enough.
3. **Integration absorbs main periodically.** Fetch first, then merge in the remote ref so a stale local main can't trip you up: `git fetch origin && git merge --no-ff origin/main`. Cadence ~weekly, or whenever a feature lands on main that the integration branch needs.
4. **Final merge to main is one PR with `--no-ff`** after staging deploy + sign-off. Tag `knauf/base-<upstream-tag>` on the merge commit.
5. **Don't squash** integration into main — preserve the merge commit topology so a single revert can back out the whole sync, and so `git log --first-parent` keeps a clean view of "when did upstream land in our tree."

### When to escalate to sub-branches

Stack sub-branches off the integration branch only when the merge is large enough that a single PR review is impractical, or when conflicts cluster across genuinely independent areas that can be reviewed in parallel:

```
chore/upstream-v0.X.Y
 ├── chore/upstream-v0.X.Y/agentfooter
 ├── chore/upstream-v0.X.Y/api-routes
 └── chore/upstream-v0.X.Y/test-adaptations
```

Sub-branches PR into the integration branch (not main) and go through the same CI gates. Use this pattern for multi-version catch-up after a long deferral, or when the seam impact analysis flags many independent files. Don't pre-commit to it for a normal sync.

---

## Per-merge ritual

Triggered by a new `upstream-sync` issue (one is opened automatically when [`upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) sees a new stable LibreChat release). The issue body lists which of our [`SEAMS.md`](SEAMS.md) seam files upstream touched in this release **and** the predicted set of conflicting files (seam vs non-seam) — that's where conflicts will land.

### 1. Open the integration branch

```bash
git fetch origin
git fetch upstream
git checkout -b chore/upstream-v0.X.Y origin/main

# Fetch the specific upstream tag into the upstream/ namespace
git fetch upstream "+refs/tags/v0.X.Y:refs/tags/upstream/v0.X.Y"
```

### 2. First merge

```bash
git merge --no-ff upstream/v0.X.Y
```

This is a normal 3-way merge — either clean, or with conflicts at the small set of files predicted by the watcher's "Merge Estimate" section.

Push immediately with conflict markers in tree if needed (`git commit --no-edit` first). Visibility matters more than tidiness at this stage.

### 3. Resolve at the `[knauf]` markers

The issue's "Merge Estimate" section will list each conflict file classified as **seam** (in [`SEAMS.md`](SEAMS.md)) or **non-seam**. Resolve seam conflicts at the `[knauf]` markers using [`SEAMS.md`](SEAMS.md) as the index. Investigate each non-seam conflict before merging — these are coincidental upstream/Knauf overlaps that aren't tracked by the seam manifest.

For larger merges, peel each conflict cluster off into a sub-branch:

```bash
git checkout -b chore/upstream-v0.X.Y/agentfooter chore/upstream-v0.X.Y
# resolve only the AgentFooter conflicts
git add client/src/components/SidePanel/Agents/AgentFooter.tsx
git commit
# open a PR targeting chore/upstream-v0.X.Y, not main
```

### 4. Update SEAMS.md `## Inline Modifications` if seams moved

If upstream renamed or relocated a file containing a `[knauf]` marker, update its path in [`SEAMS.md`](SEAMS.md) `## Inline Modifications` table. The [seam validator](.github/workflows/seam-validator.yml) will block any PR with mismatched paths or markers.

### 5. Bump SEAMS.md `## Upstream Base` (last commit on the integration branch)

The SEAMS.md update **must be the integration branch's final commit**, before the PR to main is opened. This is the safety against the next watcher run diffing against a stale baseline — if the bump lives in a follow-up PR, it is too easy to forget, and the next sync issue will over-report.

Edit the `## Upstream Base` table:

- `LibreChat tag` row → `v0.X.Y` (the upstream tag — read by the watcher to compute the next sync's diff base)
- `Base tag` row → `knauf/base-v0.X.Y` (the Knauf-side anchor)
- `Last synced` row → today's date

```bash
git add SEAMS.md
git commit -m "docs: bump SEAMS.md baseline to v0.X.Y"
git push
```

### 6. Verify before promoting

On the integration branch, all of these must be green before the PR to main:

- `npm run lint`
- `npm run build:packages`
- Test pipeline (`test_pipeline.yaml` on the integration branch PR)
- Seam validator (runs automatically on the integration branch PR)
- Manual smoke tests against the seams listed in [`SEAMS.md`](SEAMS.md)
- Staging deploy + sign-off

### 7. Merge to main and tag

After the PR to main lands (`--no-ff`, no squash):

```bash
git checkout main
git pull --ff-only
# tag the merge commit as the new baseline
git tag knauf/base-v0.X.Y
git push origin knauf/base-v0.X.Y
```

The SEAMS.md bump from step 5 is already on main as part of the merge — no follow-up PR needed.

### 8. Close the issue

Link the merge PR and tag in the `upstream-sync` issue and close it. The watcher uses issue titles to dedupe, so closing is fine — the next release will open a fresh issue.

---

## What to do when things go wrong

**A `[knauf]` marker file was deleted upstream.** The seam doesn't exist anymore. Decide whether the Knauf customization is still needed — if yes, find its new home upstream and move the marker there in [`SEAMS.md`](SEAMS.md); if no, delete the marker entry. Either way, the seam validator will block the PR until SEAMS.md and source agree.

**A non-seam conflict is opaque.** If the watcher reported a non-seam conflict file you don't recognize, run `git log --oneline upstream/<base>..upstream/<tag> -- <file>` to see what upstream changed, and `git log --oneline upstream/<base>..origin/main -- <file>` to see what Knauf changed. The conflict means both sides edited the same lines; the resolution is usually clear once you see both histories.

**You need to abort.** `git merge --abort` returns to pre-merge state with no commits lost. Safe to re-attempt after investigation.

---

## Cross-references

- [`SEAMS.md`](SEAMS.md) — manifest of `[knauf]` markers and net-new files; the watcher reads `LibreChat tag` and `Base tag` from here
- [`MIGRATION.md`](MIGRATION.md) — the one-time event that established native shared ancestry with `danny-avila/LibreChat`
- [`.github/workflows/upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) — the cron job that opens the `upstream-sync` issue and reports predicted conflicts
- [`.github/workflows/seam-validator.yml`](.github/workflows/seam-validator.yml) — the PR gate that enforces SEAMS.md ↔ source consistency (also runs on PRs to `chore/upstream-*`)
- [`CLAUDE.md`](CLAUDE.md) — project guidance, including the customization tier ladder

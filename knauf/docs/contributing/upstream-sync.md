# upstream-sync — Merging LibreChat upstream into Knauf

This is the live ritual for picking up an `upstream-sync` issue (opened weekday mornings by [`upstream-release-watcher.yml`](../../../.github/workflows/upstream-release-watcher.yml)) and landing the corresponding LibreChat release into `Knauf-Group/agentic-karl-v2`.

---

## How upstream sync works in this repo

`Knauf-Group/agentic-karl-v2` has native shared ancestry with `danny-avila/LibreChat` anchored at `v0.8.5`. `git merge upstream/<tag>` produces normal 3-way merges with no special setup — no replace refs, no preflight to fetch a graft, no `--allow-unrelated-histories`. See [`migration.md`](migration.md) for the one-time event that established this state.

Upstream `v*` tags are fetched into the `upstream/v*` namespace so they don't collide with Knauf's own `v*` release tags. Baseline anchors (the Knauf-side merge commits) are tagged `knauf/base-vX.Y.Z`.

---

## One-time local setup

Only the developer picking up an `upstream-sync` issue needs the `upstream` remote configured:

```bash
git remote add upstream https://github.com/danny-avila/LibreChat.git
git config --add remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
git config --replace-all remote.upstream.tagOpt --no-tags
git fetch upstream

# Block accidental pushes to upstream
git remote set-url --push upstream DISABLE
```

---

## Branching strategy

Use a **single long-running integration branch** per upstream version:

```
main
 │
 ├── chore/upstream-v0.X.Y      (resolve all conflicts here)
 │
 │   when green + staging-validated: PR to main, --no-ff
```

Rules:
1. One integration branch per upstream version, opened from `main`
2. Resolve conflicts directly on the integration branch
3. Integration absorbs main periodically: `git fetch origin && git merge --no-ff origin/main`
4. Final merge to main is one PR with `--no-ff`. Tag `knauf/base-<upstream-tag>` on the merge commit.
5. Don't squash — preserve the merge commit so `git revert` can undo the whole sync atomically

Stack sub-branches off the integration branch only when the merge is large enough that a single PR review is impractical.

---

## Per-merge ritual

Triggered by a new `upstream-sync` issue. The issue body lists which [SEAMS.md](../../../SEAMS.md) seam files upstream touched and the predicted conflict set.

### 1. Open the integration branch

```bash
git fetch origin && git fetch upstream
git checkout -b chore/upstream-v0.X.Y origin/main
git fetch upstream "+refs/tags/v0.X.Y:refs/tags/upstream/v0.X.Y"
```

### 2. First merge

```bash
git merge --no-ff upstream/v0.X.Y
```

Push immediately — visibility matters more than tidiness at this stage.

### 3. Resolve at the `[knauf]` markers

The issue's "Merge Estimate" lists conflicts classified as **seam** (in SEAMS.md) or **non-seam**. Resolve seam conflicts at the `[knauf]` markers using SEAMS.md as the index. Investigate non-seam conflicts before merging — these are coincidental overlaps not tracked by the seam manifest.

### 4. Update SEAMS.md if seams moved

If upstream renamed or relocated a file containing a `[knauf]` marker, update its path in the `## Inline Modifications` table.

### 5. Bump SEAMS.md `## Upstream Base` (last commit on integration branch)

This **must be the final commit** before the PR to main is opened.

```bash
# Edit SEAMS.md: LibreChat tag → v0.X.Y, Base tag → knauf/base-v0.X.Y, Last synced → today
git add SEAMS.md
git commit -m "docs: bump SEAMS.md baseline to v0.X.Y"
git push
```

### 6. Verify before promoting

All of these must be green:
- `npm run lint`
- `npm run build:packages`
- Test pipeline (fires on integration branch PR)
- Seam validator (fires on integration branch PR)
- Manual smoke tests against seams in SEAMS.md
- Staging deploy + sign-off

### 7. Merge to main and tag

```bash
git checkout main && git pull --ff-only
git tag knauf/base-v0.X.Y
git push origin knauf/base-v0.X.Y
```

### 8. Close the issue

Link the merge PR and tag. The watcher dedupes by issue title, so closing is correct.

---

## What to do when things go wrong

**A `[knauf]` marker file was deleted upstream.** Decide: if the Knauf customization is still needed, find its new home and move the marker + SEAMS.md entry there; if not, delete the entry. The seam validator blocks the PR until SEAMS.md and source agree.

**A file we deliberately deleted (no `[knauf]` markers — a whole upstream file we removed, e.g. an unused workflow) reappears as a modify/delete conflict.** This means upstream still carries or modified that path. Check the Configuration section of SEAMS.md — a deliberate deletion is documented there with the reason. If the file is still listed as "removed — do not restore," resolve the conflict by keeping it deleted (`git rm <path>`), not by accepting upstream's version. If the original reason no longer holds (e.g. AGK's deployment model changed), that's a judgement call — update the SEAMS.md row either way.

**An opaque non-seam conflict.** Run `git log --oneline upstream/<base>..upstream/<tag> -- <file>` to see what upstream changed, and `git log --oneline upstream/<base>..origin/main -- <file>` to see what Knauf changed.

**You need to abort.** `git merge --abort` returns to pre-merge state. Safe to re-attempt.

---

## Related

- [../upstream-releases/README.md](../upstream-releases/README.md) — per-version notes on what each merged release means for the fork (features, security, seam interactions, config actions); write one when you land a sync
- [code-change-protocol.md](code-change-protocol.md) — marker format + SEAMS.md authoring
- [testing-and-rollback.md](testing-and-rollback.md) — verification + revert procedure
- [SEAMS.md](../../../SEAMS.md) — manifest of `[knauf]` markers; watcher reads `LibreChat tag` and `Base tag` from here
- [migration.md](migration.md) — the one-time event that established native shared ancestry
- [upstream-release-watcher.yml](../../../.github/workflows/upstream-release-watcher.yml) — cron job that opens the `upstream-sync` issue
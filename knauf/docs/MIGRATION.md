# MIGRATION.md — How `agentic-karl-v2` was created

This is the historical record of the one-time event that created `Knauf-Group/agentic-karl-v2` from the legacy `Knauf-Group/agentic-karl` repo. It is **not** a runbook for any future operation. The forward-looking process for syncing upstream releases lives in [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md).

## Why this migration happened

`Knauf-Group/agentic-karl` (legacy) was created via Knauf's KDP scaffolder (template-copy), not via `git fork` or `git clone`. The result was a fresh git history with **zero shared ancestry** to `danny-avila/LibreChat`. Without intervention, `git merge upstream/<tag>` rejected with `fatal: refusing to merge unrelated histories`, and `--allow-unrelated-histories` produced dozens of `add/add` conflicts on shared files.

The legacy repo worked around this by grafting the Knauf root commit onto upstream `v0.8.5-rc1` via `git replace --graft`, distributing the replace ref through `refs/replace/*` on origin. That worked, but it required every clone (including CI runners) to fetch replace refs explicitly, every workflow that walked across the boundary needed an extra step, and the GitHub UI never rendered the graft. The maintenance cost was permanent and the model was non-obvious to new contributors.

`agentic-karl-v2` replaces that arrangement with **native shared ancestry**: the new repo's `main` is anchored at LibreChat `v0.8.5` (real upstream commit, real parent chain), and the 177 commits of legacy Knauf history were brought in via one bridging merge. From this point forward `git merge upstream/<tag>` is a normal 3-way merge with no replace refs, no preflight, and no special CI step. The graft was used **once** during the bridging merge to compute the merge-base, then dropped.

GitHub's org-level policy blocked `gh repo fork danny-avila/LibreChat` into `Knauf-Group`, so the new repo was created as an **empty repository** and LibreChat history was pushed into it manually. The git substance is identical to a real fork; only the GitHub UI "fork of" badge is missing.

## What was imported

| Source | Result in `agentic-karl-v2` |
|---|---|
| `danny-avila/LibreChat` at tag `v0.8.5` | `main` was reset hard to this tag, then pushed to `origin` |
| `Knauf-Group/agentic-karl` `main` (177 commits) | Merged into `main` via one bridging merge commit |
| Knauf release tag `v0.20.0` (the only **published** release on the legacy repo) and baseline anchors `knauf/base-v0.8.5-rc1` + `knauf/base-v0.8.5` (new) | Pushed at the same names. Older versions `v0.4.0..v0.19.0` existed on the legacy repo as **draft** GitHub releases without underlying git tags; recreated on `agentic-karl-v2` as drafts (preserving the convention) |
| Replace ref `refs/replace/73e058f...` (the legacy graft) | Used **once** during the bridging merge, then dropped |

## Order of operations executed

1. Created `Knauf-Group/agentic-karl-v2` as a new empty private repo (no fork mechanism used).
2. Cloned `danny-avila/LibreChat` locally; renamed `origin` to `upstream`; added the new repo as `origin`.
3. `git reset --hard upstream/v0.8.5` and `git push origin main`. **Targeted the release tag, not `upstream/main`** — `main` contains in-development code (gitnexus PR-indexing tool, $-skill popover, etc.) that should never enter the fork via a fresh-start import.
4. Added `knauf-old` remote pointing at the legacy `Knauf-Group/agentic-karl`.
5. Configured `+refs/replace/*:refs/replace/*` refspec on `knauf-old` and ran `git fetch knauf-old` so the existing graft was visible locally.
6. `git merge --no-ff knauf-old/main` (the bridging merge). Because the graft was active in this clone, the merge had a real merge-base (`v0.8.5-rc1`, commit `4f133f8`) and produced a normal 3-way merge.
7. Resolved conflicts (7 files, all expected for a v0.8.5-rc1 → v0.8.5 + scaffolder-divergence merge):
   - `git rm` on `.github/workflows/gitnexus-deploy.yml` and `gitnexus-index.yml` (LibreChat tooling Knauf doesn't run; Knauf uses `ct-shared-workflows` instead).
   - `.do/gitnexus/Dockerfile` "both added": kept Knauf's KDP scaffolder content; restored the rest of `.do/gitnexus/` from `knauf-old/main`.
   - `package.json`, `api/package.json`, `packages/api/package.json`: kept Knauf's `version` fields (`0.20.0`, `v0.8.5-rc1`, Knauf's value) and merged dependency lists.
   - `package-lock.json`: regenerated via `npm install`.
8. Verified shared ancestry now exists natively: `git --no-replace-objects merge-base HEAD upstream/v0.8.5` returned `4f133f8` (the original v0.8.5-rc1 commit).
9. Dropped the local graft (`git replace -d 73e058f8c798cc8d038856cb80ba7364597f221d`) and removed the replace-ref refspec from `knauf-old`.
10. Migrated tags and releases — full runbook in [Tag and release migration runbook](#tag-and-release-migration-runbook) below. Summary: pushed `knauf/base-v0.8.5-rc1` (legacy baseline) and a new `knauf/base-v0.8.5` (the bridging merge commit) as baseline anchors; pushed `v0.20.0` as a real annotated tag at the original Knauf SHA `53877fc...` because that release was published on the legacy repo; recreated all earlier `v0.4.0..v0.19.0` as **draft** releases without underlying git tags, mirroring the legacy convention where the release pipeline produces drafts and only manually-promoted releases get tagged.
11. Pushed in-flight feature branches selectively (skipped dependabot/* and stale branches).
12. Repointed external integrations (ArgoCD configs in `Knauf-Group/ct-shared-deployment-configs`, Dependabot, README badge, watcher workflow).
13. Archived `Knauf-Group/agentic-karl` (legacy) with a README banner pointing at `agentic-karl-v2`.

## Tag and release migration runbook

This is the detail behind step 10. Replicate it if a similar migration ever happens again. The convention to preserve:

- **`knauf/base-v*` tags** are real annotated git tags pushed to origin. They mark the Knauf-side merge commits that integrated each upstream LibreChat release, and are read by [`upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) (`git describe --match "knauf/base-*"`).
- **Plain `v*` release tags** only exist on origin for releases that were **published** (not drafts). The release pipeline ([release_pipeline.yaml](.github/workflows/release_pipeline.yaml), delegating to `Knauf-Group/ct-shared-workflows/.github/workflows/release-nextjs.yaml@v2.9.0`) creates a draft per merge to main; only when manually promoted does the draft become a real release with a tag. So at any given moment the Tags page on origin should show: the two `knauf/base-*` anchors plus the most recent **published** `v*`. All earlier `v*` numbers exist as draft releases on the Releases page only.
- **GitHub `published_at` dates are immutable.** Recreated releases on the new repo will show the migration date, not the original publish date. The workaround is to append the original date to each release's body so the audit trail survives.

### Commands executed (idempotent, safe to re-run)

#### A. Baseline anchors (run from `agentic-karl-v2`)

```bash
# Pull the legacy baseline anchor from the old repo
git fetch knauf-old '+refs/tags/knauf/base-v0.8.5-rc1:refs/tags/knauf/base-v0.8.5-rc1'
git push origin 'refs/tags/knauf/base-v0.8.5-rc1'

# Create the new baseline anchor on the bridging merge commit (HEAD of main right after step 6)
git tag knauf/base-v0.8.5
git push origin knauf/base-v0.8.5
```

#### B. The published release `v0.20.0` (run from `agentic-karl-v2`)

```bash
# Resolve the original Knauf commit SHA from a local clone of the legacy repo
sha=$(git -C ~/repos/knauf/agentic-karl rev-parse 'v0.20.0^{}' \
      || git -C ~/repos/knauf/agentic-karl rev-parse v0.20.0)
# Expect: 53877fc3efb8f0342c2b7c9dc154ec6f4a3991f3

# Recreate the annotated tag at that SHA on v2
git tag -a v0.20.0 "$sha" -m "0.20.0"
git push origin v0.20.0

# Pull the original release metadata
meta=$(gh release view v0.20.0 -R Knauf-Group/agentic-karl \
       --json name,body,isPrerelease,publishedAt)
name=$(echo "$meta" | jq -r .name)
body=$(echo "$meta" | jq -r .body)
orig_date=$(echo "$meta" | jq -r .publishedAt)

# Append the historical date footer
new_body=$(printf '%s\n\n---\n*Originally published %s in [Knauf-Group/agentic-karl](https://github.com/Knauf-Group/agentic-karl/releases/tag/v0.20.0).*\n' \
  "$body" "$orig_date")

# Create the published release on v2, marked as Latest
gh release create v0.20.0 \
  -R Knauf-Group/agentic-karl-v2 \
  --title "$name" \
  --notes "$new_body" \
  --target "$sha" \
  --latest
```

#### C. Draft releases for `v0.4.0..v0.19.0` (one loop, idempotent)

```bash
gh release list -R Knauf-Group/agentic-karl --limit 100 \
  --json tagName | jq -r '.[].tagName' | while read -r tag; do

  # Skip if already on v2
  if gh release view "$tag" -R Knauf-Group/agentic-karl-v2 >/dev/null 2>&1; then
    continue
  fi

  meta=$(gh release view "$tag" -R Knauf-Group/agentic-karl \
    --json name,body,isDraft,isPrerelease,publishedAt,targetCommitish)
  name=$(echo "$meta" | jq -r .name)
  body=$(echo "$meta" | jq -r .body)
  draft=$(echo "$meta" | jq -r .isDraft)
  pre=$(echo "$meta" | jq -r .isPrerelease)
  target=$(echo "$meta" | jq -r .targetCommitish)
  orig_date=$(echo "$meta" | jq -r .publishedAt)

  # Drafts only — published releases were handled in section B
  [ "$draft" = "true" ] || continue

  new_body=$(printf '%s\n\n---\n*Originally published %s in [Knauf-Group/agentic-karl](https://github.com/Knauf-Group/agentic-karl/releases/tag/%s).*\n' \
    "$body" "$orig_date" "$tag")

  flags=("--draft" "--target" "$target")
  [ "$pre" = "true" ] && flags+=("--prerelease")

  gh release create "$tag" \
    -R Knauf-Group/agentic-karl-v2 \
    --title "$name" \
    --notes "$new_body" \
    "${flags[@]}"
done
```

### Verification after migration

```bash
# Tags on origin: exactly 3 (or 4 if both knauf/base-v0.8.5 and -rc1 are kept)
git ls-remote --tags origin | grep -v '\^{}$' | sort -k2
# Expect:
#   refs/tags/knauf/base-v0.8.5
#   refs/tags/knauf/base-v0.8.5-rc1
#   refs/tags/v0.20.0

# Release count matches old repo
echo "Old: $(gh release list -R Knauf-Group/agentic-karl --limit 100 | wc -l)"
echo "New: $(gh release list -R Knauf-Group/agentic-karl-v2 --limit 100 | wc -l)"

# v0.20.0 tag points at the original Knauf SHA
git rev-parse 'v0.20.0^{}'
# Expect: 53877fc3efb8f0342c2b7c9dc154ec6f4a3991f3

# v0.20.0 release is published, marked Latest
gh release view v0.20.0 -R Knauf-Group/agentic-karl-v2 --json isDraft,name | jq
# Expect: {"isDraft": false, "name": "v0.20.0"}

# v0.19.0 release is a draft, no real tag
gh release view v0.19.0 -R Knauf-Group/agentic-karl-v2 --json isDraft | jq
# Expect: {"isDraft": true}
git rev-parse v0.19.0 2>/dev/null && echo "ERR: tag exists" || echo "OK: no tag (expected for draft)"
```

### Pitfalls observed during this migration

- **Auto-tag-follow pollution**: the original `git clone https://github.com/danny-avila/LibreChat.git` set `tagOpt=--tags` (default) on the remote. After renaming to `upstream`, every subsequent `git fetch upstream` auto-pulled all upstream tags into the local namespace, **overwriting Knauf's own `v*` tags with upstream's commits** (e.g., `v0.2.0` ended up pointing at upstream's `cf2bab31c` instead of Knauf's `7719055ae`). Fix: `git config remote.upstream.tagOpt --no-tags` and rebuild Knauf tags from a clean source. Do this **before** any other tag work.
- **Missing release tags on legacy GitHub origin**: only `v0.20.0` and `knauf/base-v0.8.5-rc1` were ever pushed to `Knauf-Group/agentic-karl` origin. The other `v0.x.0` tags existed only in local clones. The migration relied on a local clone of the legacy repo as the source of truth for those SHAs.
- **Drafts vs. published releases**: GitHub draft releases reference a tag name without requiring the tag to exist in git. Don't assume "release v0.X.Y exists" implies "tag v0.X.Y exists on origin." Always check `gh release view --json isDraft` before deciding whether to push a tag.

## State after migration (verifiable)

```bash
# Native shared ancestry (no replace refs needed)
git --no-replace-objects merge-base main upstream/v0.8.5
# -> 4f133f8955245845c2b29cb7e84f6d7f41bd5199

# Single root in the commit graph
git --no-replace-objects rev-list --max-parents=0 main | wc -l
# -> 1

# No replace refs in this repo
git replace -l
# (empty)

# Tags on origin: exactly the two baseline anchors plus the latest published release
git ls-remote --tags origin | grep -v '\^{}$' | sort -k2
# -> refs/tags/knauf/base-v0.8.5
# -> refs/tags/knauf/base-v0.8.5-rc1
# -> refs/tags/v0.20.0

# v0.20.0 tag points at the original Knauf SHA (preserved through the bridging merge)
git rev-parse 'v0.20.0^{}'
# -> 53877fc3efb8f0342c2b7c9dc154ec6f4a3991f3

# v0.20.0 release is published; older v0.4..v0.19 are drafts
gh release view v0.20.0 -R Knauf-Group/agentic-karl-v2 --json isDraft
# -> {"isDraft": false}
gh release view v0.19.0 -R Knauf-Group/agentic-karl-v2 --json isDraft
# -> {"isDraft": true}

# Release count matches the legacy repo
diff <(gh release list -R Knauf-Group/agentic-karl    --limit 100 --json tagName | jq -r '.[].tagName' | sort) \
     <(gh release list -R Knauf-Group/agentic-karl-v2 --limit 100 --json tagName | jq -r '.[].tagName' | sort)
# -> (no output = identical)
```

The legacy repo (`Knauf-Group/agentic-karl`) remains archived (not deleted) for at least one release cycle so external pins fail loudly with 404 + redirect rather than silently.

## Rollback

If anything downstream breaks during the cutover window:

```bash
gh repo unarchive Knauf-Group/agentic-karl
# Repoint integrations back to the legacy repo URL
# Leave agentic-karl-v2 private until the next reissue
```

Both repos coexist read-only-on-one-side until the cutover is fully validated. The old repo's history was never modified during this migration; only the legacy `refs/replace/73e058f...` ref remains on its origin (harmless, ignored by anyone who doesn't fetch replace refs).

## Cross-references

- [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) — forward-looking ritual for syncing future LibreChat releases (no longer mentions graft).
- [`SEAMS.md`](SEAMS.md) — manifest of `[knauf]` markers; baseline now anchored at `v0.8.5` / `knauf/base-v0.8.5`.
- [`.github/workflows/upstream-release-watcher.yml`](.github/workflows/upstream-release-watcher.yml) — the cron job that opens an `upstream-sync` issue per upstream release; post-migration version no longer fetches replace refs.

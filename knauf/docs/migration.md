# MIGRATION.md — How `agentic-karl-v2` was created

This is the historical record of the one-time event that created `Knauf-Group/agentic-karl-v2` from the legacy `Knauf-Group/agentic-karl` repo. It is **not** a runbook for any future operation. The forward-looking process for syncing upstream releases lives in [`guides/upstream-sync.md`](guides/upstream-sync.md).

## Why this migration happened

`Knauf-Group/agentic-karl` (legacy) was created via Knauf's KDP scaffolder (template-copy), not via `git fork` or `git clone`. The result was a fresh git history with **zero shared ancestry** to `danny-avila/LibreChat`. Without intervention, `git merge upstream/<tag>` rejected with `fatal: refusing to merge unrelated histories`, and `--allow-unrelated-histories` produced dozens of `add/add` conflicts on shared files.

The legacy repo worked around this by grafting the Knauf root commit onto upstream `v0.8.5-rc1` via `git replace --graft`, distributing the replace ref through `refs/replace/*` on origin. That worked, but it required every clone (including CI runners) to fetch replace refs explicitly, every workflow that walked across the boundary needed an extra step, and the GitHub UI never rendered the graft. The maintenance cost was permanent and the model was non-obvious to new contributors.

`agentic-karl-v2` replaces that arrangement with **native shared ancestry**: the new repo's `main` is anchored at LibreChat `v0.8.5` (real upstream commit, real parent chain), and the 177 commits of legacy Knauf history were brought in via one bridging merge. From this point forward `git merge upstream/<tag>` is a normal 3-way merge with no replace refs, no preflight, and no special CI step. The graft was used **once** during the bridging merge to compute the merge-base, then dropped.

GitHub's org-level policy blocked `gh repo fork danny-avila/LibreChat` into `Knauf-Group`, so the new repo was created as an **empty repository** and LibreChat history was pushed into it manually. The git substance is identical to a real fork; only the GitHub UI "fork of" badge is missing.

## Why we re-forked: the graft alternative

Before creating v2, three options were evaluated:

**Option A — `git graft` / `git replace` on the existing repo**

| | |
|---|---|
| Pro | Preserves every existing commit and hash — nothing is destroyed |
| Pro | Fast to set up |
| Con | Grafts live in `.git/info/grafts` — local-only, not pushed or cloned. Every new developer would see "unrelated histories" again unless they manually replicate the graft. |
| Con | `git replace` adds refs that need `--tags` or explicit pushes to travel; easy to silently omit |
| Con | Neither mechanism changes the actual commit graph — `git bisect`, `git log --ancestry-path`, and CI systems may behave unexpectedly |
| Con | The artificial ancestor point still inherits all structural problems of the old repo (module aliasing, scattered mods, no SEAMS.md) |

**Option B — In-place cleanup on `agentic-karl`**

| | |
|---|---|
| Pro | Retains the full git history as individual commits |
| Con | 127 commits of modifications scattered across core files — untangling them is labor-intensive and error-prone |
| Con | Still requires the graft problem to be solved (see Option A) |
| Con | High risk of missed seams — any modification not found during cleanup becomes an invisible merge obligation |

**Option C — Fresh fork with bridging merge (what we did)**

| | |
|---|---|
| Pro | **Native shared ancestry** — `git merge --no-ff upstream/vX.Y.Z` works correctly, conflicts appearing only at `[knauf]` markers |
| Pro | All git tooling works: `git log --ancestry-path`, `git bisect`, `git revert <merge-commit>` for atomic rollback |
| Pro | No grafts, no `--allow-unrelated-histories`, no surprises for new developers |
| Pro | Clean slate forces an explicit audit of which customizations actually matter |
| Con | **Granular commit history condensed** into a single bridging merge commit |
| Con | All customizations had to be explicitly re-applied |
| Con | Required accepting a non-trivial upstream gap (`v0.8.5` was not the latest at the time) |

Option C accepted a one-time cost in exchange for a permanently maintainable fork. Every customization in v2 is either a config value, a net-new file in a `knauf/` directory, or a tracked `[knauf]` marker.

## What was imported

| Source | Result in `agentic-karl-v2` |
|---|---|
| `danny-avila/LibreChat` at tag `v0.8.5` | `main` was reset hard to this tag, then pushed to `origin` |
| `Knauf-Group/agentic-karl` `main` (177 commits) | Merged into `main` via one bridging merge commit |
| Knauf release tag `v0.20.0` and baseline anchors `knauf/base-v0.8.5-rc1` + `knauf/base-v0.8.5` | Pushed at the same names. Older `v0.4.0..v0.19.0` recreated as drafts. |
| Replace ref `refs/replace/73e058f...` (the legacy graft) | Used **once** during the bridging merge, then dropped |

## Order of operations executed

1. Created `Knauf-Group/agentic-karl-v2` as a new empty private repo (no fork mechanism used).
2. Cloned `danny-avila/LibreChat` locally; renamed `origin` to `upstream`; added the new repo as `origin`.
3. `git reset --hard upstream/v0.8.5` and `git push origin main`.
4. Added `knauf-old` remote pointing at the legacy `Knauf-Group/agentic-karl`.
5. Configured `+refs/replace/*:refs/replace/*` refspec on `knauf-old` and ran `git fetch knauf-old`.
6. `git merge --no-ff knauf-old/main` (the bridging merge). Merge-base: `v0.8.5-rc1` commit `4f133f8`.
7. Resolved 7 conflicts (gitnexus workflows, `.do/gitnexus/Dockerfile`, `package.json` versions, `package-lock.json` regenerated).
8. Verified: `git --no-replace-objects merge-base HEAD upstream/v0.8.5` → `4f133f8`.
9. Dropped the local graft, removed the replace-ref refspec from `knauf-old`.
10. Migrated tags and releases (see runbook below).
11. Pushed in-flight feature branches selectively.
12. Repointed external integrations (ArgoCD, Dependabot, README badge, watcher workflow).
13. Archived `Knauf-Group/agentic-karl` with a README banner.

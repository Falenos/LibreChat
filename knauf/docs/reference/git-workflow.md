# Git Workflow & Automation

---

## Merge Protocol

```bash
# 1. Create integration branch
git checkout main && git checkout -b chore/upstream-v0.X.Y

# 2. Fetch and merge (NEVER rebase)
git fetch upstream --tags
git merge --no-ff upstream/v0.X.Y

# 3. Resolve conflicts
#    - At [knauf] markers → re-apply the marked change in the new context
#    - In knauf/ dirs     → should not happen (Knauf-owned)
#    - In librechat.yaml  → should not happen (Knauf-owned)
#    - Binary assets      → git checkout --ours
#    - Lockfiles          → delete and regenerate: rm package-lock.json && npm install
#    - DELETED/RENAMED seam files → check if feature moved; update SEAMS.md

# 4. Verify SEAMS.md still accurate
node knauf/scripts/seams.js check --all

# 5. Build and test
npm ci && npm run build:packages && npm run frontend && npm run test:coverage

# 6. PR → CI green → staging deploy → sign-off → merge to main
```

**Why merge, not rebase:** Atomic revert via `git revert <merge-commit>`. Conflicts resolved once. `git bisect` distinguishes upstream vs Knauf.

**Lockfile conflicts:** Delete `package-lock.json`, run `npm install` to regenerate.

**Deleted seam files:** If upstream removes a file with a `[knauf]` marker, the seam validator catches it — SEAMS.md entry points to a non-existent file → CI fails.

For the full upstream sync ritual (branching strategy, per-step checklist, tagging), see [upstream-sync.md](upstream-sync.md).

---

## Merge Gate

**No upstream sync PR merges to `main` unless ALL of these are green:**

- [ ] Seam validator passes (`node knauf/scripts/seams.js check --all`)
- [ ] Build succeeds (frontend + backend)
- [ ] All tests pass (`npm run test:coverage`)
- [ ] SEAMS.md updated if any seam paths/symbols changed
- [ ] Staging deployment verified

---

## Best Practices

| Event | SLA | Action |
|---|---|---|
| Upstream minor release (v0.X.0) | 5 business days | Full merge |
| Upstream patch release | 48h triage | Merge if it touches a seam or fixes our bug |
| Critical CVE | 24h | Out-of-band expedited |
| No release for 6 weeks | Calendar fallback | Merge latest to bound drift |

Skipping a release makes the next one cost 2×. Every skipped release increases drift exponentially.

---

## Automation

### Upstream Release Watcher

Detects new LibreChat releases and creates a tracking issue with impact analysis. Implemented in [.github/workflows/upstream-release-watcher.yml](../../.github/workflows/upstream-release-watcher.yml).

**How it works:**
1. Fires on weekdays at 08:00 UTC (and on manual dispatch)
2. Reads `LibreChat tag` from [SEAMS.md](../../SEAMS.md) to get the current baseline
3. Fetches upstream tags into the `upstream/` namespace
4. If new release found: computes seam file impact, detects renames, estimates merge conflicts via `git merge-tree`
5. Creates a GitHub issue with the impact report and merge checklist

### Seam Manifest Validator

Runs on every PR to `main` and `chore/upstream-*`. Implemented in [.github/workflows/seam-validator.yml](../../.github/workflows/seam-validator.yml).

```yaml
- name: Manifest sync check
  run: node knauf/scripts/seams.js check --all

- name: Untagged upstream modifications check
  run: node knauf/scripts/seams.js diff-check --base=${{ github.event.pull_request.base.sha }}
```

Only `upstream`-class files (under `api/`, `client/`, `packages/{api,client,data-provider,data-schemas}/`) require a `[knauf]` marker when modified.

### PR CI Pipeline

Implemented in [.github/workflows/test_pipeline.yaml](../../.github/workflows/test_pipeline.yaml). Delegates to `ct-shared-workflows@v2.9.0`.

Runs: `npm run build:packages && NODE_OPTIONS="--max-old-space-size=6144" npm run test:coverage`

Five test suites: `test:client:coverage`, `test:api`, `test:packages:api`, `test:packages:data-provider`, `test:packages:data-schemas`.

### Automation Summary

| Workflow | Trigger | Purpose |
|---|---|---|
| `release_pipeline.yaml` | PR merge to `main` | Build → push to ACR → ArgoCD deploy |
| `promote_pipeline.yaml` | Manual dispatch | Promote between environments |
| `test_pipeline.yaml` | PR | `test:coverage` via shared workflow (5 suites) |
| `upstream-release-watcher.yml` | Weekday 08:00 / manual | Poll upstream releases, create tracking issues |
| `seam-validator.yml` | PR to `main` | Validate `[knauf]` ↔ SEAMS.md via `seams.js` |
| `combine_prs.yml` | Manual dispatch | Batch Dependabot PRs |
| Dependabot | Weekly | npm / Docker / Actions dependency PRs |

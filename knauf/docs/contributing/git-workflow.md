# Git Workflow & Automation

---

## Merge Protocol

See [upstream-sync.md](upstream-sync.md) for the full ritual (branching strategy, per-step checklist, tagging).

Summary: branch from `main`, run `git merge --no-ff upstream/<tag>` (never rebase), resolve conflicts at `[knauf]` markers using SEAMS.md as the index, validate with `seams.js check`, build + test + staging deploy, then PR to `main` with `--no-ff`.

**Why merge, not rebase:** atomic revert via `git revert <merge-commit>`; conflicts resolved once; `git bisect` distinguishes upstream vs Knauf.

**Lockfile conflicts:** delete `package-lock.json`, run `npm install` to regenerate.

**Deleted seam files:** if upstream removes a file with a `[knauf]` marker, the seam validator catches it — SEAMS.md entry points to a non-existent file → CI fails.

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

Detects new LibreChat releases and creates a tracking issue with impact analysis. Implemented in [.github/workflows/upstream-release-watcher.yml](../../../.github/workflows/upstream-release-watcher.yml).

**How it works:**
1. Fires on weekdays at 08:00 UTC (and on manual dispatch)
2. Reads `LibreChat tag` from [SEAMS.md](../../../SEAMS.md) to get the current baseline
3. Fetches upstream tags into the `upstream/` namespace
4. If new release found: computes seam file impact, detects renames, estimates merge conflicts via `git merge-tree`
5. Creates a GitHub issue with the impact report and merge checklist

### Seam Manifest Validator

Runs on every PR to `main` and `chore/upstream-*`. Implemented in [.github/workflows/seam-validator.yml](../../../.github/workflows/seam-validator.yml).

```yaml
- name: Manifest sync check
  run: node knauf/scripts/seams.js check --all

- name: Untagged upstream modifications check
  run: node knauf/scripts/seams.js diff-check --base=${{ github.event.pull_request.base.sha }}
```

Only `upstream`-class files (under `api/`, `client/`, `packages/{api,client,data-provider,data-schemas}/`) require a `[knauf]` marker when modified.

### PR CI Pipeline

Implemented in [.github/workflows/test_pipeline.yaml](../../../.github/workflows/test_pipeline.yaml). Delegates to `ct-shared-workflows@v2.9.0`.

Runs: `npm run build:packages && NODE_OPTIONS="--max-old-space-size=6144" npm run test:coverage`

Five test suites: `test:client:coverage`, `test:api`, `test:packages:api`, `test:packages:data-provider`, `test:packages:data-schemas`.

### Automation Summary

| Workflow | Trigger | Purpose |
|---|---|---|
| `release_pipeline.yaml` | PR merge to `main` | Build → push to ACR → ArgoCD deploy |
| `deploy_prod_pipeline.yaml` | Manual dispatch | Promote between environments |
| `test_pipeline.yaml` | PR | `test:coverage` via shared workflow (5 suites) |
| `upstream-release-watcher.yml` | Weekday 08:00 / manual | Poll upstream releases, create tracking issues |
| `seam-validator.yml` | PR to `main` | Validate `[knauf]` ↔ SEAMS.md via `seams.js` |
| `combine_prs.yml` | Manual dispatch | Batch Dependabot PRs |
| Dependabot | Weekly | npm / Docker / Actions dependency PRs |

---

## Related

- [upstream-sync.md](upstream-sync.md) — full merge ritual
- [../../README.md](../../README.md) — local development commands

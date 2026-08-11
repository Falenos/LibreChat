# KK20-255 scheduler preview assessment

## Status

This document belongs to the isolated
`experiment/kk20-255-scheduler-14540` branch. It does not modify or supersede
PR #257.

The experiment tests an upstream-first hypothesis:

1. preserve LibreChat Scheduled Chats behavior where practical;
2. measure the actual adaptation and fork-maintenance cost;
3. compare the working behavior with KK20-255 and PR #257;
4. decide case by case where the sources conflict.

Upstream-first is not a preselected production architecture.

## Pinned inputs

| Input                   | Pin                                                                        |
| ----------------------- | -------------------------------------------------------------------------- |
| Agentic Karl base       | `1ae16c74200978546a8dec15b89b084757c957f8` (`origin/main`, tag `v0.213.0`) |
| Recorded LibreChat base | `v0.8.7` / `knauf/base-v0.8.7`                                             |
| LibreChat PR            | `danny-avila/LibreChat#14540`                                              |
| PR branch point         | `4f5c9fec4f7f06ee67f41c57fcf0bf6cfc219fc2`                                 |
| Pinned PR head          | `097e71ed838d9b9253af557877852140428a4091`                                 |
| Reference checkout      | `/Users/ydrargyros/projects/librechat-scheduled-chats`                     |

Pinned source commits, in order:

1. `ee15b0e89178d5c47f1704755da388f610e5dda4` - Scheduled Chats feature
2. `67082b4cf9e8b6420046e6811c7793cdb4a3970b` - terminal persistence deletion fence
3. `777e5da61244e010c37f13f4c51ff2fa5c725d65` - generation-scoped deletion fence
4. `ca7c6375a8a44c0112f8a4a9e0b1d39d0e9b77d3` - lease-token lifecycle fences
5. `6fc28a0747f893015d4ea44502e2dae2268f674a` - heartbeat-backed owner leases
6. `097e71ed838d9b9253af557877852140428a4091` - manager-owned owner-lease span

The reference checkout is not clean:

- `packages/client/src/components/ControlCombobox.tsx` adds one pointer-events
  class;
- `package-lock.json` removes 22 generated lines.

Reference behavior must therefore be reproduced from a clean checkout at the
pinned head before the local image is treated as an upstream oracle.

A clean detached worktree now exists at:

`/Users/ydrargyros/.copilot/session-state/dc315aa6-b879-46c6-8504-b99222852de7/files/scheduler-reference-clean`

It has source tree `ead6ceac74a94ca508cc805af3499002872969d8` and no working-tree
changes. A clean image was built successfully:

| Field          | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| Tag            | `librechat-scheduled-chats:097e71ed-clean`                                |
| Image ID       | `sha256:13c428d37585c39358b08ebc562edda15cf27fbe6b7f2ec7d1fcae3dbfdf4cfe` |
| Node           | `v24.16.0`                                                                |
| `BUILD_COMMIT` | `097e71ed838d9b9253af557877852140428a4091`                                |
| `BUILD_BRANCH` | `pull/14540`                                                              |

The previously running image has ID
`sha256:dde13f8ebff0569597f11b1699d7d5ca697c4f6807a6d99ea6b1b2348e6aab0d`.
It was built from a context that may include the dirty files above and has no
repository digest, so it remains a convenience environment rather than the
clean oracle.

## Measured patch shape

The pinned PR contains:

- 6 commits;
- 155 changed files;
- 53 added files;
- 102 modified files;
- 25,125 additions and 496 deletions.

The upstream diff status is relative to the PR branch point, not to current
Agentic Karl. Of the 102 files marked modified by upstream:

- 85 already exist on current `origin/main`;
- 17 do not exist on current `origin/main` and would arrive as additional
  upstream-path files;
- of the 85 present files, 56 have drifted from the PR branch-point version
  and only 29 still match it.

All 53 files marked added by upstream are absent on current `origin/main`.

The 17 modified-upstream files missing from current main are mostly newer
agent-resume, authentication-cache, stream job-store, and DocumentDB support:

- 5 agent request/resume tests or implementation files;
- 1 JWT strategy test;
- 9 stream/auth cache implementation or test files;
- 1 DocumentDB compatibility test;
- 1 shared cache type.

This distinction matters: the preview is not simply changing 102 files that
the fork already has. It also assumes prerequisite runtime surfaces from the
270-commit upstream development gap.

File distribution:

| Area                      | Added | Modified |
| ------------------------- | ----: | -------: |
| `api/`                    |     6 |       39 |
| `client/`                 |     8 |        3 |
| `config/`                 |     1 |        1 |
| `e2e/`                    |     2 |        2 |
| `packages/api/`           |    28 |       32 |
| `packages/data-provider/` |     1 |        8 |
| `packages/data-schemas/`  |     7 |       15 |
| Root config/lockfile      |     0 |        2 |

The PR branch point is 270 upstream commits ahead of the fork's recorded
LibreChat baseline. Applying only the first feature commit to current
`origin/main` stages 150 files and produces 41 conflicts.

The conflict set is not concentrated in schedule UI code. It includes:

- agent request, resume, abort, and error handling;
- authentication strategies and user-document caching;
- account deletion;
- API startup and agent routes;
- `GenerationJobManager`;
- Redis and in-memory job stores;
- job-store interfaces, metadata, and stream types;
- schedule method/model registration;
- package metadata and lockfile.

## Dependency closure

The added scheduler modules are not a self-contained package.

### Scheduler engine

`packages/api/src/schedules/service.ts` directly depends on:

- data-schema runtime context and tenant storage;
- data-provider permissions and balance configuration;
- app configuration and shutdown state;
- short-lived JWT generation;
- agent checkpoint generation and deletion;
- `GenerationJobManager`;
- balance middleware;
- stream job serialization;
- the scheduler engine, firing, capacity, cadence, and erasure modules.

`engine.ts` and `erasure.ts` depend on the shared shutdown coordinator and
system execution context. `fire.ts` depends on the existing agent request
contract and provider model constants.

### Persistence

The new schedule and run schemas require registration in the shared
data-schema model, method, type, and package export surfaces. The 1,725-line
schedule method implementation also depends on user deletion and
DocumentDB-compatible persistence behavior.

### API and runtime

The API integration requires:

- a new `/api/schedules` route;
- permission and role schema changes;
- startup readiness fencing;
- scheduler initialization after the HTTP listener becomes ready;
- application shutdown coordination;
- deletion reconciliation;
- shared Redis-backed generation-job capabilities.

The upstream entrypoint explicitly arms the scheduler in every API replica.
It is not already packaged as a separate worker command.

### Client

The added schedule panel depends on upstream navigation, agent-map context,
permissions, shared data-provider types, API endpoints, React Query keys and
mutations, translations, and common UI components.

Moving these files under `client/src/knauf/` would still require seams in the
upstream navigation and shared package export/configuration surfaces.

## Acquisition options

### Ordered cherry-picks into upstream paths

**Strengths**

- Best source provenance and bisectability.
- Preserves upstream tests and the five safety-fix commits.
- Lowest eventual comparison cost when LibreChat releases the feature.

**Measured problems**

- The first commit has 41 conflicts and 150 staged files.
- The complete patch modifies 85 files that exist on current main and imports
  17 additional prerequisite files that upstream classified as modifications.
- 56 of the 85 existing files have already drifted from the preview's branch
  point.
- Fork policy requires local upstream-file changes to have explicit Knauf
  seams. Exact upstream preview code has no such markers.
- Making the branch reviewable would therefore require either a broad
  validation exemption or a very large number of markers and manifest rows.
  Both conflict with the thin-fork rules and the experiment stop conditions.

**Disposition**

Technically the best way to construct a throwaway upstream-parity candidate,
but not currently an acceptable production branch shape.

### One squashed patch into upstream paths

**Strengths**

- Similar final tree to ordered cherry-picks.
- One import operation.

**Problems**

- Same 102-file fork-hygiene problem and similar conflict resolution.
- Loses separation of the five safety fixes.
- Worse review, bisect, provenance, and retirement behavior.

**Disposition**

Rejected.

### Copy added modules under Knauf paths

**Strengths**

- The 53 newly added files can be path-isolated.
- Knauf-specific notification or policy code would have a natural home.

**Problems**

- The copied scheduler still needs the modified auth, deletion, agent
  lifecycle, job-store, schema registry, route, startup, permission, and
  navigation contracts.
- Package aliases and internal `~/` imports must be rewritten.
- Shared persisted types and model registration cannot be isolated by moving
  files alone.
- Upstream tests would need import rewrites or duplication.
- Retirement becomes a custom migration from a parallel implementation rather
  than removal of a preview patch.

**Disposition**

Copying does not remove the deep integration surface. It is useful only for
genuinely Knauf-owned adapters around a reused core, not for relocating the
whole upstream feature.

### Smaller Knauf-owned scheduled-agent vertical slice

**Strengths**

- Can target KK20-255 rather than the complete Scheduled Chats product.
- Can use Knauf-owned paths for the domain and notification policy.
- Avoids importing unrelated client and generic schedule behavior.

**Risks**

- "Smaller" is unproven until it covers atomic occurrence claims, expiring
  leases, durable run evidence, retries, restart recovery, authorization,
  agent execution reuse, deletion, and notification idempotency.
- Reimplementing those invariants can be riskier than adapting upstream.
- It has the highest chance of becoming permanent fork-owned infrastructure.

**Disposition**

Keep as a bounded comparison design. Do not select it based only on lower
initial line count.

## Acquisition gate

Ordered cherry-picks remain the best mechanism for an upstream-parity
experiment, but the persisted tree shape fails the current fork-hygiene gate:

- at least 85 pre-existing upstream files would need reviewable local seams;
- 70 additional upstream-path files are absent on main: the 53 upstream-added
  files plus 17 prerequisite files modified on the upstream branch;
- adding markers throughout exact preview code destroys useful provenance and
  creates an excessive seam manifest;
- a broad preview exemption is explicitly disallowed.

The next implementation step must therefore be decided before applying the
patch to this branch:

1. approve a strictly throwaway, non-PR parity worktree whose result is used
   only as evidence;
2. define a narrow, policy-compliant preview-import mechanism;
3. skip the full backport and design a hybrid around isolated upstream
   concepts;
4. design the smaller KK20-255 vertical slice and compare its real invariants.

The experiment must not treat the effort already spent on upstream analysis
as a reason to weaken fork policy.

## Feature-dark definition

A candidate is disabled by default only when all of these are true:

- schedule navigation and UI are absent;
- schedule create/update/run API operations are rejected;
- default roles have no schedule permission;
- no scheduler loop polls, claims, or fires work;
- existing chat and agent behavior remains unchanged;
- an isolated dev/nonprod test overlay is required to enable execution.

The presence of a config key named `disabled` is not sufficient evidence.

## Requirements conflicts queued for case-by-case review

| Concern        | Jira                             | PR #257                 | Upstream preview              |
| -------------- | -------------------------------- | ----------------------- | ----------------------------- |
| Runtime        | Separate two-replica worker      | Existing API replicas   | Every API replica             |
| Recipients     | Selected internal recipients     | Owner-only first        | No email recipients           |
| Transport      | SMTP/Mailgun                     | CST notification path   | No email transport            |
| Persistence    | Jira-named schedule/run entities | Upstream entities       | `Schedule` and `ScheduleRun`  |
| Recurrence     | Five-field cron, hourly minimum  | Product guardrails      | Cadence model, minute-capable |
| Agent identity | Exact version                    | Stable execution intent | Must be verified              |

No conflicting behavior should be implemented until its upstream coupling and
current platform capability are evidenced.

## Notification decision

The generated conversation is the scheduled run's primary result. Email,
recipient selection, and notification transport are excluded from the MVP.
This follows the upstream Scheduled Chats interaction model and avoids a second
delivery lifecycle whose retry and deduplication semantics are unrelated to
schedule execution.

The schedule list and run state will expose the resulting conversation and
navigate to it directly. A later notification requirement would be a separate
product extension rather than part of the scheduler's durable execution
contract.

## Interim architecture gate result

The exact upstream backport and the copy-under-`knauf/` acquisition options are
rejected for this baseline. They preserve neither a small dependency closure
nor thin-fork retirement safety:

- an ordered cherry-pick conflicts immediately across 41 files and stages 150
  files in its first commit;
- importing upstream ancestry would add 276 commits and affect 1,620 files;
- the pinned feature modifies 85 files that exist in current Agentic Karl, 56
  of which have independently drifted, and requires 70 files absent here;
- moving scheduler modules under Knauf paths does not remove their dependencies
  on shared auth, generation jobs, streams, schemas, routes, startup, roles, and
  client navigation.

The bounded hybrid is therefore the primary experiment candidate. Its
implemented foundation is Knauf-owned and currently limited to:

- upstream-compatible structured cadence (`hourly`, `daily`, `weekdays`, and
  `weekly`) compiled through Croner with IANA timezone handling, deterministic
  jitter, and missed-occurrence skip-forward;
- unique occurrence claims, expiring execution leases, renewal, fencing, and
  restart recovery in native MongoDB collections;
- durable upstream-compatible run outcomes (`started`, `success`, `error`, and
  `interrupted`);
- a same-image, separate-process worker gated by
  `KNAUF_SCHEDULER_WORKER_ENABLED=true`;
- authenticated internal HTTP execution through the existing
  `/api/agents/chat/agents` route using a short-lived owner token;
- completion/error tracking through the existing resumable SSE stream and
  best-effort generation abort when the execution lease is lost;
- an upstream-compatible `/api/schedules` CRUD contract with strict payload
  validation, authenticated ownership isolation, agent and file access checks,
  idempotent creation, bounded per-user capacity, edit revision fencing, and
  active-run deletion protection, gated by
  `KNAUF_SCHEDULER_API_ENABLED=true`;
- upstream-compatible Run Now behavior that preallocates a conversation ID,
  queues the manual execution for the separate worker, permits explicit runs
  while a schedule is disabled, and returns HTTP 409 when another manual or
  recurring execution is active for the same schedule;
- crash-recoverable schedule-card bookkeeping with per-occurrence idempotency,
  configuration-revision fencing, occurrence-order fencing, success counts,
  consecutive failure counts, and terminal `lastRun` projection.

This HTTP boundary is preferred over importing `AgentController` or
`GenerationJobManager` directly because it retains existing JWT, ban,
permission, agent-access, file-readiness, conversation, tool, persistence, and
abort behavior. The worker requires `KNAUF_SCHEDULER_API_URL`; it does not
initialize inside API replicas.

The foundation has a real MongoDB concurrency contract covering occurrence
uniqueness, expired-lease reclamation, stale-token fencing, heartbeat renewal,
concurrent workers, recovery on both sides of schedule advancement, structured
cadence translation, and timezone-aware next-run calculation. Adapter tests cover preallocated conversation identity, request shape, SSE
completion and errors, and lease-loss abort.

The candidate remains feature-dark by default: the mounted schedule API returns
404 unless explicitly enabled, no schedule UI exists, and the worker exits
unless explicitly enabled. It is not yet an end-to-end MVP.

Known limitations requiring explicit product decisions:

- schedules currently reference the mutable agent ID rather than an immutable
  agent version;
- hard deletion is rejected while an execution lease is active and retains
  historical run evidence, but the eventual upstream migration still needs an
  explicit retention mapping;
- attached-file ownership is validated at configuration time, but renewable
  retention for files referenced by long-lived schedules is not yet implemented;
- there is no Cosmos vCore qualification.

## Immediate next evidence

1. Reproduce the upstream schedule panel, dialog, card actions, status display,
   Run Now flow, and conversation navigation under `client/src/knauf/`, using
   only minimal mount seams.
2. Qualify the MongoDB atomic operations and indexes against Cosmos DB for
   MongoDB vCore in dev/nonprod.
3. Confirm the internal worker-to-API execution route operationally in
   dev/nonprod without exposing secret values.
4. Resolve agent-version semantics before claiming immutable execution intent.
5. Add health/readiness probes, bounded graceful-shutdown behavior, metrics,
   and a deployment overlay only after the execution boundary is proven.
6. Add renewable attachment retention before exposing schedule file selection
   in the UI.

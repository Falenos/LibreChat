# Code adapter placement — in-process router vs Tier-3 sidecar (decision doc)

> **Status: DECIDED (Aug 2026) — Tier-3 sidecar** ([`knauf/code-adapter/`](../../code-adapter/)). Ticket: **KK20-108**.
> Companion to [`code-interpreter-backend-options.md`](code-interpreter-backend-options.md) (which chose ACA dynamic
> sessions over the self-hosted sandbox) and [`code-interpreter-implementation-designs.md`](code-interpreter-implementation-designs.md)
> (which specified the adapter). This doc answers the follow-up challenge raised during implementation review:
> *"the adapter is just communication glue — why deploy a separate service instead of putting that code inside LibreChat?"*

---

## TL;DR

The adapter cannot live in the one place that would make it "not a hop" — LibreChat's code-execution client is
compiled inside a published npm dependency and speaks exactly one protocol to one URL. "In-process" therefore means
LibreChat HTTP-calling **itself** on localhost; the hop, the serialization, and all the adapter logic exist either way.
Given that, the decision reduces to *which process holds the code-execution credential and absorbs the abusive traffic
profile*. The sidecar wins on failure isolation, credential compartmentalization, network exposure, release coupling,
and fork-maintenance cost; the in-process router wins on ops footprint and local-dev convenience. We keep the sidecar.
The decision is cheaply reversible in the sidecar→in-process direction and painfully irreversible the other way.

---

## 1. Constraint zero: the client is immutable

Everything below follows from one verified fact: the code that decides how KARL talks to a code backend is **not ours
to edit**.

- `bash_tool` / `execute_code` live in `@librechat/agents` — a **published npm dependency** (see
  `node_modules/@librechat/agents/dist/cjs/tools/{CodeExecutor,BashExecutor}.cjs`), not vendored source.
- Both tools compute `EXEC_ENDPOINT = ${getCodeBaseURL()}/exec` **at module load** from `LIBRECHAT_CODE_BASEURL`
  and accept no runtime override (unlike `ToolSearch`/PTC, which take `initParams.baseUrl`).
- The fork's own file services ([`api/server/services/Files/Code/crud.js`](../../../api/server/services/Files/Code/crud.js),
  [`process.js`](../../../api/server/services/Files/Code/process.js)) call the same base URL per request.

So the *only* lever we own is the URL. Any translation to the ACA contract happens behind an HTTP endpoint,
wherever that endpoint is hosted:

| Shape | What actually happens |
|---|---|
| **A. In-process router** | `LIBRECHAT_CODE_BASEURL=http://localhost:3080/api/knauf/codeexec/v1` — the app POSTs to **itself**; a router mounted via a `[knauf]` seam in [`api/server/routes/index.js`](../../../api/server/routes/index.js) translates and calls ACA |
| **B. Sidecar (current)** | `LIBRECHAT_CODE_BASEURL=http://agentic-karl-code-adapter…:3112/v1` — a ClusterIP pod translates and calls ACA |

The data path — *app → HTTP → translator → HTTPS → Azure* — is byte-identical. "Putting it inside LibreChat" removes
no communication; it only relocates where the translator listens.

## 2. The adapter is a state machine, not a pipe

The "just glue" framing undercounts what the ACA contract gap requires. Microsoft runs the compute; it does **not**
run the bookkeeping LibreChat's Code API contract assumes:

- **Upload-before-exec:** LibreChat uploads files before any session exists; ACA sessions self-destruct after a
  cooldown (minimum 300 s). The adapter stages uploads in Azure Blob and lazily pushes them into sessions at exec time.
- **Downloads that outlive the sandbox:** output files are captured post-exec into Blob + a Mongo TTL collection
  (`code_adapter_files`, 24 h) so `GET /download` works long after the session is gone.
- **Exit codes and output caps:** ACA's response carries no numeric exit code and truncates stdout (~4000 chars).
  The sentinel wrapper (base64-embedded subprocess + `/mnt/data` log tee) restores real exit codes and recovers full
  output.
- **Session resurrection:** `SessionWithIdentifierNotFound` → transparent re-mint + re-push + re-run.

In the self-hosted design this bookkeeping lived inside the sandbox stack itself — **eight services plus Redis plus
MinIO, all ours to operate**. Choosing ACA collapsed that to *one* stateless service. The fair deployables ledger is
not "sidecar vs nothing"; it is **ClickHouse path ≈ 9 owned deployables vs ACA path = 1**. The sidecar *is* the
"fewer things to deploy" outcome.

## 3. Dimension-by-dimension analysis

### 3.1 Failure isolation and resource profile — sidecar

Code execution is structurally the most abusive workload KARL will host: synchronous requests held up to **220 s**
(the ACA platform cap), file buffers up to **128 MB**, and adversarial inputs *by design* (the feature exists to run
model-generated code). In-process, those buffers and held sockets share heap and event loop with every user's chat
SSE stream — an exec-driven OOM or crash restarts chat for everyone, and every app deploy kills in-flight executions.
As a sidecar, the worst case is "code execution is down"; chat never notices. Two `replicaCount: 2` pods restart in
seconds with no state loss (state is in Blob/Mongo, never in the pod).

### 3.2 Credential boundary — sidecar

Something must hold the Entra identity carrying **"Azure ContainerApps Session Executor"** on the pools. The two
candidate answers are not equivalent:

- **In-process:** the identity is ambient inside the full LibreChat surface — every route, every upstream dependency,
  every future CVE in a 1,500-package tree can reach `DefaultAzureCredential` and execute arbitrary code in the pools.
- **Sidecar:** the identity exists only in a ~2,000-line service exposing eight endpoints behind one JWT verification
  (mirroring [`packages/api/src/auth/codeapi.ts`](../../../packages/api/src/auth/codeapi.ts)); the pod additionally
  holds nothing else of value (no OpenID secrets, no Meilisearch key, no Foundry key — all of which live in the app pod).

This is the answer a security review will ask for. It is the same compartmentalization logic that keeps `rag_api`'s
document-intelligence key out of the app pod today.

### 3.3 Network exposure — sidecar

The app's port 3080 is published through the platform ingress. An in-process `/api/knauf/codeexec/v1/*` router is
therefore **internet-reachable by default** and must be defensively gated forever (JWT verification identical to the
sidecar's, plus care that no upstream middleware ordering change ever exposes it). The sidecar is **ClusterIP-only,
no ingress** — unreachable from outside the namespace by construction, with the namespace's `defaultDenyAll` policy
in front of it. One shape relies on code staying correct; the other on topology.

### 3.4 Workload identity pioneering — sidecar

No AGK application pod uses workload identity today (only External Secrets Operator does). Whichever pod hosts the
translator becomes the **first** — receiving the SA annotation, the `azure.workload.identity/use` pod label, and the
webhook-injected env/volumes. Running that experiment on the crown-jewel app deployment couples an identity-mechanism
rollout to chat availability; running it on a small new pod costs nothing if it misbehaves. (After the adapter proves
the pattern, migrating the app pod's *other* Azure credentials to workload identity becomes a de-risked follow-up.)

### 3.5 Release and rollback coupling — sidecar

Sidecar: adapter fixes ship on their own cadence (`VERSION` bump → `az acr build` → GitOps tag bump), and the
platform-level off-switch is removing one env var. In-process: every adapter change rides a full KARL release
(image rebuild, release pipeline, ArgoCD sync of the main app), and every KARL release interrupts running executions.
During the phase where the ACA data-plane API is still `preview` and may churn, independent shipping cadence matters.

### 3.6 Fork maintenance (the tier ladder) — sidecar

The sidecar touches **zero upstream lines** — pure Tier 3, invisible to upstream syncs. The in-process router needs a
`[knauf]` mount seam in `api/server/routes/index.js` plus a body of Knauf code under `api/`; small and precedented
(artifact export does it), but every seam is merge surface at every upstream sync, and route-registration files are
exactly where upstream churns. The 5-tier strategy exists to prefer the lower tier when both work.

### 3.7 Dependencies — neutral (verified)

Originally assumed to favor the sidecar; verification weakened it: `@azure/identity`, `@azure/storage-blob`, `multer`,
`undici`, and `express` already exist in the monorepo, and JWT verification could use `node:crypto` instead of `jose`.
In-process would add no forbidden root dependencies. Scored neutral.

### 3.8 Ops footprint — in-process

The honest win for in-process: no image, no CI workflow, no GitOps service, no ApplicationSet edits, one fewer thing
on dashboards. Quantified for the sidecar: the CI workflow exists ([`build-code-adapter.yaml`](../../../.github/workflows/build-code-adapter.yaml)),
and the GitOps registration is two small files plus two ApplicationSet lines with merge = deploy — a one-time
afternoon, after which a stateless pod with no schema, no upgrades, and no cross-service migrations sits quietly.
AGK already operates this exact shape three times over (`rag_api`, `meilisearch`, `langfuse-*`) — nobody proposes
folding those into the app process.

### 3.9 Local development — in-process (slightly)

In-process: zero extra processes. Sidecar: one extra command
(`node --env-file=.env dist/index.js`, with `CODE_ADAPTER_LOCAL_MODE=true` removing all auth friction). Minor.

## 4. Summary matrix

| Dimension | A. In-process router | B. Sidecar (current) | Winner |
|---|---|---|---|
| Removes the HTTP hop | No — loopback POST to self | No | tie (myth dispelled) |
| Failure isolation (220 s holds, 128 MB buffers, OOM) | Shares the chat process | Fully isolated | **B** |
| Code-exec credential exposure | Ambient in the whole app | 8-endpoint pod, nothing else co-located | **B** |
| Network exposure of the exec API | Public via app ingress (code-gated) | ClusterIP-only (topology-gated) | **B** |
| First workload-identity pod on AGK | The main app deployment | A disposable small pod | **B** |
| Release/rollback coupling | Full app release per fix | Independent cadence + env-var kill switch | **B** |
| Upstream merge surface | One route seam + Knauf code under `api/` | Zero upstream lines | **B** |
| New npm dependencies | None needed (verified) | Own tree (irrelevant to root) | tie |
| Ops footprint | No new deployable | 1 stateless pod + existing CI/GitOps patterns | **A** |
| Local dev | One process | Two processes (`LOCAL_MODE`) | **A** |
| Platform precedent | Would be novel (folding a service into the app) | Matches `rag_api`/meilisearch/langfuse | **B** |

## 5. Reversibility — why deciding "sidecar" now is low-risk

The adapter is a self-contained package whose hard parts (contract mapping, sentinel wrapper, staging lifecycle,
contract-replay test suite) are transport-agnostic. If the extra deployable ever proves genuinely burdensome,
mounting its router in-process later is a mechanical change and the tests carry over. The reverse migration —
extracting execution traffic *out* of an overloaded app process under incident pressure — is the direction that
hurts. When two options differ mainly in which mistake is recoverable, pick the recoverable one.

## 6. Decision

**Tier-3 sidecar, as built.** Revisit only if (a) AGK later prohibits additional services per namespace, or
(b) the adapter's real resource profile proves so negligible *and* its release cadence so fused to the app's that
the isolation arguments stop paying rent — measure via the adapter's own `/metrics` after dev rollout.

# Code Interpreter backend — implementation designs: self-hosted ClickHouse vs Azure Container Apps (KK20-108)

> **Status: DECIDED (Aug 2026) — Option 2 (ACA dynamic sessions + adapter) SELECTED and being built.**
> The adapter exists at [`knauf/code-adapter/`](../../code-adapter/) (see its README for the
> authoritative contract + operational reference); the CI workflow is
> `.github/workflows/build-code-adapter.yaml`. Build-out corrections discovered during
> implementation, beyond what Option 2 below describes: the contract also includes
> `POST /upload/batch` (+`read_only`), `GET /sessions/{s}/objects/{f}` freshness probe,
> `DELETE /files/{s}/{f}` fallback, `POST /exec/programmatic` (PTC — adapter returns 501),
> the `?kind&id&version` identity protocol on every file call, and per-file
> `storage_session_id` + `inherited` response fields; `CodeExecutor`/`BashExecutor` freeze
> the exec URL at module load (env var must precede boot; no runtime override); and
> `verifyToolAuth` never probes the backend, so failures surface at exec time. The exec
> wrapper (base64 + sentinel + `/mnt/data` log tee) upgrades the "synthesize 0/1" plan to
> REAL exit codes and recovers output past the ~4000-char cap.
>
> Originally: companion to the decision matrix
> [`code-interpreter-backend-options.md`](code-interpreter-backend-options.md) and the
> [rollout plan](../implementation-plans/code-interpreter-artifacts-rollout.md). This doc builds out the **two finalist
> backends** concretely — against how AGK *actually* deploys services (mined from the live
> `Knauf-Group/agk-deployment-configs`, branch `feat/KK20-195-agentic-karl-worker`, July 2026) — and compares them deeply.
> The Azure OpenAI Foundry / Assistants options were dropped: Foundry CI is an agent-wrapped sandbox with no verbatim-exec
> endpoint (see the decision doc's Option C note); artifacts are backend-independent (client-side Sandpack) and are not a
> criterion here.

## The contract both backends must satisfy

`LIBRECHAT_CODE_BASEURL` → `POST /exec {lang, code, files?}` → `{session_id, stdout, stderr, code, files[]}`, plus
`/upload` (+`/upload/batch`), `/download/{session}/{fileId}`, `DELETE /sessions/{s}/objects/{f}`. Auth: LibreChat mints a
short-lived EdDSA/RS256 JWT per request ([`packages/api/src/auth/codeapi.ts`](../../../packages/api/src/auth/codeapi.ts));
the backend verifies with the public key. **Two consumer surfaces must both work:** the manual **Run button**
(deterministic exec of a code block) and **agent auto-run** via `bash_tool` — the dominant traffic is `lang=bash` plus
`python3 <<'EOF'` heredocs, executed **verbatim** with real stdout/stderr.

## How AGK deploys anything (the recipe both designs follow)

Mined from the live GitOps repo — the invariant rules:

- **Service = a wrapper `Chart.yaml`** depending on OCI `ct-shared-chart` (`oci://acrctshared001.azurecr.io/helm`, pinned
  `2.13.0`) + a `values.yaml` nesting everything under the alias key. Vendored `templates/*.yaml` are an *escape hatch*
  for resources the shared chart can't render (langfuse-clickhouse precedent: a PVC/PDB/extra-Service).
- **Two-source ApplicationSet model** ([`infra/nonprod/argocd/projects/services.yaml`](https://github.com/Knauf-Group/agk-deployment-configs)):
  a service with no own `Knauf-Group/<name>` repo is **single-source** — it must be **excluded** from the multi-source
  `services` set *and* listed in `services-local`. Both edits in the same PR (forgetting the exclude generates a broken
  Application cloning a nonexistent repo). Sync is `selfHeal + prune` → **merge to `main` = deploy**.
- **Secrets:** Azure Key Vault (`kv-agntkarl-{nonprod,prod}-001`, entries written by Terraform in
  `Knauf-Group/agk-infrastructure`) → External Secrets Operator (`SecretStore kv-agntkarl-nonprod-001`, WorkloadIdentity
  auth on `sa-external-secrets`) → k8s Secret. New KV entries follow `AGK-*` naming.
- **Images:** ACR `acragkhubnonprod001` (dev) / `acragkhubprod001` (prod). Four provenance patterns exist — main-app
  release pipeline; **own-image services** (rag-api, admin-panel, each with a build/promote workflow); **public images
  mirrored into ACR** (`promote-langfuse.sh`); and direct public pulls (meilisearch off Docker Hub — proves
  `sourceRepos` gates *charts*, not *images*). Prod images arrive via `az acr import` nonprod→prod.
- **Scheduling:** every pod carries the same triad — `nodeSelector node_label: usernpool`, spot toleration, **required**
  spot node-affinity. Everything runs on one **spot** user pool. **No taints/dedicated pools, and no
  `securityContext`/privileged/capabilities anywhere in the repo** — universally `{}`.
- **Workload identity:** **no application pod authenticates to Azure today** — only ESO uses WorkloadIdentity. An
  Azure-token-needing app would be the first (recipe §5).
- **Network:** namespace `defaultDenyAll` with allowlists; new private-endpoint egress needs a `customPolicies` entry.
- **Same-image-different-command precedent:** `agentic-karl-worker` (KK20-195) — reuses the app image with
  `command: [npm, run, backend:worker]`, its own ExternalSecret on the same KV keys, ClusterIP, dev-only for now.

Both designs land dev-first (prod mirror later is the accepted shape).

---

# Option 1 — Self-hosted ClickHouse code-interpreter ("codeapi") on AGK

Deepens the rollout plan. Verified against the local `ClickHouse/code-interpreter` clone (helm chart + Dockerfiles).
GitOps service = `agentic-karl-codeapi`; in-cluster Services `agentic-karl-codeapi-{api:3112,file-server:3000,tool-call-server:3033,egress-gateway:3190,sandbox-runner:2000}`.

### Headline decisions

| # | Decision | Choice + why |
|---|---|---|
| D1 | Images + chart source | **Fork → `Knauf-Group/code-interpreter`** (branch `knauf` = pinned upstream commit + patch set P1–P4 + one CI workflow). The repo publishes no images and no public chart — we must build. |
| D2 | Chart consumption | **Publish the `codeapi` chart to `oci://acrctshared001.azurecr.io/helm`** (already in both AppProjects' `sourceRepos`; zero ArgoCD change) and consume via a thin wrapper — **not** vendoring the 2,100-line chart into two env dirs. |
| D3 | Isolation | `kvmEnabled: false` (NsJail direct) on the standard spot pool — the KVM node-pool spike is deferred (see risk R1). |
| D4 | Runtimes | **Bake packages into the sandbox-runner image** (patch P4) → no PVC, no package-init Job, no ArgoCD-hook interaction, runners spread freely. |
| D5/D6 | Redis + object store | `redis.enabled=false` + `minio.enabled=false` (Bitnami subcharts off — prod's AppProject even drops `bitnamicharts` from `sourceRepos`). Dedicated sibling `agentic-karl-codeapi-redis` (langfuse-redis clone); `minio.useSimple=true` (chart's non-Bitnami path) hardened by patch P2. |
| D7 | Secrets | Fork patch P1 adds `existingSecret`; material flows KV → ESO → the Secret the chart already references. |
| D8 | Exposure | ClusterIP only, no ingress — LibreChat is the only client, same namespace. |

### Images (7, none published upstream)

`codeapi-api`, `codeapi-worker`, `codeapi-sandbox-runner`, `codeapi-file-server`, `codeapi-tool-call-server`,
`codeapi-egress-gateway`, `codeapi-package-init` (fallback only). Build path modeled on the two existing precedents —
self-contained-workflow auth like `build-rag-api-overlay.yaml`, runner+ACR mechanics like `promote-langfuse.yaml`: one
CI workflow in the fork builds all 7 → `acragkhubnonprod001.azurecr.io/agentic-karl-dev/codeapi-<c>:<TAG>`, then
`helm push` the chart to `acrctshared001/helm`. **Tag scheme** `<upstreamAppVersion>-knauf.<N>`, all images + chart move
in lock-step, immutable tags. **Drift is pull-based** (no upstream registry to track): re-merge monthly and on
security fixes / when a LibreChat upstream sync touches the Code API contract.

### Fork patches (each a separate commit for re-merge hygiene)

- **P1 `existingSecret`** — verified needed: the key is absent from stock `values.yaml`; add it, gate `secrets.yaml`,
  route every `<fullname>-secrets` secretKeyRef through a `codeapi.secretsName` helper, and relax the
  execution-manifest-private-key fail-fast.
- **P2 minio-simple hardening** — verified needed: `templates/minio-simple.yaml` hardcodes
  `minio/minio:RELEASE.2024-11-07…` and takes root creds from plaintext values; parameterize the image (mirror into ACR)
  and switch creds to `secretKeyRef`, add an optional PVC.
- **P4 `sandbox-runner-direct-baked`** — `api/Dockerfile` already has a `package-builder` stage; add
  `FROM sandbox-runner AS sandbox-runner-direct-baked` + `COPY --from=package-builder /pkgs /sandbox-rootfs/pkgs` so
  runtimes ship in the image (NsJail direct mode). (P3 busybox image param — optional/later.)

### Values sketch (dev) + the securityContext reality

Everything under `codeapi:` in `agentic-karl/dev/services/agentic-karl-codeapi/values.yaml`:
`existingSecret: agentic-karl-codeapi-secrets`; `api` ClusterIP:3112 + JWT verifier via `api.extraEnv`
(`CODEAPI_AUTH_PROVIDER=librechat-jwt`, `CODEAPI_JWT_PUBLIC_KEY`/`_KID`/`_ISSUER`/`_AUDIENCE`/`_ALLOWED_ALGS=EdDSA`);
`workerSandbox.kvmEnabled=false`, packages baked (P4), `disableNetworking=true`, `perJobUids=true`;
`redis.enabled=false` + `external.host: agentic-karl-codeapi-redis`; `minio.enabled=false, useSimple=true` (P2 image +
PVC); the mandatory usernpool/spot triad chart-wide; `ingress.enabled=false`. Secrets via a vendored
`templates/external-secret.yaml` (langfuse-clickhouse escape-hatch) mapping `AGK-CODEAPI-*` KV entries. LibreChat→codeapi
keypair and the internal execution-manifest keypair are **two distinct Ed25519 keys** (`openssl genpkey -algorithm
ed25519`), private halves in KV, public halves in values.

> **⚠️ Verified top risk (R1):** in `kvmEnabled: false` mode the chart's `worker-sandbox-deployment.yaml` sets the
> sandbox-runner container to `privileged: false` **but** `seccompProfile: Unconfined` and
> `capabilities.add: [SYS_ADMIN, SYS_CHROOT, SYS_PTRACE, NET_ADMIN, DAC_OVERRIDE, MKNOD, …]` (NsJail's `pivot_root`
> needs them). **AGK has zero precedent for any capability-bearing pod** — this would be the first, on a shared spot
> pool. Not `privileged`, but materially weaker than the microVM posture. Mandatory pre-flight: apply a throwaway pod
> with that cap set in `agentic-karl-dev` and confirm no Azure Policy/Gatekeeper admission constraint rejects it,
> **before** anything else lands. End-state remains the KVM spike (`kvmEnabled: true` → zero added caps + RuntimeDefault,
> possibly a dedicated tainted pool).

### Registration, promotion, verification

Two single-source dirs (codeapi + its redis) → exclude in `services`, list in `services-local`, one PR. Prod: `az acr
import` the 7 images nonprod→prod, copy the dirs swapping ACR/KV/namespace/keys, mirror the ApplicationSet edits. Verify
in-cluster: `/v1/health`; `sandbox-runner:2000/api/v2/runtimes` lists python/node/bun/bash (empty ⇒ P4 not applied ⇒
every exec 400s "runtime is unknown"); unauth `/exec` → 401 once `LOCAL_MODE` off, JWT-authed → 200 with a
`pandas`/matplotlib `files[]` round-trip. Rollback layers: revert the `librechat.yaml` capability (one release) → unset
`LIBRECHAT_CODE_BASEURL` (fast) → rotate `AGK-CODEAPI-JWT-*` in KV (compromise) → revert the GitOps PR (teardown).

---

# Option 2 — Azure Container Apps dynamic sessions + a Knauf Tier-3 adapter

Microsoft-managed Hyper-V sandbox; a small in-cluster adapter (`agentic-karl-code-adapter`) speaks the LibreChat Code
API on the front and the ACA session-pool management API on the back. Zero LibreChat source touched; sandboxing,
isolation, and scale-to-zero are Microsoft's problem — which is the point, since AGK **cannot** host a privileged NsJail
workload comfortably (R1 above).

### Azure resources

- **`Microsoft.App/sessionPools`** (mgmt api-version `2025-07-01` GA; data-plane `2025-10-02-preview`), in
  **agk-infrastructure Terraform** via the **AzAPI provider** (no native `azurerm` resource). Region **West Europe**
  (matches AKS, on the supported-region list).
- **Two built-in pools** (container types are now `PythonLTS | NodeLTS | Shell | CustomContainer`): `sp-agk-code-py-{env}`
  (`PythonLTS`, numpy/pandas/scikit preinstalled) for `lang=py`; **`sp-agk-code-sh-{env}` (`Shell`) for `lang=bash`** —
  the dominant `bash_tool` traffic. **Spike S1:** confirm `Shell` GA + West-Europe availability + that `python3` is
  present in the shell image (bash_tool emits python heredocs). Config: `--network-status EgressDisabled` (no `pip
  install`), `maxConcurrentSessions` dev 20 / prod 50, `cooldownPeriodInSeconds 300` (platform minimum → lowest cost).
- **Custom-container fallback (only if S1 fails):** a DIY exec-server image on a `CustomContainer` pool — note the irony
  (writing a sandbox server to run on Microsoft's sandbox) and the cost flip to always-on provisioned billing; if we land
  here, the self-hosted comparison reopens.

### Identity chain (the critical-path, first-of-its-kind infra)

adapter pod → projected SA token → Entra token (`aud: https://dynamicsessions.io`) → **"Azure ContainerApps Session
Executor"** role scoped to each pool. **Verified: no AGK app uses workload identity today** — only ESO does, which
proves the cluster prerequisites exist. In **agk-infrastructure Terraform**: a user-assigned managed identity, a
federated credential (subject `system:serviceaccount:agentic-karl-dev:sa-code-adapter`), and the role assignments.
Spikes: **S3** confirm the AKS OIDC issuer is enabled (ESO implies yes; if not, a platform-team cluster update — the long
pole); **S4** confirm `ct-shared-chart` can render an annotated ServiceAccount + the `azure.workload.identity/use: "true"`
pod label (values keys exist but are unused; vendored-SA template is the fallback). Adapter code then uses
`DefaultAzureCredential` with scope `https://dynamicsessions.io/.default`.

### The adapter (`knauf/code-adapter/` in agentic-karl-v2 — `rag-api-overlay` precedent)

Small Node/Express (`express, jose, @azure/identity, undici, multer`), own package tree/lockfile (no Knauf deps in root
`package.json`), built by a self-contained workflow (rag-api-overlay clone) → `acraghub…/agentic-karl-code-adapter`.
Contract mapping:

| Code API (adapter serves) | Pool API (adapter calls) | Key detail |
|---|---|---|
| `POST /exec {lang,code,files?}` | `POST {pool}/executions {properties:{codeInputType:"inline",executionType:"synchronous",code}}` | Pool by `lang` (py→PythonLTS, bash→Shell, else 501). Response has **no numeric exit code** → synthesize `code: 0/1` from status (documented divergence — bash_tool sees real stdout/stderr, binarized exit). **220 s hard cap** → on timeout return `code:1` + friendly stderr, never 5xx. **Spike S5:** pin the exact preview response JSON (shape changed once already). |
| `POST /upload[/batch]` | *(staged — see below)* then `POST {pool}/files` | **Upload-before-exec problem:** LibreChat uploads before any session exists and cooldown min is 300 s. Stage to **Azure Blob** (`code-adapter-staging/<sid>/<fileId>`, `AZURE_STORAGE_CONNECTION_STRING` already a KV secret), push into the session at first `/exec`. 128 MB cap → 413. |
| `GET /download/{sid}/{fileId}` | `GET {pool}/files/{name}/content` | fileId→filename via a **Mongo** index (`code_adapter_files`, TTL 24 h; survives `replicaCount:2` + restarts). Post-exec, copy generated files to blob so downloads outlive the session. |
| `DELETE /sessions/{s}/objects/{f}` | *(no file-delete endpoint)* | Emulate via an exec `os.remove`/`rm`; `SessionWithIdentifierNotFound` ⇒ treat as success. |

Inbound: verify LibreChat's JWT with `jose` (public key + issuer/audience/kid via ConfigMap — not secret) — the same
verification the ClickHouse backend does. Session mapping: `session_id ⇄ pool identifier` 1:1, server-minted
`karl-<uuid>`, regex-validated (identifiers are security-sensitive). On `SessionWithIdentifierNotFound`, transparently
re-mint + re-push staged files (makes cooldown expiry invisible for uploaded files).

### Deployment + verification

Single-source service (worker-skeleton values + `serviceAccount.create:true` + the workload-identity annotation/label —
the two lines that make it the repo's first such service), ClusterIP, `externalSecret` for `MONGO_URI` +
`AZURE_STORAGE_CONNECTION_STRING` (**no pool credential — that's the workload-identity win**). Verify: mint a test JWT →
`/exec {lang:py} → "42"`; CSV upload → pandas → PNG download; `lang=bash` exit-code binarization; >220 s → friendly
timeout; cooldown-expiry → transparent re-mint. Rollback: purely additive — unset `LIBRECHAT_CODE_BASEURL`; pools cost
~nothing idle.

### Verified risks

- **220 s exec cap** vs LibreChat's ~300 s expectation (hard platform limit; friendly stderr, document in the prompt).
- **128 MB upload cap** vs 512 MB+ (RAG stays the big-file path).
- **Shell-pool assumption (S1)** — bash is the *main* consumer; spike before committing.
- **Preview data-plane API churn** — pin api-version in ConfigMap; shape-validating tests; adapter is the single choke point.
- **Workload-identity first-mover (S3/S4)** — front-loaded spikes; ESO de-risks the cluster side.

---

# Deep comparison

| Dimension | **Self-hosted ClickHouse** | **ACA dynamic sessions + adapter** |
|---|---|---|
| Contract fit | **Native — it *is* the Code API** (zero adapter) | Via a Tier-3 adapter (contract-mapped) |
| Run button | ✓ deterministic, all langs | ✓ deterministic (py/bash) |
| Agent `bash_tool` | ✓ bash + python/node/bun natively | ✓ **iff** the `Shell` pool spike (S1) passes; else custom-container |
| Languages | Python, Node, Bun, **Bash** (+seedable) | Python + Node + Shell built-in pools |
| stdout/stderr/**exit code** | Real `{stdout, stderr, code}` | Real stdout/stderr; **exit code synthesized 0/1** |
| Exec time limit | Configurable (dev compose uses 300 s) | **220 s hard** (platform) |
| File size | ~150 MB artifacts | **128 MB** upload cap |
| Isolation | **NsJail (shared kernel, +SYS_ADMIN) — R1**; microVM only after a KVM node pool | **Hyper-V per session, MS-operated** — no cluster privilege at all |
| New cluster infra | Capability-bearing pod (first on AGK); maybe a KVM/dedicated pool | **First app workload identity on AGK** (UAMI + federated cred + OIDC) |
| Azure resources | None outside AKS | Session pools + UAMI (agk-infrastructure Terraform) |
| Cost model | **Fixed infra, always-on** (7 services + redis + minio) | **Per session-hour, ~zero idle** (get rate in S2) |
| Data residency | Fully in-cluster/in-tenant | In-tenant (your subscription/region), MS-operated sandbox |
| Sandbox egress | Locked by egress-gateway (policy-controlled) | `EgressDisabled` (no egress at all) |
| Images to build/own | **7** + chart + fork patch-set (re-merge on upstream) | **1** tiny adapter |
| Maintenance | Fork drift (P1/P2/P4 re-resolve), runtime baking, image size (2–4 GiB) | Adapter + **preview-API churn**; MS owns the sandbox |
| Ops burden | **High** — you run the sandbox fleet | **Low** — MS runs it; you run a stateless proxy |
| Platform-fit (AGK) | Fights the no-privilege / spot-only / no-dedicated-pool posture | Fits "managed Azure" but pioneers workload identity |
| Biggest unknown | Will admission allow `SYS_ADMIN`? (R1 pre-flight) | Does `Shell` cover bash + is workload identity turnkey? (S1/S3/S4) |

### Recommendation (unchanged, now with the build-out to back it)

- **Primary: self-hosted ClickHouse, NsJail-only, dev-first.** It's the only backend that satisfies the contract with
  **zero adapter** and natively covers bash + multi-language + real exit codes — the exact shape KARL's `bash_tool`
  path needs. Accept shared-kernel isolation for authenticated internal users; gate on the R1 admission pre-flight; hold
  microVM as the hardening end-state.
- **Escape hatch: ACA + adapter.** If the R1 capability pre-flight is rejected by cluster policy, or Knauf mandates
  managed-only sandboxes, this becomes primary — it removes the privilege problem entirely and bills ~zero idle, at the
  cost of an adapter, the 220 s/128 MB limits, the exit-code compromise, and pioneering workload identity. Do the S1/S3
  spikes first — they're cheap and decide feasibility.
- **The deciding question is platform, not features:** *will AGK admission allow a `SYS_ADMIN` pod?* If yes → self-host.
  If no → ACA. Run the R1 pre-flight (one throwaway pod, one afternoon) before committing either way.

### Verification note

Both designs were produced against the live `agk-deployment-configs` and `ClickHouse/code-interpreter` clones and their
load-bearing claims independently re-checked: the NsJail `SYS_ADMIN`/`Unconfined` securityContext (R1), the three
required chart patches (`existingSecret`, minio-simple image/creds, baked runtimes), the `redis.external`/`minio.useSimple`
value keys, and the "no app workload identity today" finding are all confirmed in-repo. Azure facts
(pool types incl. `Shell`, 220 s / 128 MB caps, identifier charset, Session Executor role, api-versions) are from current
Microsoft Learn docs (July 2026).

## Sources

- `Knauf-Group/agk-deployment-configs` (ApplicationSets, ESO, worker precedent, image provenance, scheduling)
- `ClickHouse/code-interpreter` — `helm/codeapi/` chart + `api/Dockerfile`/`service/Dockerfile*` (verified locally)
- [ACA dynamic sessions — code interpreter](https://learn.microsoft.com/en-us/azure/container-apps/sessions-code-interpreter),
  [sessions usage](https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage),
  [session pools](https://learn.microsoft.com/en-us/azure/container-apps/session-pool),
  [`Microsoft.App/sessionPools` template](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/sessionpools)
- In-repo: [`packages/api/src/auth/codeapi.ts`](../../../packages/api/src/auth/codeapi.ts) (Code API JWT contract)

# Deploy code execution to dev — execution checklist

The ordered, do-this-now sheet for turning code execution on in `agentic-karl-dev`.
Ticket **KK20-257** (feature) on top of **KK20-108** (backend decision).

This is deliberately narrower than [deployment.md](deployment.md), which is the reference
runbook — what each repo contributes and why. **This doc is the sequence**, with the current
state of each piece, the ordering traps that will bite if steps are reordered, and the exact
keys to paste. Capacity expectations for what you are switching on are in
[scaling.md](scaling.md).

> **State as of 2026-08-11.** Nothing is deployed. Three repos have to move, in order, and
> all three PRs are open but unmerged.

| Repo                                 | What it contributes                                                                   | State                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Knauf-Group/agentic-karl`           | The adapter source, the CI that builds its image, the capability flip                 | **PR #258 open, `MERGEABLE / CLEAN`** — all checks green, review round 2 addressed. Ready to merge                                                                                                                                    |
| `Knauf-Group/agk-infrastructure`     | ACA session pool, managed identity, federated credential, role assignment, KV secrets | **PR #73 open, `MERGEABLE / BLOCKED`** — plan green (12 add / 0 change / 0 destroy), all four checks pass. `BLOCKED` is the required-review gate only; **approval is the sole remaining action**                                      |
| `Knauf-Group/agk-deployment-configs` | The adapter Deployment/Service/SA, ArgoCD registration, and the app-side env wiring   | **PR #347 open** — adapter only, deliberately inert; the app-side wiring is a second PR. Repo is busy (five app version bumps merged on 08-11 alone), so re-check `ct-shared-chart` and the ApplicationSet line numbers at merge time |

**Exactly one hard unknown remains** (everything else below is sequencing you control): whether
`ct-shared-chart` 2.15.0 renders `podLabels`. It cannot be answered from the repos — the chart
is an OCI artifact in a private ACR — and if the answer is no, every execution fails 502.

It is a blocker for the **switch** (D4), _not_ for #347: merging #347 with a broken workload
identity deploys a pod that nothing calls. So the cheapest order is merge #347, run one
`kubectl exec` to read the injected `AZURE_*` variables, and fix the label if they are absent —
all before D4. Both routes are spelled out in Phase 0.

---

## The sequence, at a glance

Twelve steps. The **Gate** column is what tells you the step actually worked — if you cannot
observe it, the step is not done. Detail for each is in the phase named beside it.

| #   | Do                                                                                            | Gate — how you know                                                                                                                              | Where    |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1   | Answer #73's three open questions in the PR conversation                                      | Reviewer has nothing left to ask                                                                                                                 | Phase 0  |
| 2   | `az provider show --namespace Microsoft.App --query registrationState -o tsv`                 | `Registered`. **Not** a plan-time failure — an unregistered RP fails at _apply_                                                                  | Phase 0  |
| 3   | Get #73 approved and merge it                                                                 | `apply-tenants` green on `main`; 12 resources created                                                                                            | Phase A  |
| 4   | Capture `terraform output code_adapter_dev_client_id` and `code_pool_dev_management_endpoint` | Both non-empty; also in Key Vault                                                                                                                | Phase A  |
| 5   | Generate the Ed25519 keypair; private half → Key Vault                                        | `az keyvault secret show --name AGK-CODEAPI-JWT-PRIVATE-KEY` returns                                                                             | Phase B  |
| 6   | Merge #258                                                                                    | `Build adapter into AGK ACR` runs on `main` (it is `skipping` on PRs by design) and the tag from `knauf/code-adapter/VERSION` appears in the ACR | Phase C  |
| 7   | Substitute #347's two placeholders (client id from 4, public key from 5)                      | The **`Reject committed placeholders`** check turns green. It fails today on purpose — that is the gate, not a bug                               | Phase D  |
| 8   | Merge #347                                                                                    | ArgoCD syncs; pod `Running` and `/readyz` 200                                                                                                    | Phase D  |
| 9   | Read `spec.serviceAccountName` and the injected `AZURE_*` vars                                | `sa-code-adapter` (not `default`) and all three vars present. **Answers both chart unknowns at once**                                            | Phase E  |
| 10  | Confirm the auth boundary and one real exec                                                   | Unauthenticated → 401; a JWT'd `/v1/exec` returns pandas' version                                                                                | Phase E  |
| 11  | Ship the switch PR (`KNAUF_CODE_EXECUTION_ENABLED=true` + URL + JWT values) as **one** commit | `execute_code` in the served `/api/endpoints`; the boot warning stops                                                                            | Phase D4 |
| 12  | Walk the UI checklist, then run the capacity baseline                                         | Observed success/capacity counts and recovery time are recorded; no production size is inferred from the configured limit alone                  | Phase E  |

Steps 1–2 are the only ones that can be done today; 3 unblocks everything after it.
**Nothing between 6 and 11 is user-visible** — the feature turns on at 11 and nowhere earlier.

---

## Ordering constraints (the three that actually bite)

1. **Terraform before GitOps.** The GitOps values need the MI client id and the pool
   endpoint, and both are Terraform outputs.
2. **#258 must merge before the adapter image exists.** `build-code-adapter.yaml` is not on
   `main` yet, so **`workflow_dispatch` is not available** — `gh workflow list` does not show
   it. The first image is produced by the `push: branches: [main], paths: knauf/code-adapter/**`
   trigger when #258 merges. A GitOps PR pointing at a tag that was never built leaves the pod
   in `ImagePullBackOff`.
3. **The capability is inert until both environment gates pass.** `librechat.yaml`
   already lists `execute_code`, but `codeEnvGuard.ts` strips it unless
   `KNAUF_CODE_EXECUTION_ENABLED=true` and `LIBRECHAT_CODE_BASEURL` names a controlled host.
   The feature goes live only in Phase E.

---

## Phase 0 — before anything merges

- [x] **#73:** tag lifecycle on both `azapi_resource.code_pool_*` — **done** (`bff637390`).
      `lifecycle { ignore_changes = [tags["ACM"], tags["CostCenter"]] }`, byte-identical to the
      `mi-dev.tf` precedent. The `apply-tenants` plan job re-ran green afterwards, so the plan
      output is unchanged (as expected — `lifecycle` is a Terraform-side meta-argument and
      creates nothing).

      Kept here because the prod twin will need the same thing: Azure Policy stamps `ACM` and
      `CostCenter` *after* creation, Terraform then sees tags it didn't write and proposes
      removing them, policy re-applies them, and the pair never converges. The two managed
      identities already had the guard (copied from `mi-dev.tf`); the pools were written fresh
      and missed it.

      The trap worth remembering: a *0 to change* plan is not evidence against this. It is 0
      only because nothing exists yet and no policy has run — the drift first appears on the
      plan **after** the first apply, i.e. on whatever unrelated PR touches this root next.

      Also don't "simplify" `tags = { for k, v in local.tags : k => tostring(v) }` to
      `local.tags`: ARM tag values must be strings and `local.tags` carries `Shared = false`
      as a bool.

- [x] **#258:** the `/download` stream-error handler — **done** (`1666f852b`). `pipeline()`
      instead of `.pipe()`, plus the floating `repo.touch()` caught. Either one exited the
      process, on the path every generated chart and spreadsheet is served over.
- [x] **#258:** `main` merged in (`b33d29c34`, `33aca5a63`) and the review round-2 findings
      addressed (`d6fad8068`, `ed7dcc043`) — sandbox ownership, capture time budget, drain,
      upload count cap, the code-env allowlist, the destination-gate invariant, and the CI test
      gate.

      Two things that were assumptions and are now **verified in CI** on that PR:

      - The adapter now has a **PR-time test gate**: `Unit + contract tests` ran on the pull
        request (97/97), and `Build adapter into AGK ACR` correctly reported `skipping` — the
        `if: github.event_name != 'pull_request'` guard keeping an Azure login off fork PRs.
        Before this, adapter changes reached `main` untested.
      - The **client-drift tripwire is armed**, not skipping. The job installs
        `@librechat/agents` (which the adapter does not depend on) and sets
        `KNAUF_REQUIRE_LOCKED_CLIENT=true`, which turns the graceful local skip into a hard
        failure. Its first real run also answered a standing question: all three pinned
        client behaviours — no `session_id` in the POST body, `result.code` never read,
        `runtime_session_hint` present — still hold against **3.4.5**, far newer than the
        3.2.65 the lockfile pins. That job now installs the *locked* version rather than the
        range, so it tests what the app actually ships.

- [ ] **Get #73 approved.** Blocked on review, not on anything technical — the plan is green
      and the checks pass. Three things the reviewer will reasonably want answered, so put them
      in the PR conversation rather than making them ask:

      1. **Is `Microsoft.App` registered** on `ad3f0a71-cc5b-4d00-8289-23623cf2064c`? There is
         no Container Apps footprint anywhere in that repo, so this is genuinely unknown, and
         an unregistered resource provider fails at **apply**, not at plan — i.e. after merge.
         `az provider show --namespace Microsoft.App --query registrationState -o tsv`
      2. **Can the pipeline service principal write a role assignment at pool scope?** It
         already creates them on the Key Vault in this root, so it has RBAC-writer inside the
         tenant resource group — but the session pool is a new scope.
      3. **Naming.** `sp-agentic-karl-dev-westeurope-001` follows the tenant root's raw-resource
         family (matching the identity beside it) rather than the module family
         (`…-agk-nonprod-…`). There is no ACA precedent to copy, so it is a choice, not a
         convention — worth an explicit yes.

      Also worth saying out loud in the review: `schema_validation_enabled = false` is on both
      pools, and it is not laziness. azapi 2.8.0's embedded schema wrongly rejects hyphens in a
      session-pool name; the real API only constrains length (3–63). The body *was* validated
      against that schema before the flag went on, which is how the preview-shaped
      `dynamicPoolConfiguration` got caught. Anyone changing `body` should flip it back on
      temporarily.

- [ ] **Answer the `podLabels` question before the _switch_ PR** (D4). Not before #347 — see
      the note below on why #347 is safe to merge either way.

      What has to be true: the pod carries the label `azure.workload.identity/use: "true"` on
      its **pod template**, not on the Deployment's own metadata. The webhook only mutates
      pods; a label in the wrong place looks right in a diff and does nothing.

      The chart is an OCI artifact, so the dependency has to be pulled before `helm template`
      will render anything:

      ```bash
      cd agentic-karl/dev/services/agentic-karl-code-adapter
      az acr login --name acrctshared001            # or: helm registry login acrctshared001.azurecr.io
      helm dependency update .                      # pulls ct-shared-chart 2.15.0 into charts/

      # Read the POD template labels specifically. Do NOT use `grep -A5 'kind: Deployment'` —
      # that window only covers the Deployment's own metadata and will report a false negative.
      helm template . \
        | python3 -c 'import sys,yaml; [print(yaml.safe_dump(d["spec"]["template"]["metadata"].get("labels",{}))) for d in yaml.safe_load_all(sys.stdin) if d and d.get("kind")=="Deployment"]'
      ```

      Expect `azure.workload.identity/use: "true"` in that output. If it is absent, the chart
      does not plumb `podLabels` and the label has to come from somewhere else — either the
      chart gains support, or vendor a `templates/` override in the service directory
      (`langfuse-clickhouse` already does this for its PDB, so the escape hatch is established).

> **The cheaper route: merge #347 and just look.** #347 is inert — nothing routes to the
> adapter until `LIBRECHAT_CODE_BASEURL` is set — so deploying it with a broken workload
> identity costs nothing and answers the question definitively in one command:
>
> ```bash
> kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- env | grep AZURE_
> # want: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
> # all three are injected by the webhook; the adapter never sets them itself
> ```
>
> Those three variables either exist or they don't, which beats reasoning about chart
> internals. `helm template` is worth doing to avoid a surprise, but it is the harder way to
> get the same answer.
>
> **Why you must check rather than wait for an error:** the adapter acquires its Entra token
> lazily, on the first ACA call. So a missing workload identity produces _no_ boot-time
> failure and _no_ log line — the pod is Ready (`/readyz` proves Table access, not ACA) and looks healthy
> right up until the first execution 502s. Nothing tells you until a user tries. If you would
> rather have that fail loudly, the fix is a boot-time `tokens.getToken()` probe alongside the
> JWT-key check in `index.ts`, which would turn it into a CrashLoopBackOff.

---

## Phase A — Terraform (merge #73)

Merging applies via `deploy-nonprod-tenant.yaml` (it discovers changed directories by git
diff; no CI change needed). Creates 12 resources across dev + stage.

- [ ] Confirm `Microsoft.App` is registered on `ad3f0a71-cc5b-4d00-8289-23623cf2064c`.
      **An unregistered RP fails at apply, not at plan** — this is the most likely first-apply
      failure.
- [ ] If the role assignment fails with `PrincipalNotFound`, re-run once. A brand-new
      user-assigned identity can lose a race with Entra replication; `principal_type` is set,
      which usually avoids it.
- [ ] **Optional but recommended in the same PR — the Blob role assignment.** Review finding
      B2: `agentic-karl-BLOB-STORAGE-CONNECTION-STRING` is the storage account's _primary key_
      (`module.storage_blob_dev.storage_primary_connection_string`), so giving it to this pod
      grants every container on the account, including the app's own `files`. The adapter now
      supports workload identity for Blob (`e5ae34e23`), so this becomes a config change:

      **Written and committed to #73.** The container goes in the storage module's
      `containers_list` (the house pattern) rather than a standalone `azurerm_storage_container`,
      and the role assignment mirrors `azurerm_role_assignment.terraform_blob_contributor`
      already in `blob-dev.tf`:

      ```hcl
      # blob-dev.tf — alongside the existing "files" container
      containers_list = [
        { name = "files", access_type = "private" },
        { name = "code-adapter-staging", access_type = "private" },
      ]

      # code-adapter-dev.tf — CONTAINER scope, not account scope
      resource "azurerm_role_assignment" "code_adapter_blob_dev" {
        scope                = "${module.storage_blob_dev.storage_account_id}/blobServices/default/containers/code-adapter-staging"
        role_definition_name = "Storage Blob Data Contributor"
        principal_id         = azurerm_user_assigned_identity.code_adapter_dev.principal_id
        principal_type       = "ServicePrincipal"
      }
      ```

      Terraform owns the container for a non-obvious reason: creating one needs a broader
      permission than using one, so a container-scoped role cannot run `createIfNotExists`.
      The adapter tolerates that 403 only when the container already exists.

      Then in D2, replace the ExternalSecret entry with a configmap `AZURE_STORAGE_ACCOUNT_NAME`
      (published as the `code_adapter_dev_blob_account_name` output). Order does not matter: the
      adapter prefers workload identity whenever that is set, so there is no window where the
      key is still the credential in effect.

- [ ] Record the two values the next phase needs:

  ```bash
  terraform output code_adapter_dev_client_id         # -> SA annotation
  terraform output code_pool_dev_management_endpoint  # -> ACA_POOL_ENDPOINT
  ```

      Both are also published to `kv-agntkarl-nonprod-001` as
      `agentic-karl-dev-MI-CODE-ADAPTER-CLIENT-ID` and `agentic-karl-dev-CODE-POOL-ENDPOINT`.

---

## Phase B — the JWT keypair (manual, by hand, once)

The private half never enters Terraform state — that is the `AGK-*` = manually-managed
convention.

```bash
openssl genpkey -algorithm ed25519 -out lc-codeapi-dev.key
openssl pkey -in lc-codeapi-dev.key -pubout -out lc-codeapi-dev.pub

az keyvault secret set --vault-name kv-agntkarl-nonprod-001 \
  --name AGK-CODEAPI-JWT-PRIVATE-KEY --file lc-codeapi-dev.key
```

- [ ] Keep `lc-codeapi-dev.pub` — it becomes a ConfigMap value in Phase D. It is **not** a
      secret.
- [ ] Choose the `kid` now and write it down; it has to be identical on both sides:
      `lc-codeapi-dev-2026-08`.

---

## Phase C — merge the adapter release and confirm the image

- [ ] Merge the reviewed adapter release. The push trigger builds the new value declared in
      `knauf/code-adapter/VERSION` into the AGK hub ACR and refuses to replace an existing tag.
- [ ] Record the workflow's source commit, version, and digest provenance artifact.
- [ ] Verify the tag resolves to that exact digest:

  ```bash
  az acr repository show -n acragkhubnonprod001 \
    --image agentic-karl-dev/agentic-karl-code-adapter:<version> \
    --query digest -o tsv
  ```

- [ ] **Nothing is live yet.** The app is now running with `execute_code` in
      `librechat.yaml` and no `LIBRECHAT_CODE_BASEURL`, so the guard strips the capability and
      logs `[knauf][code] execute_code is disabled: ...`. That log line at boot is the
      expected state between Phase C and Phase E — check for it.

---

## Phase D — agk-deployment-configs (**PR #347**)

Written and open: [agk-deployment-configs#347](https://github.com/Knauf-Group/agk-deployment-configs/pull/347).
It covers D1–D3 and D5 below; **D4 (the switch) is deliberately a second PR**, so "the adapter
is healthy" and "the feature is live" stay separately revertable. What follows is what that PR
contains and what still has to be filled in before it can merge.

**D1 · Service chart** — `agentic-karl/dev/services/agentic-karl-code-adapter/Chart.yaml`,
wrapper on `ct-shared-chart` **2.15.0** (the newest a live service pins — the worker; check
again at merge time, this number moves).

**D2 · Values** — the essentials:

```yaml
agentic-karl-code-adapter:
  namespace: agentic-karl-dev
  replicaCount: 2
  image:
    repository: acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl-code-adapter
    digest: "sha256:<workflow-output>"
    pullPolicy: Always
  service:
    type: ClusterIP
    port: 80
    targetPort: 3112
  pod:
    ports:
      containerPort: 3112

  # The SA itself is minted in common-namespace-resources' `aadServiceAccounts` — the one
  # mechanism on this cluster already proven to render an AAD-annotated ServiceAccount
  # (it produces sa-external-secrets). The service chart only binds to it.
  serviceAccount:
    create: false
    annotations: {}
    name: "sa-code-adapter"
    automountServiceAccountToken: false
  podLabels:
    azure.workload.identity/use: "true"     # ← see the blocker below

  # Datadog will not scrape this pod without BOTH halves: this annotation, and the
  # NetworkPolicy in D5. The namespace is defaultDenyAll, so one without the other is silent.
  podAnnotations:
    ad.datadoghq.com/agentic-karl-code-adapter.checks: |-
      { "openmetrics": { "init_config": {}, "instances": [ {
          "openmetrics_endpoint": "http://%%host%%:3112/metrics",
          "namespace": "agentic_karl",
          "tags": ["env:dev", "service:agentic-karl-code-adapter"],
          "metrics": [ {"code_adapter_exec_total": "code_adapter.exec_total"} ]
      } ] } }
      # (abbreviated — the PR maps all six code_adapter_* metrics. No Authorization
      #  header, unlike the app and worker: this /metrics is unauthenticated by design.)

  configmap:
    CODEAPI_JWT_ISSUER: "agentic-karl"
    CODEAPI_JWT_AUDIENCE: "codeapi"
    CODEAPI_JWT_KID: "lc-codeapi-dev-2026-08"
    CODEAPI_JWT_ALLOWED_ALGS: "EdDSA"
    CODEAPI_JWT_PUBLIC_KEY: |               # public half — safe in values/ConfigMap
      -----BEGIN PUBLIC KEY-----
      ...lc-codeapi-dev.pub...
      -----END PUBLIC KEY-----
    ACA_API_VERSION: "2024-02-02-preview"   # bump only with the adapter's aca fixtures
    ACA_SESSION_API_VERSION: "2025-02-02-preview"
    ACA_SESSION_DELETE_TIMEOUT_MS: "10000"
    EXEC_INPUT_MAX_FILES: "20"
    EXEC_INPUT_MAX_FILE_BYTES: "134217728"
    EXEC_INPUT_MAX_TOTAL_BYTES: "268435456"
    EXEC_MAX_ACTIVE_REQUESTS: "4"
    EXEC_MAX_INFLIGHT_INPUT_BYTES: "536870912"
    EXEC_TOTAL_TIMEOUT_MS: "300000"
    READINESS_CACHE_MS: "30000"
    READINESS_TIMEOUT_MS: "10000"
    # Capacity guardrails — see scaling.md §3. The 256 MB default does not fit this pod.
    CAPTURE_MAX_TOTAL_BYTES: "67108864"
    CAPTURE_MAX_FILES: "20"                 # also caps files per /upload/batch request
    # Cap the V8 heap as the app (6144) and worker (2048) do. This pod is memory-bound by
    # design; without a cap an overrun is a kernel OOM-kill (exit 137, no stack) rather than
    # a JS heap error naming the allocation.
    NODE_OPTIONS: "--max-old-space-size=1536"

  # MUST be >= the adapter's drain budget, which is
  # execTimeoutMs + fileOpTimeoutMs + captureMaxTotalMs + slack (~350s with the defaults in
  # knauf/code-adapter/src/index.ts). Lower, and the kubelet SIGKILLs mid-drain and the drain
  # is decorative — which is what the original 60s did. These two move together.
  terminationGracePeriodSeconds: 360
  strategy:                                 # surge before terminating; never lose capacity
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }

  externalSecret:
    enabled: true
    refreshInterval: 1h
    name: agentic-karl-code-adapter-secrets
    secretStore:
      kind: SecretStore
      name: kv-agntkarl-nonprod-001
    secrets:
      ACA_POOL_ENDPOINT: agentic-karl-dev-CODE-POOL-ENDPOINT

  configmap:
    AZURE_STORAGE_ACCOUNT_NAME: "agkblobdevwesteu"
    TABLE_NAME: "codeAdapterFiles"
    CLEANUP_ENABLED: "true"

  monitoring:
    enabled: true
    livenessProbe:  { path: /healthz, port: 3112 }
    readinessProbe: { path: /readyz,  port: 3112 }

  resources:
    requests: { memory: "1Gi",  cpu: "250m" }
    limits:   { memory: "2Gi",  cpu: "1000m" }   # retain until stream/admission load proof

  ingress:
    enabled: false            # in-cluster only; /metrics and /healthz are unauthenticated
  autoscaling:
    enabled: false            # replicas are for availability; the pool is the throughput limit
```

> ⚠️ **Verify before merge: does `ct-shared-chart` render a pod label?** No `ct-shared-chart`
> service in this repo uses `podLabels` — only Traefik and gha-runner, which are different
> charts. Without `azure.workload.identity/use: "true"` **on the pod**, the webhook never
> injects `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_FEDERATED_TOKEN_FILE`,
> `DefaultAzureCredential` finds nothing, and **every execution fails 502**. Check with
> `helm template` or `argocd app diff` before merging. If the chart does not support it, the
> `aadServiceAccounts` mechanism in `common-namespace-resources` already knows how to mint an
> AAD-annotated ServiceAccount — but the pod label still has to come from somewhere.

**D3 · ArgoCD registration** — `infra/nonprod/argocd/projects/services.yaml`, **two edits, not
one** (the worker does exactly this at lines 46 and 156):

```yaml
# 1) exclude from the multi-source `services` generator (no per-service repo for values)
- path: 'agentic-karl/dev/services/agentic-karl-code-adapter'
  exclude: true

# 2) add to the `services-local` generator
- path: 'agentic-karl/dev/services/agentic-karl-code-adapter'
```

**D4 · App-side wiring** — `agentic-karl/dev/services/agentic-karl/values.yaml`. Env names
verified against `packages/api/src/auth/codeapi.ts`:

```yaml
configmap:
  KNAUF_CODE_EXECUTION_ENABLED: 'true'
  LIBRECHAT_CODE_BASEURL: 'http://agentic-karl-code-adapter.agentic-karl-dev.svc.cluster.local:80/v1'
  CODEAPI_AUTH_PROVIDER: 'librechat-jwt' # or "both"; anything else mints NO header
  CODEAPI_JWT_ALGORITHM: 'EdDSA'
  CODEAPI_JWT_KID: 'lc-codeapi-dev-2026-08'
  CODEAPI_JWT_ISSUER: 'agentic-karl'
  CODEAPI_JWT_AUDIENCE: 'codeapi'
  CODEAPI_JWT_SINGLE_TENANT_ID: 'knauf'
externalSecret:
  secrets:
    CODEAPI_JWT_PRIVATE_KEY: AGK-CODEAPI-JWT-PRIVATE-KEY
```

Two failure modes worth stating plainly, because neither produces an obvious error:

- **`kid` / `issuer` / `audience` must match the adapter's values exactly**, or every request
  401s with nothing but `unauthorized`.
- **The fail-closed guard checks operator intent and URL control, not JWT correctness.** Set the
  flag and URL but forget `CODEAPI_AUTH_PROVIDER`, and every execution 401s into "Execution
  error". Ship D4 as one atomic change.

**D5 · Network policy** — **there is something to do.** An earlier version of this doc said
"most likely nothing"; that was wrong, and wrong in the quiet direction.

Right: the adapter's _outbound_ needs nothing under the current nonproduction policy. Entra,
`*.dynamicsessions.io`, Blob, and Table are all HTTPS/443, which `allowEgressInternet` permits
namespace-wide; app→adapter is covered by `allowSameNamespace`.

Wrong: `agentic-karl/dev/network-policy/values.yaml` sets **`defaultDenyAll: true`**, and every
service in that namespace that wants to be scraped carries its _own_ `customPolicies` entry —
`allow-datadog-metrics-scrape` (app, 3000), `allow-datadog-worker-metrics-scrape` (worker,
3081), `allow-egress-rag-datadog` (rag-api). The adapter had none, so all six
`code_adapter_*` metrics were unreachable and a brand-new execution backend would have gone
into UAT blind. Added in #347:

```yaml
- name: allow-datadog-code-adapter-metrics-scrape
  spec:
    podSelector:
      matchLabels:
        app: agentic-karl-code-adapter
    policyTypes: [Ingress]
    ingress:
      - from:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: monitoring
        ports:
          - protocol: TCP
            port: 3112
```

**Ingress only, deliberately.** The adapter has no tracer: its dependencies are
`express`/`pino`/`prom-client`/`undici` plus the two Azure SDKs, it imports neither `dd-trace`
nor any OpenTelemetry SDK, and it reads no `DD_*`, `DATADOG_*` or `OTEL_*` variable. So there is
no APM or OTLP flow to permit and an egress rule would authorise traffic that does not exist —
which also means the `DATADOG_ENV`/`SERVICE`/`SITE` configmap entries are inert for this image
(harmless, left in place). If Datadog single-step instrumentation is ever switched on for this
pod, that is when an egress rule to `monitoring`/`datadog` becomes real.

`selfHeal + prune` means **merge = deploy**. Split D1–D3 (adapter only, inert) from D4 (the
switch) into two PRs if you want a checkpoint between "adapter is healthy" and "feature is on"
— recommended for the first rollout.

---

## Phase E — verification, in this order

Each step isolates one layer, so a failure tells you where to look.

```bash
# 1. Pod healthy and Table reachable
kubectl -n agentic-karl-dev get pods -l app=agentic-karl-code-adapter
kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- \
  wget -qO- localhost:3112/readyz

# 2. Workload identity actually landed. This single step answers BOTH chart unknowns —
#    whether `podLabels` renders, and whether the chart reads `serviceAccountName` or the
#    nested `serviceAccount.name` (the values set both, so this confirms one of them worked).
kubectl -n agentic-karl-dev get pod -l app=agentic-karl-code-adapter \
  -o jsonpath='{.items[0].spec.serviceAccountName}{"\n"}'
#    expect: sa-code-adapter    — if it prints `default` or nothing, neither SA key was
#    consumed and the federated credential (which trusts sa-code-adapter and nothing else)
#    cannot be used, so every ACA call will fail.

kubectl -n agentic-karl-dev get pod -l app=agentic-karl-code-adapter \
  -o jsonpath='{.items[0].metadata.labels}{"\n"}' | grep -o 'azure.workload.identity/use'
#    expect a match — this is the podLabels question. The webhook only mutates pods carrying
#    it, and without the mutation the three AZURE_ vars below are absent.

kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- \
  env | grep AZURE_       # expect AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
kubectl -n agentic-karl-dev logs deploy/agentic-karl-code-adapter | grep "Entra token acquired"
#    NOTE: that log line only appears after the first token request, which is lazy — see the
#    Phase 0 note. Absence here is not evidence of failure; the three env vars are.

# 3. Auth boundary: unauthenticated is rejected
kubectl -n agentic-karl-dev exec deploy/agentic-karl -- \
  curl -s -o /dev/null -w '%{http_code}\n' \
  -XPOST http://agentic-karl-code-adapter/v1/exec        # expect 401

# 4. End-to-end exec with a real token (mint with the dev private key)
curl -s -XPOST http://agentic-karl-code-adapter/v1/exec \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"lang":"py","code":"import pandas; print(pandas.__version__)"}'

# 5. Capability is live in the served config
kubectl -n agentic-karl-dev exec deploy/agentic-karl -- \
  curl -s localhost:3000/api/endpoints | grep -o 'execute_code'

# 6. Metrics are actually collected, not merely exposed (D5 + the annotation, both halves)
kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- \
  wget -qO- localhost:3112/metrics | grep code_adapter_          # exposed?
kubectl -n monitoring exec ds/datadog -- agent status \
  | grep -A5 'openmetrics'                                        # collected?
# If (6a) shows metrics and (6b) does not list this pod, the NetworkPolicy or the
# podAnnotations half is missing — they fail independently and both fail silently.

# 7. The drain is real, not decorative. Start a long exec, then delete the pod: it should
#    stay Terminating while the exec finishes, and the exec should still return 200.
kubectl -n agentic-karl-dev delete pod -l app=agentic-karl-code-adapter --wait=false
kubectl -n agentic-karl-dev logs -l app=agentic-karl-code-adapter --tail=20 \
  | grep -E 'draining in-flight|drain complete'
```

Then in the UI, in this order — each one exercises a different half of the feature:

- [ ] Attach a `.csv` → it routes to the code sandbox, **not** file search (check the file row).
- [ ] Ask a question about the data → the model runs code and answers from real column names.
- [ ] Ask for a chart → a PNG comes back as a **real download**, not an inline image.
- [ ] Ask for a spreadsheet → an `.xlsx` download.
- [ ] Attach a `.pdf` → still goes to file search (the tabular rule must not have caught it).
- [ ] Attach an `.xlsx`, ask KARL to edit a cell → the **edited** file comes back, not the
      original. (Covers the same-size-rewrite path, flat and nested — the baseline comparison
      is what makes an in-place edit detectable at all.)
- [ ] Agent builder → the **Execute code** capability row is present and toggles.
- [ ] Composer → **no** code-interpreter chip and no per-block Run button. Note
      `interface.runCode` is now **`true`**, not false: the permission is granted so the manual
      execution path is not dead code, and all three surfaces are hidden in the components by
      `KNAUF_HIDE_CODE_*`. Flipping the yaml flag alone changes nothing visible.
- [ ] Open an **existing** conversation that predates the spec change and attach a `.csv` → it
      should go to **file search**, not the sandbox. The client only offers the sandbox where
      the server would actually register the tool; if this routes to code, the destination gate
      has drifted from `packages/api/src/agents/load.ts`.

Finally, the capacity baseline from [scaling.md](scaling.md) §2 — run the 25-parallel-exec
test, record how many start and how many report "at capacity", wait for recovery, and record
the measured recovery time. **Write the result into scaling.md.** It is evidence for production
sizing; the configured limit of 20 is not itself a measured throughput result.

---

## Rollback, in escalating order

| Situation                        | Action                                                     | Blast radius                                                          |
| -------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Feature misbehaves, adapter fine | Set `KNAUF_CODE_EXECUTION_ENABLED=false` and roll app pods | Capability and code-dependent skills disappear; adapter stays dormant |
| Adapter unhealthy                | Scale the Deployment to 0                                  | Executions fail closed; the app keeps running                         |
| Bad adapter image                | Point the values digest at the previous proven manifest    | Exact rollback; tags are not deployment identity                      |
| Terraform wrong                  | Do **not** destroy the pool while sessions are live        | Prefer fixing forward                                                 |

**Immutable release rule:** every adapter PR must bump `VERSION`, publishing refuses an existing
tag, and GitOps pins the workflow-reported digest. A tag is only a human lookup key.

---

## Decisions someone has to make (not fixes — calls)

These are not blockers you can clear by doing work; they need a position taken. Two of the
three affect whether dev UAT is representative.

**1 · Metadata isolation — resolved.** The adapter uses `codeAdapterFiles` through a
table-scoped workload identity. It holds no Mongo or storage-account credential. Reusing the
application storage account leaves account-key holders with reverse access; that residual risk is
accepted and does not widen the adapter identity.

**2 · Spot affinity vs long executions.** The pod has a hard
`requiredDuringSchedulingIgnoredDuringExecution` affinity to spot nodes, copied verbatim from
the worker — so it is a platform pattern, not this service's choice. But Azure gives ~30s of
eviction notice and executions run for minutes, so **no `terminationGracePeriodSeconds` value
makes an evicted execution survivable**; the 360s in D2 only helps for rollouts and drains.
Softening to `preferred` is the only thing that changes the eviction story, and it costs
nothing on a cluster that has non-spot capacity. Someone owning the platform pattern should say
yes or no rather than leaving 360s implying a protection it does not provide.

**3 · Dependency readiness — implemented.** `/readyz` now caches bounded Table, Blob,
workload-identity token, and non-allocating ACA checks. Verify all four metric labels and failure
paths in the rollout; do not replace this with a code-executing readiness probe.

---

## Known gaps carried into dev

Not blockers for a dev rollout, but do not lose them:

- Input push and generated-output capture stream. Process-wide admission has no queue and bounds
  active requests plus aggregate metadata-backed input bytes. The 2 Gi limit and defaults still
  need representative maximum-stream concurrency evidence before production
  ([scaling.md](scaling.md) §3).
- Adapter-minted stateless sessions are explicitly deleted after capture with an independent
  timeout. The exact stage identity permission and observed pool recovery remain live rollout
  gates; failed cleanup still leaves the 300-second cooldown tail.
- ~~Session identity is not bound to the caller.~~ **Fixed** (`d6fad8068`). Every session id
  now carries an 8-hex owner tag derived from the caller's subject, so `/exec` only honours a
  supplied `session_id` bearing the caller's own tag, and `runtime_session_hint` derivation
  mixes in the user id. What remains: `SESSION_HINT_SECRET` is unset, so it falls back to the
  JWT public key. Ownership holds regardless (the check is against the caller's own identity),
  but a _predictable_ secret makes a hint-derived id guessable from a known conversation id —
  so **set a real `SESSION_HINT_SECRET` before enabling `statefulSessions`**. The adapter warns
  at boot while it is unset.
- Staged Blobs are reaped by reachability, not age (`ed7dcc043`). Table `expiresAt` slides on
  every use, so an age-based lifecycle rule would delete Blobs that are still referenced —
  hence the sweep in `src/store/reaper.ts` rather than a storage management policy. A lifecycle
  rule is still worth adding as a backstop for bytes whose Table transaction never landed; it is
  **not** in #73.
- The pod is pinned to **spot** nodes with a hard `requiredDuringScheduling` affinity. This is
  copied verbatim from the worker, so it is a platform pattern rather than this service's
  choice — but Azure gives ~30s of eviction notice against executions that run for minutes, so
  no `terminationGracePeriodSeconds` saves an evicted execution. `preferred` would cost nothing
  here and is worth arguing for before prod.
- Build publishing rejects an existing nonprod version tag. Production promotion resolves and
  imports the source digest, refuses an existing prod tag, and verifies exact digest equality.
- `agentic-karl-dev-MI-CODE-ADAPTER-CLIENT-ID` is published to Key Vault but cannot be consumed
  by ESO — the ServiceAccount annotation is rendered by Helm, not injected from a Secret. It
  stays a lookup convenience. `agentic-karl-dev-CODE-POOL-ENDPOINT` **is** consumable, and D2
  above consumes it.

---

## Prod

Not a copy of dev. Production infrastructure already contains its own 20-session pool and adapter
identity. Keep that limit unchanged until representative stage evidence supports a reviewed size;
there is no established 50-session requirement. Verify the production key material, promote the
image with `promote-code-adapter.yaml`, and deploy through a reviewed values change in
`agk-deployment-configs`.

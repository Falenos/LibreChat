# Code execution — infrastructure deployment runbook

Step-by-step deployment of the `code-adapter` + its ACA session pool to AGK,
across three repos. Ticket: **KK20-108**. This is the operational runbook; the
"why" is in [backend-decision.md](backend-decision.md) and
[placement-and-justification.md](placement-and-justification.md), and how the
service works is in [how-it-works.md](how-it-works.md). It supersedes the
code-interpreter half of the older
[artifacts + skills rollout plan](../implementation-plans/code-interpreter-artifacts-rollout.md).

> **Status:** the adapter is built and verified live against a spike pool in
> CT-SANDBOX. None of the AGK infra below is applied yet. Steps are
> dependency-ordered; do them top to bottom.

---

## 0. Verified environment (double-checked Aug 2026)

| Fact                                    | Value                                                                                                                                              | How verified                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Nonprod subscription                    | `ad3f0a71-cc5b-4d00-8289-23623cf2064c` (CT-SHARED-RESOURCES)                                                                                       | `az account list`                                                |
| Prod subscription                       | `e0515a24-7205-481b-b657-944901020e32`                                                                                                             | infra-context skill                                              |
| Tenant                                  | `ad200093-0cba-48cb-9853-16fb53354a4d`                                                                                                             | ESO values                                                       |
| AKS (nonprod / prod)                    | `aks-agk-nonprod-001` (`rg-agk-nonprod-westeurope`) / `aks-agk-prod-001` (`rg-agk-prod-westeurope`) — corrected; the `sxsx` names once written here exist nowhere | `agk-infrastructure` `locals.tf` (authoritative)                 |
| **AKS OIDC issuer + workload identity** | **both `enabled: true`** on nonprod and prod                                                                                                       | `az aks list` — the workload-identity prerequisite is met (S3 ✓) |
| ACR (nonprod / prod)                    | `acragkhubnonprod001` / `acragkhubprod001`                                                                                                         | infra-context skill, release pipeline                            |
| Key Vault (nonprod / prod)              | `kv-agntkarl-nonprod-001` / `kv-agntkarl-prod-001`                                                                                                 | ESO SecretStore values                                           |
| ESO                                     | SA `sa-external-secrets` (client `b573fdae-1009-46d4-8c58-16694e48f65f`), `SecretStore kv-agntkarl-nonprod-001`, `authType: WorkloadIdentity`      | `agentic-karl/dev/common-namespace-resources/values.yaml`        |
| Namespace                               | `agentic-karl-dev`                                                                                                                                 | GitOps repo                                                      |
| ct-shared-chart                         | worker pins `2.7.0` (use the newest a live service pins at PR time)                                                                                | worker `Chart.yaml`                                              |
| Egress policy                           | `defaultDenyAll` + `allowEgressInternet` (TCP 443/80, namespace-wide) + `allow-egress-private-endpoints` (`podSelector: {}`, CIDR `10.160.0.0/16`) | `agentic-karl/dev/network-policy/values.yaml`                    |

**Consequence for the adapter's egress (important):** the adapter's outbound is
all HTTPS/443 — Entra (`login.microsoftonline.com`), the dynamic-sessions
data-plane (`*.dynamicsessions.io`), and Azure Blob — which `allowEgressInternet`
**already permits namespace-wide**. Mongo is reached over the private-endpoint
policy (`podSelector: {}` applies to all pods). So **the adapter most likely
needs no new NetworkPolicy** — confirm only that Mongo's port is in the
private-endpoint allow-list (§3, verify item).

**Verify-before-apply** (small, front-loaded):

- **V1 — ct-shared-chart ServiceAccount rendering (S4).** Confirm the chart
  renders `serviceAccount.annotations` **and** stamps the pod label
  `azure.workload.identity/use: "true"` (`helm template` / `argocd app diff`).
  If it renders the annotation but not the label, add the label via the chart's
  pod-labels value or a vendored `templates/serviceaccount.yaml` (langfuse-clickhouse
  escape-hatch precedent). This is the one chart unknown.
- ~~**V2 — OIDC issuer URL**~~ **RESOLVED — there was nothing to look up.** The
  `agk-infrastructure` tenant root already declares `data "azurerm_kubernetes_cluster" "aks"`,
  so the federated credential references `data.azurerm_kubernetes_cluster.aks.oidc_issuer_url`
  directly, exactly as both ESO credentials do. Never hardcode the issuer.
- **V3 — Mongo egress**: confirm `MONGO_URI`'s host/port is covered by
  `allow-egress-private-endpoints` (the app already connects to Mongo from this
  namespace, so it almost certainly is); if not, add a `customPolicies` entry.

---

## 1. Ordering constraint

Merging GitOps before the image exists in ACR ⇒ `ImagePullBackOff`; before the
pool + identity exist ⇒ the pod boots but every `/exec` 502s. So:

```
build image → ACR   ─┐
Terraform (pool +    ─┼─→  GitOps deploy (merge = deploy)  →  wire LibreChat  →  flip capability
identity + KV key)   ─┘
```

---

## 2. agk-infrastructure — Terraform (Phase B) — SHIPPED for dev + stage

**Done: [agk-infrastructure#73](https://github.com/Knauf-Group/agk-infrastructure/pull/73)**
adds this for `dev` and `stage`. Prod is still to do (see §8). The block below is kept as
the reference contract, corrected against what the code actually validated — the original
draft of it was wrong in four ways, all of which are worth knowing before writing the prod
twin:

- **`dynamicPoolConfiguration` shape.** The flat `{ executionType, cooldownPeriodInSeconds }`
  is the *preview* schema. `2025-07-01` GA nests it under `lifecycleConfiguration` and
  renames `executionType` → `lifecycleType`. Caught by `terraform validate` with azapi
  schema validation on; most ACA blog posts still show the preview form.
- **Identity name.** `id-agk-code-adapter-nonprod` matches nothing in that repo. The
  tenant-root convention is
  `mi-${var.application_family}-<dev|stage>-${local.location}-aks-<purpose>-${var.kv_name_suffix}`
  → `mi-agentic-karl-dev-westeurope-aks-code-adapter-001`.
- **Cluster names.** `aks-sxsx-*` / `rg-sxsx-*` (below and in §1) appear nowhere in the
  infra repo. Real: `aks-agk-nonprod-001` in `rg-agk-nonprod-westeurope`.
- **The OIDC issuer was never an unknown** (V2). The tenant root already has
  `data "azurerm_kubernetes_cluster" "aks"`, so the credential just uses
  `data.azurerm_kubernetes_cluster.aks.oidc_issuer_url`, as both ESO credentials do.

Also: `azapi` is already declared in that root (pinned `>= 2.0, < 2.9.0` → resolves 2.8.0,
which does embed the `2025-07-01` sessionPools schema), so **leave
`schema_validation_enabled` alone** — switching it off is what would have let the preview
shape through to ARM.

```hcl
# Session pool — Microsoft.App/sessionPools, mgmt api-version 2025-07-01 (GA)
resource "azapi_resource" "code_pool" {
  type      = "Microsoft.App/sessionPools@2025-07-01"
  name      = "sp-agentic-karl-dev-westeurope-001"
  location  = "westeurope"
  parent_id = <tenant-nonprod resource group id>   # rg-agentic-karl-tenant-nonprod-westeurope
  body = {
    properties = {
      poolManagementType   = "Dynamic"
      containerType        = "PythonLTS"            # has bash + python3 + pandas/numpy/matplotlib
      scaleConfiguration   = { maxConcurrentSessions = 20 }
      # GA shape — NOT the preview `{ executionType, cooldownPeriodInSeconds }`.
      dynamicPoolConfiguration = {
        lifecycleConfiguration = { lifecycleType = "Timed", cooldownPeriodInSeconds = 300 }
      }
      sessionNetworkConfiguration = { status = "EgressDisabled" }
    }
  }
}

# User-assigned managed identity for the adapter pod
resource "azurerm_user_assigned_identity" "code_adapter" {
  name                = "mi-agentic-karl-dev-westeurope-aks-code-adapter-001"
  resource_group_name = <tenant-nonprod rg>
  location            = "westeurope"
}

# Federated credential: trust the adapter's k8s ServiceAccount
resource "azurerm_federated_identity_credential" "code_adapter" {
  name                = "sa-code-adapter-dev-001"
  resource_group_name = <tenant-nonprod rg>
  parent_id           = azurerm_user_assigned_identity.code_adapter.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = data.azurerm_kubernetes_cluster.aks.oidc_issuer_url
  subject             = "system:serviceaccount:agentic-karl-dev:sa-code-adapter"
}

# Data-plane role: let the identity execute code in the pool
resource "azurerm_role_assignment" "session_executor" {
  scope                = azapi_resource.code_pool.id
  role_definition_name = "Azure ContainerApps Session Executor"
  principal_id         = azurerm_user_assigned_identity.code_adapter.principal_id
}
```

**Key Vault** — one new secret for LibreChat's side of the JWT trust (the
adapter itself needs **no** pool credential — workload identity is the win):

```bash
openssl genpkey -algorithm ed25519 -out lc-codeapi-dev.key       # private (LibreChat signs)
openssl pkey -in lc-codeapi-dev.key -pubout -out lc-codeapi-dev.pub   # public (adapter verifies)
az keyvault secret set --vault-name kv-agntkarl-nonprod-001 \
  --name AGK-CODEAPI-JWT-PRIVATE-KEY --file lc-codeapi-dev.key
# keep lc-codeapi-dev.pub — it becomes a ConfigMap value in §3 (public, not secret)
```

Terraform outputs to consume downstream: `code_pool` management endpoint (the
`poolManagementEndpoint` property), and `id-agk-code-adapter-nonprod`'s
`clientId`.

---

## 3. agk-deployment-configs — GitOps service (Phase C)

Cloned locally. Add a single-source service `agentic-karl-code-adapter`, modeled
on `agentic-karl-worker`.

**`agentic-karl/dev/services/agentic-karl-code-adapter/Chart.yaml`** — wrapper on
ct-shared-chart (match the newest version a live service pins):

```yaml
apiVersion: v2
name: agentic-karl-code-adapter
type: application
version: 0.1.0
dependencies:
  - name: ct-shared-chart
    alias: agentic-karl-code-adapter
    version: '2.7.0' # confirm newest at PR time
    repository: oci://acrctshared001.azurecr.io/helm
```

**`.../values.yaml`** — the essentials (mirror the worker triad + the two lines
that make it AGK's first workload-identity app pod):

```yaml
agentic-karl-code-adapter:
  namespace: agentic-karl-dev
  replicaCount: 2
  image:
    repository: acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl-code-adapter
    tag: '0.1.0' # = knauf/code-adapter/VERSION; CI must have pushed it first
    pullPolicy: Always
  service:
    type: ClusterIP
    port: 80
    targetPort: 3112
  serviceAccount:
    create: true
    name: sa-code-adapter
    annotations:
      azure.workload.identity/client-id: '<id-agk-code-adapter-nonprod clientId>'
  podLabels:
    azure.workload.identity/use: 'true' # V1: confirm the chart stamps this; else vendor the SA template
  # usernpool/spot triad + probes, matching the worker
  envConfig:
    - name: ACA_POOL_ENDPOINT
      value: '<code_pool poolManagementEndpoint>'
    - name: ACA_API_VERSION
      value: '2024-02-02-preview'
    - name: CODEAPI_JWT_ISSUER
      value: 'agentic-karl'
    - name: CODEAPI_JWT_AUDIENCE
      value: 'codeapi'
    - name: CODEAPI_JWT_KID
      value: 'lc-codeapi-dev-2026-08'
    - name: CODEAPI_JWT_PUBLIC_KEY # public half — safe in values/ConfigMap
      value: |
        -----BEGIN PUBLIC KEY-----
        ...lc-codeapi-dev.pub...
        -----END PUBLIC KEY-----
  envFrom:
    - secretRef:
        name: agentic-karl-code-adapter-secrets
```

**ExternalSecret** for the adapter's two runtime secrets — add to
`agentic-karl/dev/common-namespace-resources/values.yaml` under
`externalSecrets.externalSecrets[]` (same pattern as `agentic-karl-metrics-secret`):
`MONGO_URI` from the existing `agentic-karl-MONGODB-CONNECTION-STRING` KV entry
and `AZURE_STORAGE_CONNECTION_STRING` from `agentic-karl-BLOB-STORAGE-CONNECTION-STRING`,
targeting a k8s secret `agentic-karl-code-adapter-secrets`. (Both KV entries
already exist — the app uses them.)

**Workload-identity SA + AZURE\_ vars:** the SA annotation + pod label above are
all that's needed; the workload-identity webhook injects `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, and `AZURE_FEDERATED_TOKEN_FILE` into the pod, which
`DefaultAzureCredential` consumes. We set none of those by hand.

**Network:** per §0, `allowEgressInternet` (443) + the private-endpoint policy
already cover the adapter — add a `customPolicies` entry only if V3 shows Mongo's
port isn't allowed.

**ApplicationSet registration** (`infra/nonprod/argocd/projects/services.yaml`,
same PR — langfuse precedent):

1. **Exclude** from the multi-source `services` set:
   ```yaml
   - path: 'agentic-karl/dev/services/agentic-karl-code-adapter'
     exclude: true
   ```
2. **Add** to the `services-local` set's `directories`:
   ```yaml
   - path: 'agentic-karl/dev/services/agentic-karl-code-adapter'
   ```

`selfHeal + prune` ⇒ **merge to `main` = deploy**.

---

## 4. Wire LibreChat + JWT trust (Phase D, values-only)

In the agentic-karl app values (dev), add the LibreChat side of the trust and
point it at the adapter:

- `LIBRECHAT_CODE_BASEURL=http://agentic-karl-code-adapter.agentic-karl-dev.svc.cluster.local:80/v1`
  (the ClusterIP service port; it targets the pod's 3112).
- `CODEAPI_AUTH_PROVIDER=librechat-jwt`
- `CODEAPI_JWT_PRIVATE_KEY` ← ExternalSecret from `AGK-CODEAPI-JWT-PRIVATE-KEY`
- `CODEAPI_JWT_ALGORITHM=EdDSA`, `CODEAPI_JWT_KID=lc-codeapi-dev-2026-08`,
  `CODEAPI_JWT_ISSUER=agentic-karl`, `CODEAPI_JWT_AUDIENCE=codeapi`,
  `CODEAPI_JWT_SINGLE_TENANT_ID=knauf`

The `kid`/`issuer`/`audience` must match the adapter's ConfigMap values (§3)
exactly, or JWT verification 401s.

> `LIBRECHAT_CODE_BASEURL` is read once at module load by `@librechat/agents`, so
> it must be in the pod env before boot — a values change + rollout satisfies this.

---

## 5. Flip the capability (Phase E) — ALREADY MERGED

**This step is done in code.** KK20-257 landed it rather than leaving it as a
follow-up, so there is nothing to edit here — but read this section before you
deploy, because the ordering constraint it used to enforce still applies.

What is already committed:

- `librechat.yaml`: `execute_code` is in `endpoints.agents.capabilities`, and
  `executeCode: true` is on all four user-facing specs (`karl` plus the three
  personalities — the parity rule in that file). `interface.runCode: false` is
  **kept** (KK20-252): execution is agent auto-run only, with no composer chip, no
  tools-menu row and no manual Run button.
- Both code-execution skills ship from `skill/`, and
  `KNAUF_EXPECTED_DEPLOYMENT_SKILLS` lists them.
- Tabular attachments (`.xlsx`/`.csv`/`.json`) route to the sandbox instead of the
  RAG corpus, and the attach-menu row reads "Upload file changes".

**The ordering constraint, restated as a deploy gate.** Because `librechat.yaml` is
baked into the image and stage/prod are re-tags of the dev image, the capability
travels with the release. It is safe only because it is inert without a configured
adapter: `packages/api/src/knauf/code/codeEnvGuard.ts` strips `execute_code` unless
`LIBRECHAT_CODE_BASEURL` names a host we control. So:

- Deploy §1–4 (pool, workload identity, adapter, `LIBRECHAT_CODE_BASEURL`) **first**.
  Until then the release is a no-op for code execution — users see no code tool and
  no broken chip, and no file is sent anywhere.
- After §1–4, code execution turns itself on. There is no second PR to merge, so
  §6's verification is the real gate.

---

## 6. Verification (in dev, in order)

```bash
# pod up + workload identity acquired a token
kubectl -n agentic-karl-dev get pods -l app=agentic-karl-code-adapter
kubectl -n agentic-karl-dev logs deploy/agentic-karl-code-adapter | grep "Entra token acquired"
kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- wget -qO- localhost:3112/readyz

# from the app pod: authed exec works, unauthed is rejected
#   (mint a test JWT with the dev private key, or drive it from the UI)
curl -s $ADAPTER/v1/exec -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"lang":"py","code":"import pandas;print(pandas.__version__)"}'   # -> code:0
curl -s -o /dev/null -w '%{http_code}\n' $ADAPTER/v1/exec -d '{"lang":"py","code":"print(1)"}'  # -> 401

# capability live after the flip
curl -s localhost:3080/api/endpoints | jq '.agents.capabilities'   # includes execute_code
```

Then **UAT in the browser as ADMIN**: an agent with Code Interpreter enabled
runs `bash_tool` → a `python3` pandas analysis (the flow that failed before) →
returns results; attach a CSV → describe() → plot → PNG renders; a >5-min gap
between two execs transparently re-mints the session.

---

## 7. Rollback (in escalating order)

1. **Fast off-switch:** unset `LIBRECHAT_CODE_BASEURL` (values change) — code
   execution stops and nothing else moves.

   > **This step used to be wrong, and dangerously so.** Unsetting the variable does
   > *not* stop `@librechat/agents`: it computes
   > `LIBRECHAT_CODE_BASEURL ?? 'https://api.librechat.ai/v1'`, so an unset value
   > silently redirects code execution — and every attached file — to LibreChat's
   > **hosted SaaS**. An operator following the old wording during an incident would
   > have caused the data egress they were trying to prevent.
   >
   > KK20-257 made the step behave as written:
   > `packages/api/src/knauf/code/codeEnvGuard.ts` treats "unset, unparseable, or
   > `api.librechat.ai`" as *not configured* and strips the `execute_code` capability,
   > which switches off the upload gate, the attach-menu row, tabular auto-routing and
   > tool registration together. Nothing is sent anywhere. Do not remove that guard as
   > "redundant" — it is what makes this line true.

2. Revert the capability flip PR (a release).
3. Revert the GitOps PR (removes the service). The pool costs ~nothing idle.
4. Compromise: rotate `AGK-CODEAPI-JWT-PRIVATE-KEY` in KV + the adapter's public
   key ConfigMap.

---

## 8. Prod promotion (after dev UAT)

**What is already prepared in this repo.** The app-side work is done and env-agnostic —
there is no separate "enable it in prod" code change to write:

- `librechat.yaml` carries the capability, `executeCode: true` on all four user-facing
  specs, and the prompt wording. It is baked into the image and byte-identical across
  envs, so prod gets it from the normal release. Only env vars differ.
- **What keeps that safe in prod is `LIBRECHAT_CODE_BASEURL`.** Until prod sets it to the
  prod adapter, `packages/api/src/knauf/code/codeEnvGuard.ts` strips `execute_code`, so
  prod users see no code tool, no attach-menu row, no tabular routing — and no file is
  sent anywhere. The capability shipping ahead of the infra is therefore inert, not
  broken. Do not "pre-set" that variable to anything else to silence a log line.
- Image promotion: **`.github/workflows/promote-code-adapter.yaml`** (`workflow_dispatch`,
  tag + confirm) imports `acragkhubnonprod001 → acragkhubprod001`. It is a separate
  workflow rather than a step in `promote_pipeline.yaml` because the adapter versions from
  `knauf/code-adapter/VERSION` independently of KARL's `vX.Y.Z` tag; coupling them would
  force a full app promotion for a code-adapter hotfix. It only publishes the tag — the
  rollout is the values bump below.

**What is still outside this repo** (nothing here can do it):

- Terraform (`agk-infrastructure`): `sp-agk-code-prod` + `id-agk-code-adapter-prod`
  (federated subject `system:serviceaccount:agentic-karl-prod:sa-code-adapter`), Session
  Executor role on the pool, `maxConcurrentSessions: 50`;
  `AGK-CODEAPI-JWT-PRIVATE-KEY` in `kv-agntkarl-prod-001`.
- GitOps (`agk-deployment-configs`): copy the dev service dir to
  `agentic-karl/prod/services/agentic-karl-code-adapter`, swapping ACR / KV / namespace /
  UAMI clientId / pool endpoint; mirror the ApplicationSet exclude+add for prod. Then set
  `LIBRECHAT_CODE_BASEURL` in the prod `agentic-karl` values — that is the switch that
  actually turns prod on.

> **Ordering, and the current state.** As of this writing the adapter has **no service
> directory in any environment** — not dev, not stage, not prod — so dev deployment (§1–4)
> genuinely comes first; prod is two steps out. The order that matters is always the same:
> pool + identity → adapter running → `LIBRECHAT_CODE_BASEURL` → verify. The capability is
> already there and waiting, harmlessly.

---

## 9. Open verification items (carry into the PRs)

- **V1** ct-shared-chart renders the SA annotation **and** the WI pod label
  (else vendor the SA template).
- **V2** exact OIDC issuer URL for the federated credential.
- **V3** Mongo egress covered by the existing private-endpoint policy.
- Prod SP credentials for ACR import / KV writes verified separately (infra-context
  skill flags nonprod is proven, prod is not).

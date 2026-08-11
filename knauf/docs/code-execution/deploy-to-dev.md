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

| Repo | What it contributes | State |
| --- | --- | --- |
| `Knauf-Group/agentic-karl` | The adapter source, the CI that builds its image, the capability flip | **PR #258 open** — `main` merged in (`b33d29c34`); review round 2 addressed |
| `Knauf-Group/agk-infrastructure` | ACA session pool, managed identity, federated credential, role assignment, KV secrets | **PR #73 open** — plan green (12 add / 0 change / 0 destroy), all checks pass, waiting on approval. Untouched since 2026-08-06 |
| `Knauf-Group/agk-deployment-configs` | The adapter Deployment/Service/SA, ArgoCD registration, and the app-side env wiring | **PR #347 open** — adapter only, deliberately inert; the app-side wiring is a second PR. Repo is busy (five app version bumps merged on 08-11 alone), so re-check `ct-shared-chart` and the ApplicationSet line numbers at merge time |

**Exactly one hard unknown remains** (everything else below is sequencing you control): whether
`ct-shared-chart` 2.15.0 renders `podLabels`. See the blocker in Phase D. It cannot be answered
from the repos — the chart is an OCI artifact in a private ACR — and if the answer is no, every
execution fails 502.

---

## Ordering constraints (the three that actually bite)

1. **Terraform before GitOps.** The GitOps values need the MI client id and the pool
   endpoint, and both are Terraform outputs.
2. **#258 must merge before the adapter image exists.** `build-code-adapter.yaml` is not on
   `main` yet, so **`workflow_dispatch` is not available** — `gh workflow list` does not show
   it. The first image is produced by the `push: branches: [main], paths: knauf/code-adapter/**`
   trigger when #258 merges. A GitOps PR pointing at a tag that was never built leaves the pod
   in `ImagePullBackOff`.
3. **The capability flip is inert until the base URL points at the adapter.** `librechat.yaml`
   already lists `execute_code`, but `codeEnvGuard.ts` strips it unless
   `LIBRECHAT_CODE_BASEURL` names a host we control. So #258 can merge and reach dev without
   turning anything on — the feature goes live in Phase E, not before.

---

## Phase 0 — before anything merges

- [ ] **#73:** add the missing tag lifecycle to both `azapi_resource.code_pool_*`:
      ```hcl
      lifecycle {
        ignore_changes = [tags["ACM"], tags["CostCenter"]]
      }
      ```
      Every other tagged resource in that root (`rg.tf`, `mi-dev.tf`, the KV secrets in
      `blob-dev.tf`) carries it because policy stamps those two tags. The plan shows *0 to
      change* only because these are new resources — the drift appears on the next plan, and
      then every apply tries to strip a policy-applied `CostCenter`.
- [x] **#258:** the `/download` stream-error handler — **done** (`1666f852b`). `pipeline()`
      instead of `.pipe()`, plus the floating `repo.touch()` caught. Either one exited the
      process, on the path every generated chart and spreadsheet is served over.
- [x] **#258:** `main` merged in (`b33d29c34`) and the review round-2 findings addressed
      (`d6fad8068`, `ed7dcc043`) — sandbox ownership, capture time budget, drain, upload count
      cap, the code-env allowlist, the destination-gate invariant, and the CI test gate.
- [ ] Get #73 approved — it is blocked on review, nothing technical.
- [ ] **Answer the `podLabels` question before #347 merges.** This is the only step that can
      still make the whole rollout a no-op, and it needs registry auth rather than a repo read:
      ```bash
      helm registry login acrctshared001.azurecr.io
      helm template agentic-karl/dev/services/agentic-karl-code-adapter \
        | grep -A5 'kind: Deployment' | grep -i 'workload.identity'
      ```

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
- [ ] Record the two values the next phase needs:
      ```bash
      terraform output code_adapter_dev_client_id            # → SA annotation
      terraform output code_pool_dev_management_endpoint     # → ACA_POOL_ENDPOINT
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

## Phase C — merge #258 and confirm the image

- [ ] Merge #258. The push trigger builds `VERSION` (`0.1.0`) into the AGK hub ACR.
- [ ] Verify the tag actually landed (the workflow's own last step does this, but check):
      ```bash
      az acr repository show-tags -n acragkhubnonprod001 \
        --repository agentic-karl-dev/agentic-karl-code-adapter -o tsv
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
    tag: "0.1.0"            # = knauf/code-adapter/VERSION; Phase C must have pushed it
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
      MONGO_URI: agentic-karl-MONGODB-CONNECTION-STRING
      AZURE_STORAGE_CONNECTION_STRING: agentic-karl-BLOB-STORAGE-CONNECTION-STRING
      ACA_POOL_ENDPOINT: agentic-karl-dev-CODE-POOL-ENDPOINT

  monitoring:
    enabled: true
    livenessProbe:  { path: /healthz, port: 3112 }
    readinessProbe: { path: /readyz,  port: 3112 }

  resources:
    requests: { memory: "1Gi",  cpu: "250m" }
    limits:   { memory: "2Gi",  cpu: "1000m" }   # NOT 1Gi — capture buffers whole files

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
    LIBRECHAT_CODE_BASEURL: "http://agentic-karl-code-adapter.agentic-karl-dev.svc.cluster.local:80/v1"
    CODEAPI_AUTH_PROVIDER: "librechat-jwt"   # or "both"; anything else mints NO header
    CODEAPI_JWT_ALGORITHM: "EdDSA"
    CODEAPI_JWT_KID: "lc-codeapi-dev-2026-08"
    CODEAPI_JWT_ISSUER: "agentic-karl"
    CODEAPI_JWT_AUDIENCE: "codeapi"
    CODEAPI_JWT_SINGLE_TENANT_ID: "knauf"
  externalSecret:
    secrets:
      CODEAPI_JWT_PRIVATE_KEY: AGK-CODEAPI-JWT-PRIVATE-KEY
```

Two failure modes worth stating plainly, because neither produces an obvious error:

- **`kid` / `issuer` / `audience` must match the adapter's values exactly**, or every request
  401s with nothing but `unauthorized`.
- **The fail-closed guard only checks the base URL.** Set `LIBRECHAT_CODE_BASEURL` but forget
  `CODEAPI_AUTH_PROVIDER` and the capability switches on, no `Authorization` header is minted,
  and every execution 401s into "Execution error". Ship D4 as one atomic change.

**D5 · Network policy** — **there is something to do.** An earlier version of this doc said
"most likely nothing"; that was wrong, and wrong in the quiet direction.

Right: the adapter's *outbound* needs nothing. Entra, `*.dynamicsessions.io` and Blob are all
HTTPS/443, which `allowEgressInternet` permits namespace-wide; Mongo goes over
`allow-egress-private-endpoints` (`podSelector: {}`, 10.160.0.0/16, includes 443 and 10260);
and app→adapter is covered by `allowSameNamespace`.

Wrong: `agentic-karl/dev/network-policy/values.yaml` sets **`defaultDenyAll: true`**, and every
service in that namespace that wants to be scraped carries its *own* `customPolicies` entry —
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
# 1. Pod healthy and Mongo reachable
kubectl -n agentic-karl-dev get pods -l app=agentic-karl-code-adapter
kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- \
  wget -qO- localhost:3112/readyz

# 2. Workload identity actually landed (the podLabels question, answered empirically)
kubectl -n agentic-karl-dev exec deploy/agentic-karl-code-adapter -- \
  env | grep AZURE_       # expect AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
kubectl -n agentic-karl-dev logs deploy/agentic-karl-code-adapter | grep "Entra token acquired"

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
test, confirm roughly 20 succeed and the rest report "at capacity", wait 5 minutes, confirm
recovery. **Write the measured number into scaling.md.** It is the input to prod sizing.

---

## Rollback, in escalating order

| Situation | Action | Blast radius |
| --- | --- | --- |
| Feature misbehaves, adapter fine | Remove `LIBRECHAT_CODE_BASEURL` from the app values | Capability strips itself; nothing else changes |
| Adapter unhealthy | Scale the Deployment to 0 | Executions fail closed; the app keeps running |
| Bad adapter image | Point the values tag at the previous version | Requires a previous tag to exist — see the mutable-tag caveat below |
| Terraform wrong | Do **not** destroy the pool while sessions are live | Prefer fixing forward |

**Mutable-tag caveat:** a merge to `main` that touches `knauf/code-adapter/**` without bumping
`VERSION` silently rebuilds and replaces the existing tag in ACR. Because the values pin that
same string, ArgoCD sees no change and the cluster keeps the old image until some unrelated
restart pulls the new one — and rollback-by-tag then has nothing distinct to roll back to.
**Bump `VERSION` in every PR that touches the adapter.**

---

## Known gaps carried into dev

Not blockers for a dev rollout, but do not lose them:

- Adapter memory: input push and output capture both buffer whole files, with no queue. Hence
  the 2 Gi limit and the lowered `CAPTURE_MAX_TOTAL_BYTES` above. The durable fix is to stream
  capture into Blob — worth doing before prod ([scaling.md](scaling.md) §3).
- Pool throughput is ~4 executions/minute sustained across all users at
  `maxConcurrentSessions: 20` — which works out to roughly **4 people doing data analysis in the
  same five-minute window**, because a user five steps into an analysis holds five slots at once
  ([scaling.md](scaling.md) §2). Comfortable for a handful of UAT testers; the number to
  re-measure and re-size before any wider audience.
- ~~Session identity is not bound to the caller.~~ **Fixed** (`d6fad8068`). Every session id
  now carries an 8-hex owner tag derived from the caller's subject, so `/exec` only honours a
  supplied `session_id` bearing the caller's own tag, and `runtime_session_hint` derivation
  mixes in the user id. What remains: `SESSION_HINT_SECRET` is unset, so it falls back to the
  JWT public key. Ownership holds regardless (the check is against the caller's own identity),
  but a *predictable* secret makes a hint-derived id guessable from a known conversation id —
  so **set a real `SESSION_HINT_SECRET` before enabling `statefulSessions`**. The adapter warns
  at boot while it is unset.
- Staged blobs are now reaped by reachability, not age (`ed7dcc043`). The Mongo TTL slides on
  every use, so an age-based lifecycle rule would delete blobs that are still referenced —
  hence the sweep in `src/store/reaper.ts` rather than a storage management policy. A lifecycle
  rule is still worth adding as a backstop for bytes whose Mongo row never landed; it is
  **not** in #73.
- The pod is pinned to **spot** nodes with a hard `requiredDuringScheduling` affinity. This is
  copied verbatim from the worker, so it is a platform pattern rather than this service's
  choice — but Azure gives ~30s of eviction notice against executions that run for minutes, so
  no `terminationGracePeriodSeconds` saves an evicted execution. `preferred` would cost nothing
  here and is worth arguing for before prod.
- Nonprod image tags are mutable (`az acr build` overwrites) while `promote-code-adapter.yaml`
  deliberately refuses `--force`. So a rebuilt `0.1.0` in nonprod can differ from `0.1.0` in
  prod with nothing surfacing the divergence. Bump `VERSION` every time; consider promoting by
  digest before prod.
- `agentic-karl-dev-MI-CODE-ADAPTER-CLIENT-ID` is published to Key Vault but cannot be consumed
  by ESO — the ServiceAccount annotation is rendered by Helm, not injected from a Secret. It
  stays a lookup convenience. `agentic-karl-dev-CODE-POOL-ENDPOINT` **is** consumable, and D2
  above consumes it.

---

## Prod

Not a copy of dev. `terraform/subscription/prod/tenant/agentic-karl/` needs its own pool
(`maxConcurrentSessions` sized from the dev measurement, not inherited), its own identity in
the `agentic-karl-prod` namespace, its own keypair in `kv-agntkarl-prod-001`, and the image
promoted with `promote-code-adapter.yaml`. That workflow only makes the tag available — the
prod rollout is a values bump in `agk-deployment-configs`, reviewed like any other service.

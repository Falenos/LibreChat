---
name: agk-infra-context
description: Use when working on Agentic Karl / AGK infrastructure, architecture maps, dependency/onboarding docs, Azure CLI access, AKS, ArgoCD, Key Vault, ExternalSecret, Terraform resources, Helm values, deployment-config repos, release pipelines, adding services, choosing infra ownership/state/workflows, or debugging dev/prod deployment behavior for this fork.
---

# AGK Infra Context

This skill is the operational map for Agentic Karl infrastructure. Use it before changing deployment workflows, Azure resources, Key Vault secrets, ArgoCD apps, Helm values, or environment config.

Last verified: 2026-07-14.

## Operating Rules

- Start by checking the current branch and the current Azure subscription. The Azure CLI default can be nonprod or prod depending on the last human command.
- Prefer GitOps and Terraform repo changes over live mutations. Live Azure/Kubernetes/Argo changes are for validation, emergency repair, or secret rotation.
- Do not print or store secret values. Inspect metadata, names, IDs, update timestamps, enabled status, and mappings instead.
- Before mutating ArgoCD or Kubernetes, run read-only checks and/or dry-runs first.
- Use `argocd ... --grpc-web` for `argocd.agk.nonprod.knauf.digital`; keep using it for AGK ArgoCD unless verified otherwise.
- For Key Vault rotations consumed as pod env vars, update Key Vault, refresh ExternalSecret, then restart the Deployment so pods reload env.
- Do not run `terraform init`, `plan`, or `apply` locally against remote state. Infra repo READMEs say CI/CD owns Terraform state access. Local Terraform is for syntax validation only.
- Before changing AGK deploy workflow logic, use `.github/workflows/agk-deploy-smoke.yaml` to validate Azure login, Key Vault reads, GitHub writes, ACR import, deployment-config repo writes, and ArgoCD API access without waiting for the full release pipeline.
- Before adding a Terraform root, backend key, GitHub workflow, or pipeline state, prove that no existing root/workflow owns the resource. Default to the smallest existing layer that owns the lifecycle.
- For external providers such as Datadog, do not create a separate root/workflow just because the provider is not Azure. State ownership follows the app/platform lifecycle, not the vendor.

### Azure Model Router request invariant

Verified in dev on 2026-08-11:

- `model-router-chat` selects from heterogeneous Foundry model deployments. A request option is safe only when every router candidate accepts the same option and value.
- Never add `verbosity` to the default KARL model spec, Azure endpoint defaults, agent parameters, or the resulting Responses request without an end-to-end compatibility test against every configured candidate.
- In particular, `verbosity: low` becomes `text.verbosity: low` and has repeatedly caused Foundry HTTP 400 `unsupported_value` failures before tools such as `image_gen_oai` can run. It is not a latency optimization for this router.
- Keep concise behavior in the shared KARL prompt. Keep the provider-side `maxTokens: 8192` safety fuse unless production truncation evidence justifies a reviewed change.
- `maxTokens` maps to Responses `max_output_tokens` and covers reasoning plus visible output. AGK detects an output-limit stop and uses the existing same-provider fallback for one retry with a complete, compact replacement instruction. The failed partial text or tool call is removed before persistence. If the bounded retry also reaches the cap, the turn fails instead of saving a truncated answer.
- A larger cap such as 24k increases the worst-case token cost, latency, and context reserve threefold. Do not raise it to compensate for an incompatible request parameter.

## Architecture Reference

For full top-down architecture, dependency maps, onboarding handoffs, or README updates, read `$KNAUF_ROOT/agentic-karl/knauf/docs/reference/agentic-karl-architecture.md` after fetching the latest main branches for `agentic-karl`, `agentic-karl-rag-api`, `agk-infrastructure`, and `agk-deployment-configs`.

Treat that README as a shareable architecture snapshot, not a substitute for live state. Verify mutable facts such as image tags, domains, secrets mappings, Azure resources, ArgoCD health, and model deployments in the owning repo or cloud service before answering "current" or "latest" questions.

Do not duplicate the full README into this skill. Keep this skill as the workflow and safety guide; use the README as reference material loaded only when architecture context is needed.

### File Search Storage Invariant

Verified against `agentic-karl` and `agentic-karl-rag-api` on 2026-07-16:

- Azure Blob Storage holds the original bytes for chat files, Agent Knowledge, and images. Blob storage is not a vector-search backend.
- A document uploaded from a conversation is a user-owned `message_attachment` and is embedded in PostgreSQL/pgvector, even while the user is chatting with a persistent agent.
- A document uploaded through the persistent agent builder is agent-owned Agent Knowledge and is embedded in Azure AI Search when `AZURE_SEARCH_ENABLED=true`.
- An agent run may need both sources. The single `file_search` tool can query the agent's Azure AI Search knowledge and the user's pgvector conversation uploads in the same run.
- Images never enter `file_search`; they remain message-scoped multimodal attachments.
- Do not infer vector ownership from the active chat endpoint or from the mere presence of an `agent_id`. Use the file's persisted context and membership in `agent.tool_resources.file_search.file_ids`.

Current compatibility caveat: with `AZURE_SEARCH_ENABLED=false`, the application falls Agent Knowledge back to pgvector. AGK environments are expected to enable Azure AI Search; treat the fallback as implementation compatibility, not the target architecture.

Azure AI Search infrastructure ownership:

| Env | Search service | Terraform owner | Runtime wiring |
|---|---|---|---|
| Dev/nonprod | `agentic-karl-search-dev` | `agk-infrastructure/terraform/subscription/nonprod/tenant/agentic-karl/search-dev.tf` | app `AZURE_SEARCH_ENABLED=true`; RAG `AZURE_SEARCH_ENDPOINT=https://agentic-karl-search-dev.search.windows.net` |
| Prod | `agentic-karl-search-prod` | `agk-infrastructure/terraform/subscription/prod/tenant/agentic-karl/search.tf` | app `AZURE_SEARCH_ENABLED=true`; RAG `AZURE_SEARCH_ENDPOINT=https://agentic-karl-search-prod.search.windows.net` |

Both services are private, Basic SKU, and exposed to the RAG workload through private endpoints/DNS. Terraform writes `agentic-karl-AZURE-SEARCH-API-KEY` to the tenant Key Vault; the RAG service ExternalSecret maps it to `AZURE_SEARCH_API_KEY`. The endpoint and mapping live in `agk-deployment-configs/agentic-karl/<env>/services/agentic-karl-rag-api/values.yaml`; the app-side enable flag lives in the adjacent `agentic-karl/values.yaml`.

Do not conflate Azure AI Search with Azure OpenAI/Foundry model inference, Azure OpenAI content filters, Azure Blob Storage, or Azure AI Document Intelligence. A Prompt Shield error is a model-inference failure, not evidence that a chat file was indexed in Azure AI Search.

Detailed ingestion, retrieval, mixed-backend, deletion, and citation behavior lives in `$KNAUF_ROOT/agentic-karl/knauf/docs/architecture/files/rag-search.md` and the top-down snapshot linked above.

## Repos

Use the same repo names regardless of local checkout path. In examples, set `KNAUF_ROOT` to the directory that contains the Knauf repos:

```bash
export KNAUF_ROOT="${KNAUF_ROOT:-$HOME/knauf}"
```

- App repo: `Knauf-Group/agentic-karl` (`$KNAUF_ROOT/agentic-karl`)
- RAG API repo: `Knauf-Group/agentic-karl-rag-api` (`$KNAUF_ROOT/agentic-karl-rag-api`)
- AGK Terraform repo: `Knauf-Group/agk-infrastructure` (`$KNAUF_ROOT/agk-infrastructure`)
- AGK GitOps repo: `Knauf-Group/agk-deployment-configs` (`$KNAUF_ROOT/agk-deployment-configs`)
- Legacy CT shared GitOps repo: `Knauf-Group/ct-shared-deployment-configs` (`$KNAUF_ROOT/ct-shared-deployment-configs`)

Before relying on repo facts, fetch the latest main branches:

```bash
git -C $KNAUF_ROOT/agk-infrastructure fetch origin main
git -C $KNAUF_ROOT/agk-deployment-configs fetch origin main
git -C $KNAUF_ROOT/agentic-karl fetch origin main
git -C $KNAUF_ROOT/agentic-karl-rag-api fetch origin main
```

## Azure CLI Access

Known tenant:

- Tenant name: `Knauf`
- Tenant ID: `ad200093-0cba-48cb-9853-16fb53354a4d`

Subscriptions used by AGK:

| Environment | Subscription | ID |
|---|---|---|
| Nonprod | `CT-SHARED-RESOURCES` | `ad3f0a71-cc5b-4d00-8289-23623cf2064c` |
| Prod | `CT-SHARED-RESOURCES-PROD` | `e0515a24-7205-481b-b657-944901020e32` |

Login and pin the intended subscription:

```bash
az login
az account set --subscription ad3f0a71-cc5b-4d00-8289-23623cf2064c
az account show --query "{name:name,id:id,tenantId:tenantId,user:user.name}" -o json
```

For prod checks:

```bash
az account set --subscription e0515a24-7205-481b-b657-944901020e32
az account show --query "{name:name,id:id,tenantId:tenantId,user:user.name}" -o json
```

Safe inventory commands:

```bash
az group list --query "length(@)"
az resource list --query "length(@)"
az resource list -g rg-agentic-karl-tenant-nonprod-westeurope --query "[].{name:name,type:type,location:location}" -o table
az resource list -g rg-agentic-karl-tenant-prod-westeurope --query "[].{name:name,type:type,location:location}" -o table
```

AKS read-only setup, usually requiring VPN:

```bash
az aks get-credentials -g rg-agk-nonprod-westeurope -n aks-agk-nonprod-001 --overwrite-existing
kubectl get ns
kubectl -n agentic-karl-dev get deploy,pods,externalsecret,secretstore
```

## Permission Model

Access varies by colleague, group membership, and pipeline identity. Do not hardcode a person's current roles into decisions; verify effective access on the target scope before assuming a change can be made.

Check the active human identity:

```bash
az account show --query "{subscription:name,id:id,user:user.name}" -o json
USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
az role assignment list \
  --assignee "$USER_OBJECT_ID" \
  --include-groups \
  --include-inherited \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>" \
  --query "[].{role:roleDefinitionName,scope:scope,principalType:principalType,principalName:principalName}" \
  -o table
```

Control-plane `Owner` or `Contributor` on a resource group lets an operator manage Azure resources there, but data-plane access is separate for several services:

- Key Vault contents: `Key Vault Secrets Officer` for secrets, or `Key Vault Administrator` for full vault data-plane administration.
- Storage contents: `Storage Blob Data Reader`, `Storage Blob Data Contributor`, or `Storage Blob Data Owner` depending on whether read, write, or ACL/admin operations are needed.
- ACR image publishing/import: target registry write permission such as `AcrPush` or equivalent pipeline/service-principal access.
- AKS debugging: Azure cluster access plus Kubernetes RBAC/ArgoCD permissions; Azure `Reader` alone is not enough for pod logs, restarts, or secret inspection.
- ArgoCD operations: ArgoCD app read/sync permissions are independent from Azure RBAC.

For day-to-day Agentic Karl work:

- App secrets and app-owned data usually live in the tenant RG and tenant Key Vault.
- Image movement and registry cleanup target the hub ACR.
- Pod/runtime debugging targets the spoke AKS cluster and ArgoCD.
- Terraform state and platform changes are normally owned by CI/CD service principals, not local `terraform apply`.

Do not assume pipeline access matches human access. GitHub Actions credentials and ArgoCD credentials must be tested separately.

## Private DB Maintenance

AGK MongoDB is intentionally private-only. Do not enable public Mongo access for local convenience.

For occasional, tightly scoped database maintenance, prefer a short-lived ArgoCD/Kubernetes Job over direct laptop access:

1. Create a temporary GitOps branch in `$KNAUF_ROOT/agk-deployment-configs`.
2. Add a one-off `batch/v1` Job under a temporary maintenance path, usually `maintenance/<env>/<purpose>/job.yaml`.
3. Run the Job in the target namespace with the deployed app image and existing `envFrom` refs for the app ConfigMap and Secret, so it uses the same private network path and `MONGO_URI` as the backend.
4. Print only non-secret before/after metadata. Never print connection strings, tokens, or secret values.
5. Create a temporary ArgoCD Application pointing at that branch/path, sync it, inspect Job logs, then delete the ArgoCD Application.
6. Delete the temporary remote branch and restore the local GitOps repo to its previous branch.

Use this pattern for small, deterministic changes such as setting one user's `role` or granting a specific ACL entry. Do not use it for exploratory querying, bulk migrations, long-running scripts, or changes that should live as product/admin functionality. Those belong in application code, a migration, or a reviewed operational runbook.

Local DB access is possible only if both routing and DNS are configured:

- The active VPN/client route table must route the AGK environment CIDR through VPN. Dev/nonprod Mongo currently lives behind the AGK nonprod spoke CIDR `10.160.0.0/16`; the dev Mongo private endpoint resolves to `10.160.0.7:10260`.
- VPN/corporate DNS must resolve the AGK tenant private DNS zone records for `privatelink.mongocluster.cosmos.azure.com`, including the `A` and `_mongodb._tcp` `SRV` records. A shared DNS zone for another Mongo cluster is not enough.
- Network policy, NSG, and firewall rules must allow the VPN client CIDR to the private endpoint and port.

Useful validation commands:

```bash
route -n get 10.160.0.7
dig @<vpn-dns-server> cosmos-agk-nonprod-westeurope-001.privatelink.mongocluster.cosmos.azure.com A
dig @<vpn-dns-server> _mongodb._tcp.cosmos-agk-nonprod-westeurope-001.privatelink.mongocluster.cosmos.azure.com SRV
nc -vz 10.160.0.7 10260
```

If these checks fail, do not work around it by changing Mongo public access. Either fix VPN/Private DNS through Terraform/network ownership, or use the short-lived ArgoCD Job pattern above.

## Infrastructure Shape

`agk-infrastructure` manages Azure with a hub-spoke architecture in both nonprod and prod. Each environment has base infrastructure plus tenant roots and tenant app roots:

```text
terraform/subscription/<nonprod|prod>/
  base/hub/                 # shared hub: RG, hub VNet, firewall, Bastion, ACR, Key Vault, PostgreSQL
  base/<nonprod|prod>/      # spoke: workload VNet, AKS, ACI runner, identities, route tables
  tenant/<tenant>/          # tenant root: tenant RG, app KV, storage, Redis, MongoDB, ESO identity
  tenant/<tenant>/<app>/    # app root: app-specific DBs/secrets/bindings
```

Base layers are applied in order:

1. Bootstrap `main.tf` for tfstate storage.
2. Foundation.
3. Security.
4. Storage.
5. Computational.
6. Application.

Tenant pipelines then apply:

1. Tenant root directories.
2. Tenant app directories.

CI/CD workflows:

- `deploy-nonprod-hub.yaml`, `deploy-nonprod-spoke.yaml`, `deploy-nonprod-tenant.yaml`.
- `deploy-prod-hub.yaml`, `deploy-prod-spoke.yaml`, `deploy-prod-tenant.yaml`.
- Pull request: Terraform plan only.
- Push to `main`: plan then apply.
- `workflow_dispatch`: discovers/applies all configured directories/layers.

Networking:

- Azure CNI Pod Subnet mode.
- Nonprod CIDR: `10.160.0.0/16`; prod CIDR: `10.161.0.0/16`.
- Nonprod spoke: nodes `10.160.0.0/22`, ingress `10.160.4.0/28`, ACI `10.160.5.0/24`, pods `10.160.32.0/19`.
- Prod spoke: nodes `10.161.0.0/22`, ingress `10.161.4.0/28`, ACI `10.161.5.0/24`, pods `10.161.32.0/19`.
- Private PostgreSQL lives in the hub storage layer. App DB setup runs from self-hosted AGK runners because the DB has no public endpoint.

Read these infra docs only when relevant:

- `$KNAUF_ROOT/agk-infrastructure/docs/SHARED-AZURE-FIREWALL.md` for shared firewall/route-table work.
- `$KNAUF_ROOT/agk-infrastructure/docs/CONFLUENT-CLOUD-PEERING.md` for Kafka/Confluent private peering.

## Environment Map

Use these as topology anchors. Verify live state with Azure CLI before mutating resources.

| Env | Subscription | Hub RG | Spoke RG | Tenant RG | AKS | Hub ACR | Tenant Key Vault |
|---|---|---|---|---|---|---|---|
| Dev/nonprod | `CT-SHARED-RESOURCES` | `rg-agk-hub-nonprod-westeurope` | `rg-agk-nonprod-westeurope` | `rg-agentic-karl-tenant-nonprod-westeurope` | `aks-agk-nonprod-001` | `acragkhubnonprod001` | `kv-agntkarl-nonprod-001` |
| Prod | `CT-SHARED-RESOURCES-PROD` | `rg-agk-hub-prod-westeurope` | `rg-agk-prod-westeurope` | `rg-agentic-karl-tenant-prod-westeurope` | `aks-agk-prod-001` | `acragkhubprod001` | `kv-agntkarl-prod-001` |

Tenant Terraform roots:

| Env | Tenant root | App root | Tenant state | App state |
|---|---|---|---|---|
| Dev/nonprod | `$KNAUF_ROOT/agk-infrastructure/terraform/subscription/nonprod/tenant/agentic-karl` | `.../tenant/agentic-karl/agentic-karl` | `rg-agk-nonprod-tfstate-westeurope` / `agknonprodwestfstate` / `tfstate` / `agk.tenant.agentic-karl.tfstate` | same backend, key `agk.tenant.agentic-karl.agentic-karl.tfstate` |
| Prod | `$KNAUF_ROOT/agk-infrastructure/terraform/subscription/prod/tenant/agentic-karl` | `.../tenant/agentic-karl/agentic-karl` | `rg-agk-prod-tfstate-westeurope` / `agkprodwestfstate` / `tfstate` / `agk.tenant.agentic-karl.tfstate` | same backend, key `agk.tenant.agentic-karl.agentic-karl.tfstate` |

Agentic Karl app resources:

| Env | MongoDB vCore | Redis | Blob Storage | External Secrets MI | PostgreSQL |
|---|---|---|---|---|---|
| Dev/nonprod | `cosmos-agk-nonprod-westeurope-001` | `redis-agk-nonprod-westeurope-redis-agk-dev-001` | `agkblobdevwesteu`, file share `karlshare`, container `files` | `mi-agentic-karl-dev-westeurope-aks-external-secrets-001` | server `pgsql-agk-hub-nonprod-westeurope-001`, DB `agentic-karl-dev` |
| Prod | `cosmos-agk-prod-westeurope-001` | `redis-agk-prod-westeurope-redis-agk-prod-001` | `agkblobprodwesteu`, container `files` | `mi-agentic-karl-prod-westeurope-aks-external-secrets-001` | server `pgsql-agk-hub-prod-westeurope-001`, DB `agentic-karl-prod` |

## Deployment Config Shape

`agk-deployment-configs` manages ArgoCD app-of-apps for AGK across two AKS clusters:

- Nonprod cluster: `aks-agk-nonprod-001`.
- Prod cluster: `aks-agk-prod-001`.
- Nonprod ArgoCD: `argocd.agk.nonprod.knauf.digital`.
- Prod ArgoCD: `argocd.agk.prod.knauf.digital`.
- Infra project deploys ArgoCD-managed platform components: Traefik, External Secrets, Datadog, GHA runners, Backstage service account.
- Services project uses ApplicationSets to discover service directories.

Service directory patterns:

| Cluster | Path pattern | Namespace |
|---|---|---|
| Nonprod | `{project}/dev/services/{service}/` | `{project}-dev` |
| Nonprod | `{project}/stage/services/{service}/` | `{project}-stage` |
| Nonprod | `{project}/preprod/services/{service}/` | `{project}-preprod` |
| Prod | `{project}/prod/services/{service}/` | `{project}-prod` |

For multi-source service apps, ArgoCD renders:

1. GitOps values: `{project}/{env}/services/{service}/values.yaml`
2. Service repo values: `Knauf-Group/{service}/infrastructure/{env}/values.yaml`

The ApplicationSet lists the GitOps values file first and `$serviceValues/...` second, so the service repo value file can override colliding keys. This is stricter than the README wording; verify with `infra/<env>/argocd/projects/services.yaml` when changing value precedence.

Current Agentic Karl GitOps state:

- `agk-deployment-configs` contains both `agentic-karl/dev/...` and `agentic-karl/prod/...`.
- Dev and prod services present: `agentic-karl`, `agentic-karl-rag-api`, `agentic-karl-meilisearch`, plus `common-namespace-resources` and `network-policy`.
- App repo contains both `infrastructure/dev/values.yaml` and `infrastructure/prod/values.yaml`.
- Prod service image currently points at `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl:v0.57.0` in GitOps values and the prod app overlay.

ArgoCD bootstrap workflows in `agk-deployment-configs`:

- Nonprod workflow uses `ENV_AZURE_CREDENTIALS_NONPROD`, runner `agk-dc-nonprod-runner`, hub Key Vault `kv-agk-hub-nonprod-001`.
- Prod workflow uses `ENV_AZURE_CREDENTIALS_PROD`, runner `agk-dc-prod-runner`, hub Key Vault `kv-agk-hub-prod-001`.

## Agentic Karl Runtime

New AGK dev:

- Domain: `https://agentic-karl.agk.dev.knauf.digital`
- ACR image: `acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl:<version>`
- Config repo path: `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`
- App overlay path: `$KNAUF_ROOT/agentic-karl/infrastructure/dev/values.yaml`
- ArgoCD domain: `argocd.agk.nonprod.knauf.digital`
- ArgoCD app: `agentic-karl-dev-agentic-karl`
- Namespace: `agentic-karl-dev`

AGK prod:

- Domain: `https://agentic-karl.knauf.com` for the public app; older AGK internal prod hostname was `https://agentic-karl.agk.prod.knauf.digital`.
- ACR image: `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl:<version>`
- Config repo path: `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/prod/services/agentic-karl/values.yaml`
- App overlay path: `$KNAUF_ROOT/agentic-karl/infrastructure/prod/values.yaml`
- ArgoCD domain: `argocd.agk.prod.knauf.digital`
- ArgoCD app: `agentic-karl-prod-agentic-karl`
- Namespace: `agentic-karl-prod`

Old CT dev:

- Domain: `https://agentic-karl.dev.knauf.digital`
- ACR image: `acrctshared001.azurecr.io/tools-non-prod/agentic-karl:<version>`
- Config repo: `Knauf-Group/ct-shared-deployment-configs`
- Config path: `dev/services/agentic-karl/agentic-karl/values.yaml`
- ArgoCD domain: `argocd-shared-dev.knauf.digital`
- ArgoCD app: `agentic-karl`

Current dev Okta/OpenID settings in AGK GitOps values:

- `DOMAIN_CLIENT`: `https://agentic-karl.agk.dev.knauf.digital`
- `DOMAIN_SERVER`: `https://agentic-karl.agk.dev.knauf.digital`
- `OPENID_CLIENT_ID`: `0oawcorb2pfMcXkHU417`
- `OPENID_ISSUER`: `https://dev.identity.knauf.digital/oauth2/default`
- `OPENID_CALLBACK_URL`: `/oauth/openid/callback`

Current prod Okta/OpenID settings in AGK GitOps values:

- `DOMAIN_CLIENT`: `https://agentic-karl.knauf.com`
- `DOMAIN_SERVER`: `https://agentic-karl.knauf.com`
- `ADMIN_PANEL_URL`: `https://agentic-karl-admin.knauf.com`
- `OPENID_CLIENT_ID`: `0oae5vnxw30lWRJmh417`
- `OPENID_ISSUER`: `https://login.knauf.com`
- `OPENID_CALLBACK_URL`: `/oauth/openid/callback`

App code references:

- `$KNAUF_ROOT/agentic-karl/api/strategies/openidStrategy.js`
- `$KNAUF_ROOT/agentic-karl/api/server/routes/oauth.js`

## Langfuse And LangGraph Observability

Use the generic `langfuse` skill for official CLI/API syntax and docs. Use this section for AGK-specific wiring and interpretation.

AGK dev Langfuse:

- Host/base URL: `https://langfuse.agk.dev.knauf.digital`
- Project: `agentic-karl` (`Agentic Karl`)
- Organization: `knauf-agk` (`Knauf AGK`)
- Public key: `pk-lf-agk-dev-agentic-karl-001`
- Secret key source: Key Vault `kv-agntkarl-nonprod-001`, secret `langfuse-dev-LANGFUSE-INIT-PROJECT-SECRET-KEY`
- Okta is for browser UI login only. CLI/API access uses the project public/secret key pair. The Key Vault secret may not be shaped like `sk-lf-...`; trust the authenticated project check, not the prefix.

Repo-local CLI:

- `agentic-karl` has `langfuse-cli` installed as a dev dependency.
- `npm run langfuse:project` verifies auth and project scope.
- `npm run langfuse:traces` lists recent traces.

Safe ad hoc trace reads:

```bash
LANGFUSE_HOST=https://langfuse.agk.dev.knauf.digital \
LANGFUSE_PUBLIC_KEY=pk-lf-agk-dev-agentic-karl-001 \
LANGFUSE_SECRET_KEY="$(az keyvault secret show \
  --vault-name kv-agntkarl-nonprod-001 \
  --name langfuse-dev-LANGFUSE-INIT-PROJECT-SECRET-KEY \
  --query value -o tsv)" \
./node_modules/.bin/langfuse api traces get <trace-id> \
  --fields core,io,observations,metrics,scores \
  --json
```

For summaries, do not dump full inputs/outputs by default. Start with:

```bash
... ./node_modules/.bin/langfuse api traces get <trace-id> \
  --fields core,io,observations,metrics,scores --json \
| jq '{id:.body.id,name:.body.name,timestamp:.body.timestamp,userId:.body.userId,sessionId:.body.sessionId,environment:.body.environment,latency:.body.latency,errorCount:([.body.observations[]? | select(.level=="ERROR")]|length),errors:[.body.observations[]? | select(.level=="ERROR") | {name,type,model,statusMessage}]}'
```

UI trace IDs:

- In the trace detail page, use the value after `Trace <name>:` (for example `AgentRun: fc2233d7c764699401c3b075817b388f`) as the API trace ID.
- A URL `peek=<id>` is not always a fetchable trace ID; it can point to stale UI state or a missing row. If `traces get` returns `Trace <id> not found within authorized project`, list by timestamp/session before assuming auth is wrong.

LangGraph trace interpretation:

- Agent runs usually appear as trace name `AgentRun`.
- Common observation stack: `AgentRun` -> `LangGraph` -> `agent__...` / `agent=...` -> `RunnableSequence` -> `prompt` -> `ChatOpenAI`.
- `prompt` observations contain the rendered system/user prompt messages.
- `ChatOpenAI` observations are the generation call; inspect `model`, `input`, `output`, `usage`, and `statusMessage`.
- `2 hidden observations below DEFAULT level` in the UI means DEBUG spans such as `__start__` are hidden; use API fields `observations` to see them.
- The trace `input`/`output` can contain the full conversation state and file-search snippets. Treat as sensitive; summarize unless the user explicitly asks for full JSON.

Common AGK LangGraph failure signatures:

- `Error while downloading file. Upstream status code: 403` with `innererror.code=StorageAccessDenied` on `ChatOpenAI` means the model/provider could not fetch an uploaded-file URL. This is a file URL/SAS/storage access issue, not a Langfuse auth issue.
- Empty or missing old traces while sessions still exist usually means ClickHouse trace data is absent/stale even though Postgres session metadata survived.

Langfuse runtime in AGK dev:

- Namespace: `agentic-karl-dev`
- Services/deployments: `langfuse-web`, `langfuse-worker`, `langfuse-clickhouse`, `langfuse-redis`
- GitOps paths on `agk-deployment-configs` `main`: `agentic-karl/dev/services/langfuse-web`, `langfuse-worker`, `langfuse-clickhouse`
- Trace reads require ClickHouse tables; project/session APIs can still work if ClickHouse trace tables or worker ingestion are broken.

## Azure AI And Model Map

### AGK Foundry model router

Foundry infrastructure was deployed on 2026-07-13 and expanded on 2026-07-15. Default KARL, memory, and title generation use the `model-router-chat` application alias, which maps to the account-level `model-router` deployment through Chat Completions. In dev, prompt autogeneration and created-agent personalities use the stable `agent-default` alias, which resolves to the environment-selected direct `gpt-5.6-sol` deployment. Dev image generation and embeddings use their specialised deployments in the same nonprod Foundry account. Document Intelligence remains on the legacy AI Services account.

The project-endpoint router Responses path was tested directly with hosted `web_search`, but integrated LibreChat agent runs were not reliable when hosted search and local function-tool turns were combined. It is therefore not exposed in `librechat.yaml`. Ordinary KARL uses account-level router Chat Completions; created agents use direct GPT-5.6 Sol Responses. Reintroduce a project-router path only behind a separate, explicit experiment after repeatable application-level tests.

| Env | Subscription | Hub resource group | Foundry account | Project | Private endpoint |
|---|---|---|---|---|---|
| Nonprod | `CT-SHARED-RESOURCES` | `rg-agk-hub-nonprod-westeurope` | `foundry-agk-hub-nonprod-swedencentral-001` | `proj-agk-hub-nonprod-swedencentral-001` | `pe-foundry-agk-hub-nonprod-westeurope-001` |
| Prod | `CT-SHARED-RESOURCES-PROD` | `rg-agk-hub-prod-westeurope` | `foundry-agk-hub-prod-swedencentral-001` | `proj-agk-hub-prod-swedencentral-001` | `pe-foundry-agk-hub-prod-westeurope-001` |

Both accounts are `AIServices` resources in Sweden Central. Their private endpoints are in West Europe and public network access is disabled. Each endpoint registers three private addresses: `.164` for `cognitiveservices.azure.com`, `.165` for `openai.azure.com`, and `.166` for `services.ai.azure.com` in the environment's `10.160.192.0/24` or `10.161.192.0/24` hub subnet. The associated private DNS zones are:

- `privatelink.cognitiveservices.azure.com`
- `privatelink.openai.azure.com`
- `privatelink.services.ai.azure.com`

Terraform declares the following deployments in both environments. Capacity is shown as nonprod/prod:

| Deployment | Model/version | SKU | Capacity | Purpose |
|---|---|---|---:|---|
| `model-router` | `model-router` / `2025-11-18` | `GlobalStandard` | 10000 / 10000 | Default KARL, memory, and titles |
| `gpt-5.6-sol` | `gpt-5.6-sol` / `2026-07-09` | `GlobalStandard` | 10000 / 15000 | Direct agents and prompt drafting |
| `gpt-5.5`, `gpt-5.5-1` | `gpt-5.5` / `2026-04-24` | `GlobalStandard` | 5000 each | Direct benchmark/fallback deployments; not selected by dev runtime |
| `text-embedding-3-large` | `text-embedding-3-large` / `1` | `GlobalStandard` | 1000 / 1000 | RAG embeddings |
| `gpt-image-1` | `gpt-image-1` / `2025-04-15` | `GlobalStandard` | 20 / 10 | Active image generation target |
| `gpt-image-2` | `gpt-image-2` / `2026-04-21` | `GlobalStandard` | 10 / 12 | Deployed and priced, not selected by the app |

`GlobalStandard` is consumption/pay-per-token capacity, not provisioned throughput. Capacity reserves rate-limit quota but does not create a fixed PTU charge. Router capacity is independent from every direct deployment; direct GPT deployments are not replicas or backends of Model Router.

The intended router mode is `balanced` with the pinned OpenAI-only pool `gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4`, and `gpt-5.5`. Live GET checks on 2026-07-15 still returned `properties.routing: null`, and probes selected unapproved models. Do not run representative router load tests until the module persists and verifies that exact subset. GPT-5.6 Sol is deliberately outside the router pool and is selected directly for created agents and prompt drafting.

Infrastructure ownership and release order:

1. Shared module: `Customer-Tech-Shared/infrastructure/terraform/modules/foundry`, currently released as `foundry1.1.0`.
2. AGK instances: `agk-infrastructure/terraform/subscription/<nonprod|prod>/base/hub/computational/foundry.tf`.
3. Merge and release the shared module first, then pin the immutable module tag in AGK infrastructure. Never merge an infrastructure root that references shared-module `main` or a temporary PR commit.
4. The module explicitly defaults deployment `rai_policy_name` to `Microsoft.DefaultV2`. Azure temporarily returns the parent account to `Accepted` while child resources change; private endpoint creation must wait for project, deployments, and the follow-up router routing update.

Current pre-production dependency tree, last checked 2026-07-15:

1. Merged: `Customer-Tech-Shared#579`, immutable tag `foundry1.1.0`, `agk-infrastructure#57/#58`, `agentic-karl#124`, `agentic-karl-rag-api#11/#12`, and `agk-deployment-configs#113/#118`.
2. Dev GitOps is active on app `v0.108.0` and RAG `v0.8.0.3`. Dev uses Model Router for ordinary KARL, direct GPT-5.6 Sol for agents/prompt drafting, nonprod Foundry embeddings, and nonprod Foundry GPT Image 1.
3. Prod remains on app `v0.107.0`, RAG `v0.8.0.2`, direct GPT-5.5, and legacy shared embedding/image endpoints. Do not promote or alter prod while validating dev.
4. Pending: merge `Customer-Tech-Shared#580`, release immutable tag `foundry1.1.1`, then open one nonprod-only `agk-infrastructure` PR that bumps only the module ref from `foundry1.1.0` to `foundry1.1.1`.
5. Apply the nonprod computational layer. The module must fail if Azure does not persist the exact router subset. If it succeeds, verify the live routing property before any app load test.

Dev target state: ordinary KARL, memory, and titles use Model Router; created agents and prompt drafting use direct GPT-5.6 Sol; RAG uses nonprod `text-embedding-3-large`; image generation uses nonprod GPT Image 1. GPT Image 2 remains deployed and priced but disabled.

The RAG endpoint migration needs no additional provider rewrite. `agentic-karl-rag-api` already passes `RAG_OPENAI_BASEURL` and `RAG_OPENAI_API_KEY` to LangChain `OpenAIEmbeddings`. Both the legacy and target deployments use `text-embedding-3-large` version `1` with 3072 dimensions, so existing pgvector rows remain compatible and no re-embedding migration is required. Model Router, GPT-5.6 Sol, and GPT Image deployments are not consumed by the RAG service.

Access and validation rules:

- `az login` grants control-plane access only. It does not provide a laptop route or private DNS forwarding into the AGK VNets.
- The corporate VPN routes the nonprod Foundry subnet `10.160.192.0/24`. An authenticated laptop request forced to the OpenAI private endpoint `10.160.192.165` returned HTTP `200`, proving the VPN data path and TLS.
- Nonprod Terraform links the Foundry private DNS zones to `vnet-ct-shared-dns-forwarder`. Keep public access disabled. Prod remains hub/spoke-only unless a separate approved access requirement is added.
- Reconnect the corporate VPN or flush local DNS and confirm the nonprod OpenAI hostname resolves to `10.160.192.165` before running the app locally. AKS is the authoritative test path.
- Dev image generation and embeddings use `AGK-FOUNDRY-API-KEY`; Document Intelligence remains on `AGK-OPENAI-API-KEY`. Text generation uses `AGK-FOUNDRY-API-KEY`, exposed as `AZURE_FOUNDRY_API_KEY`, plus `AZURE_FOUNDRY_RESOURCE_NAME`.
- The shared Helm chart hashes ConfigMap and ExternalSecret manifests into the pod template. GitOps manifest changes roll the workloads automatically. A Key Vault value-only rotation still requires ExternalSecret refresh and pod restart because the manifest hash does not see secret data changes.
- `librechat.yaml` intentionally has no silent runtime fallback. Ordinary KARL uses the router; `AZURE_FOUNDRY_AGENT_DEPLOYMENT` selects the direct agent deployment. Validate router, direct Sol, embedding, and image paths in dev before production promotion.

Safe live checks:

```bash
az cognitiveservices account deployment list \
  --subscription <subscription-id> \
  --resource-group <hub-resource-group> \
  --name <foundry-account> \
  --query "[].{deployment:name,state:properties.provisioningState,model:properties.model.name,version:properties.model.version,sku:sku.name,capacity:sku.capacity,raiPolicy:properties.raiPolicyName}" \
  -o table

az network private-endpoint list \
  --subscription <subscription-id> \
  --resource-group <hub-resource-group> \
  --query "[?contains(name, 'pe-foundry')].{name:name,state:provisioningState,approval:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}" \
  -o table
```

The main Agentic Karl and CST KARL model backend is the shared Azure AI Services account `cst-karl-dev` in the prod shared subscription:

- Subscription: `CT-SHARED-RESOURCES-PROD` (`e0515a24-7205-481b-b657-944901020e32`)
- Resource group: `rg-ct-sharedprod-westeurope`
- Resource type/kind: `Microsoft.CognitiveServices/accounts`, kind `AIServices`
- Region: `swedencentral`
- OpenAI endpoint: `https://cst-karl-dev.openai.azure.com/`
- AI Services / Foundry data-plane endpoint: `https://cst-karl-dev.services.ai.azure.com/`
- Foundry project child resource: `cst-karl-dev-project`; this is a project layer under the account, not a separate model billing or quota account.

Do not confuse this with `ct-sharedprod-openai-swedencentral-001` or `knauf-openai`:

- `ct-sharedprod-openai-swedencentral-001` is a separate Terraform-managed Azure OpenAI account in the same prod shared subscription. It has deployments such as `gpt-5`, `gpt-4o`, and `text-embedding-3-large`, but not `gpt-54` or `gpt-image-1` as of the last verification.
- `knauf-openai` is the custom subdomain/private endpoint name used by that shared account, not a live resource name. The only CST KARL runtime reference found was a suspended evaluation cronjob, so do not assume normal app traffic uses it.
- `knauf-supafil-aihub` / `knauf-supafil-project` are Machine Learning workspace Foundry hub/project resources and were not referenced by Agentic Karl or CST KARL runtime config during the last check.

Live `cst-karl-dev` deployments last verified with:

```bash
az account set --subscription e0515a24-7205-481b-b657-944901020e32
az cognitiveservices account deployment list \
  --name cst-karl-dev \
  --resource-group rg-ct-sharedprod-westeurope \
  --query "[].{deployment:name,model:properties.model.name,version:properties.model.version,sku:sku.name,capacity:sku.capacity,rateLimits:properties.rateLimits}" \
  -o json
```

Current deployment map:

| Deployment | Model | Version | SKU | Capacity | Rate limit |
|---|---|---|---|---:|---|
| `gpt-54` | `gpt-5.4` | `2026-03-05` | `GlobalStandard` | 1838 | 18,380 RPM / 1,838,000 TPM |
| `gpt-5` | `gpt-5` | `2025-08-07` | `GlobalStandard` | 8492 | 84,920 RPM / 8,492,000 TPM |
| `gpt-4o` | `gpt-4o` | `2024-11-20` | `Standard` | 150 | 150 requests / 10s, 150,000 TPM |
| `text-embedding-3-large` | `text-embedding-3-large` | `1` | `GlobalStandard` | 250 | 250 requests / 10s, 250,000 TPM |
| `gpt-image-1` | `gpt-image-1` | `2025-04-15` | `GlobalStandard` | 20 | 60 RPM |

Rate-limit interpretation:

- Azure evaluates both RPM and TPM. Whichever is reached first throttles the deployment.
- TPM is based on Azure's estimated processed tokens when the request arrives. That estimate includes prompt size and configured max output tokens, and can differ from final billed token counts.
- RPM is enforced over short windows inside the minute, so bursty tests can receive `429` before a full one-minute average appears to exceed the limit.
- For `gpt-54`, practical max request rate is `min(18380, 1838000 / estimated_tokens_per_request)` requests per minute. Convert to concurrent load with `concurrency ~= (max_rpm / 60) * p95_latency_seconds`.
- This shared deployment is used by both CST KARL and Agentic Karl. Load tests against production can throttle real users unless quota is isolated with a separate deployment/resource or the test is carefully ramped and capped.

Agentic Karl model wiring:

- App repo `$KNAUF_ROOT/agentic-karl/librechat.yaml` defines an account-level router Chat Completions group and an environment-selected direct agent deployment group. Both use `AZURE_FOUNDRY_API_KEY`. The experimental project-endpoint router Responses group is intentionally absent.
- Default model spec `karl`, memory, and title generation use the `model-router-chat` alias through account-level Chat Completions API version `2024-10-21`; the alias maps to deployment `model-router`.
- Prompt autogeneration uses `agent-default` through Chat Completions. Personality presets use the same alias with `useResponsesApi: true`. Dev sets `AZURE_FOUNDRY_AGENT_DEPLOYMENT=gpt-5.6-sol`; prod remains on `gpt-5.5` until promotion. Legacy saved-agent names (`gpt-4o` and `gpt-5.4`) resolve through the same direct group and are rewritten to the configured deployment, so no database migration is required.
- Change `AZURE_FOUNDRY_AGENT_DEPLOYMENT` when promoting a newer approved direct deployment, without editing `librechat.yaml`. A future router Responses comparison requires a separate config change and review; do not point agent presets at the account-level Chat Completions alias.
- Dev image generation uses nonprod Foundry GPT Image 1 and `AGK-FOUNDRY-API-KEY`. Prod image generation remains on the legacy shared account until promotion.
- Dev RAG points to the nonprod Foundry `/openai/v1` endpoint, maps `RAG_OPENAI_API_KEY` from `AGK-FOUNDRY-API-KEY`, retains `EMBEDDINGS_MODEL=text-embedding-3-large` and `EMBEDDINGS_DIMENSIONS=3072`, and sets `RAG_OPENAI_MAX_RETRIES=6`.
- Prod RAG remains on the legacy shared embedding endpoint. Document Intelligence intentionally stays on the legacy AI Services endpoint/key in both environments.

CST KARL model wiring, for shared-resource awareness:

- CST KARL dev/prod GitOps points the web UI at `AZURE_RESOURCE_NAME: cst-karl-dev`, `AZURE_DEPLOYMENT_NAME: gpt-54`, `AZURE_BASE_URL: https://cst-karl-dev.openai.azure.com/`, and `GPT_IMAGE_BASEURL: https://cst-karl-dev.openai.azure.com/openai/deployments/gpt-image-1`.
- CST KARL RAG uses `text-embedding-3-large` on `https://cst-karl-dev.openai.azure.com/`.
- CST KARL RAG also has a Supafil path using `gpt-4o`.
- The CST KARL suspended evaluation cronjob in prod references `knauf-openai`; because it is suspended and that account does not have `gpt-54`/`gpt-image-1`, do not treat it as normal traffic without revalidating.

Useful usage checks:

```bash
az monitor metrics list \
  --resource /subscriptions/e0515a24-7205-481b-b657-944901020e32/resourceGroups/rg-ct-sharedprod-westeurope/providers/Microsoft.CognitiveServices/accounts/cst-karl-dev \
  --metric ModelRequests,ProcessedPromptTokens,GeneratedTokens \
  --interval PT1M \
  --aggregation Total \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --filter "ModelDeploymentName eq 'gpt-54'" \
  -o json
```

## Secrets And External Secrets

External Secrets service accounts and SecretStores live in:

- `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/dev/common-namespace-resources/values.yaml`
- `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/prod/common-namespace-resources/values.yaml`

Known nonprod values: ServiceAccount `sa-external-secrets`, client ID `b573fdae-1009-46d4-8c58-16694e48f65f`, tenant ID `ad200093-0cba-48cb-9853-16fb53354a4d`, SecretStore `kv-agntkarl-nonprod-001`, vault URL `https://kv-agntkarl-nonprod-001.vault.azure.net/`.

Known prod values: ServiceAccount `sa-external-secrets`, client ID `af3876d3-0183-4213-8877-e66daff78ef2`, federated subject `system:serviceaccount:agentic-karl-prod:sa-external-secrets`, SecretStore `kv-agntkarl-prod-001`, vault URL `https://kv-agntkarl-prod-001.vault.azure.net/`.

Main app ExternalSecret lives in:

- `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`
- `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/prod/services/agentic-karl/values.yaml`

Important app mappings in dev and prod:

- `OPENID_CLIENT_SECRET` <- `AGK-OPENID-CLIENT-SECRET`
- `OPENID_SESSION_SECRET` <- `AGK-OPENID-SESSION-SECRET`
- `MONGO_URI` <- `agentic-karl-MONGODB-CONNECTION-STRING`
- `REDIS_URI` <- `agentic-karl-REDIS-CONNECTION-STRING`
- `AZURE_STORAGE_CONNECTION_STRING` <- `agentic-karl-BLOB-STORAGE-CONNECTION-STRING`
- OpenAI/Azure OpenAI env vars <- `AGK-OPENAI-API-KEY`
- Blob storage volume secret keys reference `AGK-AZURE-STORAGEACCOUNT-NAME` and `AGK-AZURE-STORAGEACCOUNT-KEY`.

Dev also maps analytics secrets:

- `KNAUF_ADOBE_ANALYTICS_SCRIPT_URL` <- `AGK-KNAUF-ADOBE-ANALYTICS-SCRIPT-URL`
- `KNAUF_ONETRUST_DOMAIN_SCRIPT_ID` <- `AGK-KNAUF-ONETRUST-DOMAIN-SCRIPT-ID`

Prod values currently do not include the Knauf analytics configmap or ExternalSecret entries. Add them deliberately if production analytics/OneTrust is required.

Terraform-managed secrets include MongoDB, Redis, Blob Storage, and PostgreSQL connection values. Do not manually rotate those as a durable fix; change Terraform or rerun the correct pipeline. Manually managed app secrets such as Okta/OpenID client secret can be set in Key Vault, then consumed through the existing ExternalSecret mapping.

Key Vault rotation runbook:

1. Confirm the target subscription and vault.
2. Set the Key Vault secret without printing the value:
   ```bash
   az keyvault secret set --vault-name kv-agntkarl-nonprod-001 --name AGK-OPENID-CLIENT-SECRET --value "<secret>"
   ```
3. For prod, use the prod subscription and `kv-agntkarl-prod-001` instead.
4. Force-refresh `ExternalSecret/agentic-karl-secrets` or wait for its `1h` interval.
5. Confirm `.status.refreshTime` is after the Key Vault update timestamp.
6. Restart Deployment `agentic-karl`.
7. Retest login from a fresh Okta login flow; do not reuse callback URLs with old one-time codes.

To add a new runtime secret:

1. Decide if it is Terraform-managed infrastructure output or manually managed application config.
2. If Terraform-managed, add it in the appropriate tenant root/app root in `agk-infrastructure`; let CI/CD write the Key Vault secret.
3. If manually managed, create/update the named secret in the correct Key Vault.
4. Add the env-to-Key-Vault mapping in `agk-deployment-configs/<project>/<env>/services/<service>/values.yaml`.
5. Ensure the namespace has a SecretStore in `<project>/<env>/common-namespace-resources/values.yaml`.
6. Commit the repo change; ArgoCD syncs it.
7. Refresh ExternalSecret and restart only if immediate pickup is needed.

## Release And Deployment

`origin/main` now deploys merged PR releases to both dev environments:

1. Existing CT release job builds and publishes `acrctshared001.azurecr.io/tools-non-prod/agentic-karl:<version>`.
2. AGK deploy job imports the same tag into `acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl:<version>`.
3. Workflow commits the version to:
   - `$KNAUF_ROOT/agentic-karl/infrastructure/dev/values.yaml`
   - `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`
4. ArgoCD auto-syncs `agentic-karl-dev-agentic-karl`; workflow can refresh and poll for Synced/Healthy.

Important AGK dev workflow constants:

- `AGK_SUBSCRIPTION_ID`: `ad3f0a71-cc5b-4d00-8289-23623cf2064c`
- `AGK_ACR_NAME`: `acragkhubnonprod001`
- `AGK_IMAGE_REPOSITORY`: `agentic-karl-dev/agentic-karl`
- `AGK_CONFIG_REPOSITORY`: `Knauf-Group/agk-deployment-configs`
- `AGK_CONFIG_DIRECTORY`: `agentic-karl/dev/services/agentic-karl`
- `AGK_ARGOCD_DOMAIN`: `argocd.agk.nonprod.knauf.digital`
- `AGK_ARGOCD_APP`: `agentic-karl-dev-agentic-karl`
- `AGK_ARGOCD_KEY_VAULT_NAME`: `kv-agk-hub-nonprod-001`
- `AGK_ARGOCD_PASSWORD_SECRET_NAME`: `argocd-admin-agk-nonprod`
- `CT_ACR_LOGIN_SERVER`: `acrctshared001.azurecr.io`
- `CT_IMAGE_REPOSITORY`: `tools-non-prod/agentic-karl`

`agk-deploy-smoke.yaml` validates the same dependencies without mutating real release tags: Azure login, Key Vault reads, temporary app/deployment-config branch push/delete, temporary ACR import/delete under `agentic-karl-dev/smoke/agentic-karl`, and ArgoCD API read for `agentic-karl-dev-agentic-karl`.

The reusable CT workflow does not expose `new-version` as a `workflow_call` output. If needed, recompute the released version after the CT release succeeds:

```bash
VERSION="v$(npm pkg get version | tr -d '"')"
```

RAG API releases are owned by `Knauf-Group/agentic-karl-rag-api`:

1. Merging a PR to RAG `main` builds `Dockerfile.lite` into `acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl-rag-api:v0.8.0.N`.
2. The release workflow opens and auto-merges the dev image-tag bump in `agk-deployment-configs/agentic-karl/dev/services/agentic-karl-rag-api/values.yaml`.
3. It refreshes `agentic-karl-dev-agentic-karl-rag-api` and waits for the expected image to become Synced/Healthy.
4. Prod is not updated by the dev release. Use the reviewed RAG promotion workflow to import the exact nonprod image into `acragkhubprod001`, update the prod GitOps tag, and verify prod ArgoCD.

Do not hand-edit RAG image tags while those workflows own the release. Configuration such as `RAG_OPENAI_MAX_RETRIES` belongs in GitOps and is harmless on an older image until the supporting RAG release is promoted.

## ArgoCD Checks And Actions

Login, if credentials are available:

```bash
argocd login argocd.agk.nonprod.knauf.digital --username admin --grpc-web
argocd login argocd.agk.prod.knauf.digital --username admin --grpc-web
```

Read-only checks:

```bash
argocd version --grpc-web
argocd app get agentic-karl-dev-agentic-karl --grpc-web
argocd app diff agentic-karl-dev-agentic-karl --grpc-web
argocd app manifests agentic-karl-dev-agentic-karl --grpc-web
argocd app get agentic-karl-prod-agentic-karl --grpc-web
argocd app diff agentic-karl-prod-agentic-karl --grpc-web
```

ExternalSecret status:

```bash
argocd app get-resource agentic-karl-dev-agentic-karl \
  --kind ExternalSecret \
  --group external-secrets.io \
  --resource-name agentic-karl-secrets \
  --grpc-web -o yaml
```

Dry-run sync:

```bash
argocd app sync agentic-karl-dev-agentic-karl --dry-run --grpc-web
argocd app sync agentic-karl-prod-agentic-karl --dry-run --grpc-web
```

Live operations after explicit confirmation:

```bash
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
argocd app patch-resource agentic-karl-dev-agentic-karl \
  --kind ExternalSecret \
  --group external-secrets.io \
  --namespace agentic-karl-dev \
  --resource-name agentic-karl-secrets \
  --patch "{\"metadata\":{\"annotations\":{\"force-sync\":\"$ts\"}}}" \
  --patch-type application/merge-patch+json \
  --grpc-web
```

```bash
argocd app actions run agentic-karl-dev-agentic-karl restart \
  --kind Deployment \
  --resource-name agentic-karl \
  --grpc-web
```

Operational note: Key Vault rotations consumed as environment variables require ExternalSecret refresh and pod restart before the running app sees the new values.

## How To Make Future Changes

Start every infra change by deciding the owner, then fit the change into the existing owner root/workflow. Do not start from the provider name or from what is easiest to authenticate.

### Placement Decision Table

| Change | Default owner |
|---|---|
| Hub-wide shared services, tfstate bootstrap, hub VNet, firewall, Bastion, hub ACR, hub Key Vault, PostgreSQL server | `agk-infrastructure/terraform/subscription/<env>/base/hub/<layer>` |
| Spoke AKS, node/ingress/ACI/pod subnets, runners, workload identities, route tables | `agk-infrastructure/terraform/subscription/<env>/base/<env>/<layer>` |
| Tenant RG, tenant Key Vault, tenant storage, Redis, MongoDB, tenant External Secrets identity | `agk-infrastructure/terraform/subscription/<env>/tenant/<tenant>` |
| App-specific DBs, DB roles, app-owned Key Vault secrets, app-specific provider resources, app bindings | `agk-infrastructure/terraform/subscription/<env>/tenant/<tenant>/<app>` |
| Kubernetes service deployment, image tag, ingress, probes, resource limits, env config, ExternalSecret mapping, SecretStore, network policy | `agk-deployment-configs/<project>/<env>/...` |
| Service-owned Helm defaults, app overlays, release automation, code behavior | `agentic-karl` or the owning service repo |
| Old CT dev deployment only | `ct-shared-deployment-configs` |

If more than one row seems plausible, choose the narrowest lifecycle owner. For example, a Datadog RUM application for Agentic Karl belongs in the Agentic Karl tenant app root, not in a standalone Datadog root, because it is app-owned and should be planned by the tenant app pipeline.

### Terraform Root And Workflow Rules

- Prefer existing roots and workflows. A new root/backend/workflow needs an explicit lifecycle reason, such as a separate owner, separate apply cadence, or a shared platform resource that multiple tenants consume.
- Do not create a side pipeline to solve credential convenience. Add the needed provider credentials to the existing owner pipeline, or retrieve them inside that pipeline.
- If changing a workflow file should validate that workflow on PRs, include the workflow path in its `on.push.paths` and `on.pull_request.paths`.
- If a self-hosted runner lacks a required CLI, add a scoped install/check step in the existing job. Do not switch runners without checking private network requirements.
- Use standard provider environment variables when a provider supports them. For Datadog, prefer `DD_HOST`, `DD_API_KEY`, and `DD_APP_KEY`; source the values from existing repo secrets or Key Vault retrieval without printing secret values.
- Reuse established shared modules when sibling repos use them. If no module exists for the resource, a direct Terraform resource in the correct root is acceptable.
- Use local Terraform only for syntax validation:
  ```bash
  terraform init -backend=false -input=false
  terraform validate -no-color
  ```
  Remove local `.terraform` and `.terraform.lock.hcl` artifacts afterwards if the repo ignores them.

### New Service Checklist

1. Identify the service owner repo, environments, target namespace, image repository, ingress hostnames, external dependencies, and required secrets.
2. Search existing AGK and sibling repo patterns before designing from scratch:
   ```bash
   rg -n "<service-or-provider>|ExternalSecret|SecretStore|ingress|datadog" $KNAUF_ROOT/agk-deployment-configs $KNAUF_ROOT/agk-infrastructure $KNAUF_ROOT/cms-cf-infrastructure
   ```
3. Add or update the service repo overlay `Knauf-Group/<service>/infrastructure/<env>/values.yaml` when the ApplicationSet expects service-owned values.
4. Add GitOps values at `agk-deployment-configs/<project>/<env>/services/<service>/values.yaml`.
5. Add or update namespace shared resources only if the namespace needs them: `common-namespace-resources`, `SecretStore`, service account, and `network-policy`.
6. Add ExternalSecret mappings for runtime env vars, but create the source Key Vault secrets through the right path: Terraform for generated infra outputs, manual/approved Key Vault update for manually managed app config.
7. Add Terraform only for cloud resources the service actually needs. Put shared tenant resources in the tenant root and app-owned resources in the tenant app root.
8. Verify image repository and tag ownership. Dev usually imports to `acragkhubnonprod001.azurecr.io/agentic-karl-dev/...`; prod uses `acragkhubprod001.azurecr.io/agentic-karl-prod/...`.
9. Validate with ArgoCD read-only checks and dry-run before live actions:
   ```bash
   argocd app get <app> --grpc-web
   argocd app diff <app> --grpc-web
   argocd app sync <app> --dry-run --grpc-web
   ```

### Pre-PR Infra Review Checklist

- Confirm current branch and subscription; fetch latest `main` for touched repos.
- State the owner in the PR description: root/path, backend state key if Terraform, workflow that plans/applies it, and why a new root/state is not needed.
- Search sibling repos for the same pattern before opening the PR. For Datadog, check `cms-cf-infrastructure` and existing AGK deployment-config Datadog usage.
- Inspect GitHub secret names with `gh secret list` only as metadata. Do not assume secrets exist because another repo has them.
- Run local YAML/action checks when workflows change. Existing custom runner labels may need actionlint ignores, but new diagnostics should be fixed.
- Run safe Terraform validation with `-backend=false`; never run local plan/apply against remote state.
- After opening the PR, inspect the CI plan for unexpected destroys, new backend keys, or resources outside the intended owner.
- If the plan requires a new pipeline, new state, or new credentials, pause and ask whether the resource actually belongs in an existing layer.

For prod Agentic Karl app onboarding or promotion:

1. Confirm prod DNS, Okta app, secrets, and release policy.
2. Confirm `$KNAUF_ROOT/agentic-karl/infrastructure/prod/values.yaml` exists and has the intended version/security overrides.
3. Validate existing prod GitOps directories and required manual prod app secrets in `kv-agntkarl-prod-001`; Terraform-managed MongoDB/Redis/Blob/PostgreSQL secrets should come from the infra pipeline.
4. Import/publish the chosen image tag into `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl`, then update prod GitOps image tag and app repo prod overlay values deliberately.
5. Verify ArgoCD app `agentic-karl-prod-agentic-karl` with read-only/dry-run checks before live sync or restart.
6. Update release/promotion automation intentionally; do not let dev release jobs push prod without an approved promotion step.

## GitHub Azure Credentials Caveat

GitHub secret values cannot be read back. Existing release logs prove `AZURE_CREDENTIALS` can read the two CT Key Vaults. To confirm it also covers AGK, verify the secret's `clientId`.

If `AZURE_CREDENTIALS.clientId` is `73332216-62c9-46a5-a3d0-09a353447f9c` (`sp-ct-shared-resources`), prior release logs showed sufficient nonprod access. If it is a different service principal, test or grant reads on `kv-ct-shared-devops-001`, `kv-ct-shared-tools`, and `kv-agk-hub-nonprod-001`, plus import/write into `acragkhubnonprod001`.

Prod release or promotion automation needs separately verified prod credentials for `e0515a24-7205-481b-b657-944901020e32`, `acragkhubprod001`, `kv-agk-hub-prod-001`, `kv-agntkarl-prod-001`, `argocd.agk.prod.knauf.digital`, and both the app repo and `agk-deployment-configs` writes. Human tenant-RG access does not prove pipeline write access to prod ACR or AKS.

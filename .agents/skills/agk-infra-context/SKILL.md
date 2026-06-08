---
name: agk-infra-context
description: Use when working on Agentic Karl / AGK infrastructure, Azure CLI access, AKS, ArgoCD, Key Vault, ExternalSecret, Terraform resources, Helm values, deployment-config repos, release pipelines, or debugging dev/prod deployment behavior for this fork.
---

# AGK Infra Context

This skill is the operational map for Agentic Karl infrastructure. Use it before changing deployment workflows, Azure resources, Key Vault secrets, ArgoCD apps, Helm values, or environment config.

Last verified: 2026-06-05.

## Operating Rules

- Start by checking the current branch and the current Azure subscription. The Azure CLI default can be nonprod or prod depending on the last human command.
- Prefer GitOps and Terraform repo changes over live mutations. Live Azure/Kubernetes/Argo changes are for validation, emergency repair, or secret rotation.
- Do not print or store secret values. Inspect metadata, names, IDs, update timestamps, enabled status, and mappings instead.
- Before mutating ArgoCD or Kubernetes, run read-only checks and/or dry-runs first.
- Use `argocd ... --grpc-web` for `argocd.agk.nonprod.knauf.digital`; keep using it for AGK ArgoCD unless verified otherwise.
- For Key Vault rotations consumed as pod env vars, update Key Vault, refresh ExternalSecret, then restart the Deployment so pods reload env.
- Do not run `terraform init`, `plan`, or `apply` locally against remote state. Infra repo READMEs say CI/CD owns Terraform state access. Local Terraform is for syntax validation only.
- Before changing AGK deploy workflow logic, use `.github/workflows/agk-deploy-smoke.yaml` to validate Azure login, Key Vault reads, GitHub writes, ACR import, deployment-config repo writes, and ArgoCD API access without waiting for the full release pipeline.

## Repos

Use the same repo names regardless of local checkout path. In examples, set `KNAUF_ROOT` to the directory that contains the Knauf repos:

```bash
export KNAUF_ROOT="${KNAUF_ROOT:-$HOME/knauf}"
```

- App repo: `Knauf-Group/agentic-karl` (`$KNAUF_ROOT/agentic-karl`)
- AGK Terraform repo: `Knauf-Group/agk-infrastructure` (`$KNAUF_ROOT/agk-infrastructure`)
- AGK GitOps repo: `Knauf-Group/agk-deployment-configs` (`$KNAUF_ROOT/agk-deployment-configs`)
- Legacy CT shared GitOps repo: `Knauf-Group/ct-shared-deployment-configs` (`$KNAUF_ROOT/ct-shared-deployment-configs`)

Before relying on repo facts, fetch the latest main branches:

```bash
git -C $KNAUF_ROOT/agk-infrastructure fetch origin main
git -C $KNAUF_ROOT/agk-deployment-configs fetch origin main
git -C $KNAUF_ROOT/agentic-karl fetch origin main
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
- App repo `origin/main` currently contains `infrastructure/dev/values.yaml` only. `infrastructure/prod/values.yaml` is still absent and is required for the prod multi-source Agentic Karl service app unless the ApplicationSet/value source is changed.
- Prod service image currently points at `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl:v0.38.0` in GitOps values; prod promotion must intentionally import/publish a newer tag and update the prod values.

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

- Domain: `https://agentic-karl.agk.prod.knauf.digital`
- ACR image: `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl:<version>`
- Config repo path: `$KNAUF_ROOT/agk-deployment-configs/agentic-karl/prod/services/agentic-karl/values.yaml`
- App overlay path: `$KNAUF_ROOT/agentic-karl/infrastructure/prod/values.yaml` (currently missing from app repo `origin/main`)
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

- `DOMAIN_CLIENT`: `https://agentic-karl.agk.prod.knauf.digital`
- `DOMAIN_SERVER`: `https://agentic-karl.agk.prod.knauf.digital`
- `OPENID_CLIENT_ID`: `0oawcorb2pfMcXkHU417`
- `OPENID_ISSUER`: `https://identity.knauf.digital/oauth2/default`
- `OPENID_CALLBACK_URL`: `/oauth/openid/callback`

App code references:

- `$KNAUF_ROOT/agentic-karl/api/strategies/openidStrategy.js`
- `$KNAUF_ROOT/agentic-karl/api/server/routes/oauth.js`

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

Use this split:

- New Azure resource, private endpoint, managed identity, Key Vault, Redis, MongoDB, Blob Storage, PostgreSQL DB/role, network dependency: change `agk-infrastructure`.
- New service deployment, env config, image tag, ingress, resource limits, node placement, ExternalSecret mapping, SecretStore, network policy: change `agk-deployment-configs`.
- App default Helm values, service-owned overrides, `SERVICE_VERSION`, release automation, code behavior: change `agentic-karl`.
- Old dev-only CT deployment: change `ct-shared-deployment-configs` only when maintaining the old CT dev deployment.

For a new service in AGK:

1. Add `{project}/{env}/services/{service}/values.yaml` in `agk-deployment-configs`.
2. Add `Knauf-Group/{service}/infrastructure/{env}/values.yaml` unless the service is intentionally handled by a single-source ApplicationSet.
3. Add namespace shared resources under `{project}/{env}/common-namespace-resources` and `{project}/{env}/network-policy` if needed.
4. Commit to `main`; ArgoCD ApplicationSet creates the app and syncs automatically.

For prod Agentic Karl app onboarding or promotion:

1. Confirm prod DNS, Okta app, secrets, and release policy.
2. Add `$KNAUF_ROOT/agentic-karl/infrastructure/prod/values.yaml`; app repo `origin/main` does not currently have it.
3. Validate existing prod GitOps directories and required manual prod app secrets in `kv-agntkarl-prod-001`; Terraform-managed MongoDB/Redis/Blob/PostgreSQL secrets should come from the infra pipeline.
4. Import/publish the chosen image tag into `acragkhubprod001.azurecr.io/agentic-karl-prod/agentic-karl`, then update prod GitOps image tag and app repo prod overlay values deliberately.
5. Verify ArgoCD app `agentic-karl-prod-agentic-karl` with read-only/dry-run checks before live sync or restart.
6. Update release/promotion automation intentionally; do not let dev release jobs push prod without an approved promotion step.

## GitHub Azure Credentials Caveat

GitHub secret values cannot be read back. Existing release logs prove `AZURE_CREDENTIALS` can read the two CT Key Vaults. To confirm it also covers AGK, verify the secret's `clientId`.

If `AZURE_CREDENTIALS.clientId` is `73332216-62c9-46a5-a3d0-09a353447f9c` (`sp-ct-shared-resources`), prior release logs showed sufficient nonprod access. If it is a different service principal, test or grant reads on `kv-ct-shared-devops-001`, `kv-ct-shared-tools`, and `kv-agk-hub-nonprod-001`, plus import/write into `acragkhubnonprod001`.

Prod release or promotion automation needs separately verified prod credentials for `e0515a24-7205-481b-b657-944901020e32`, `acragkhubprod001`, `kv-agk-hub-prod-001`, `kv-agntkarl-prod-001`, `argocd.agk.prod.knauf.digital`, and both the app repo and `agk-deployment-configs` writes. Human tenant-RG access does not prove pipeline write access to prod ACR or AKS.

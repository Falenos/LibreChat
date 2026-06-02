---
name: agk-infra-context
description: Use when working on Agentic Karl / AGK infrastructure, Azure CLI access, AKS, ArgoCD, Key Vault, ExternalSecret, Terraform resources, Helm values, deployment-config repos, release pipelines, or debugging dev/prod deployment behavior for this fork.
---

# AGK Infra Context

This skill is the operational map for Agentic Karl infrastructure. Use it before changing deployment workflows, Azure resources, Key Vault secrets, ArgoCD apps, Helm values, or environment config.

Last verified: 2026-06-02.

## Operating Rules

- Start by checking the current branch and the current Azure subscription. The Azure CLI default can be nonprod or prod depending on the last human command.
- Prefer GitOps and Terraform repo changes over live mutations. Live Azure/Kubernetes/Argo changes are for validation, emergency repair, or secret rotation.
- Do not print or store secret values. Inspect metadata, names, IDs, update timestamps, enabled status, and mappings instead.
- Before mutating ArgoCD or Kubernetes, run read-only checks and/or dry-runs first.
- Use `argocd ... --grpc-web` for `argocd.agk.nonprod.knauf.digital`; keep using it for AGK ArgoCD unless verified otherwise.
- For Key Vault rotations consumed as pod env vars, update Key Vault, refresh ExternalSecret, then restart the Deployment so pods reload env.
- Do not run `terraform init`, `plan`, or `apply` locally against remote state. Infra repo READMEs say CI/CD owns Terraform state access. Local Terraform is for syntax validation only.

## Repos

- App repo: `/Users/ZaharA/knauf/agentic-karl`
- AGK Terraform repo: `/Users/ZaharA/knauf/agk-infrastructure`
- AGK GitOps repo: `/Users/ZaharA/knauf/agk-deployment-configs`
- Old CT shared GitOps repo: `/Users/ZaharA/knauf/ct-shared-deployment-configs`

Before relying on repo facts, fetch the latest main branches:

```bash
git -C /Users/ZaharA/knauf/agk-infrastructure fetch origin main
git -C /Users/ZaharA/knauf/agk-deployment-configs fetch origin main
git -C /Users/ZaharA/knauf/agentic-karl fetch origin main
```

## Azure CLI Access

Known tenant:

- Tenant name: `Knauf`
- Tenant ID: `ad200093-0cba-48cb-9853-16fb53354a4d`
- User: `ZaharA@knauf.com`

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

## Access Snapshot

Known nonprod access from the current session:

- Subscription-wide Reader via group `C-CT-Developers`.
- Owner on `rg-agk-hub-nonprod-westeurope`.
- Owner on `rg-agk-nonprod-westeurope`.
- Owner on `rg-agentic-karl-tenant-nonprod-westeurope`.
- Owner on Cosmos DB account `cosmos-ct-shared-westeurope-ai-mongo-001`.
- Key Vault Secrets Officer on `kv-agntkarl-nonprod-001`.

Practical nonprod scope: read-only across the subscription, full control on AGK nonprod resource groups, and secret operations on the AGK tenant Key Vault.

Do not assume identical personal access in prod without checking. Prod resources are visible from Azure CLI in `CT-SHARED-RESOURCES-PROD`, but mutation should go through the prod Terraform/GitOps pipelines unless explicitly approved.

## Subscription Inventory Snapshot

Nonprod `CT-SHARED-RESOURCES` snapshot from this session:

- Resource groups: 63.
- Total visible Azure resources: 593.
- Main region: `westeurope`.
- Key AKS clusters: `aks-ct-shared-001`, `aks-karl-dev-001`, `aks-agk-nonprod-001`.
- Key ACRs: `acrctshared001`, `acrkarldev001`, `acragkhubnonprod001`, `acrpdashared`, `acrcnshared`, `acrdarcsharedlakehouse`.
- AGK-owned nonprod hub RG contains firewall, Bastion, VM, ACR, Key Vault, PostgreSQL, and private DNS.
- AGK-owned nonprod spoke RG contains AKS `aks-agk-nonprod-001`, VNet, ACI, managed identities, and route table resources.
- Agentic Karl tenant RG contains the app Key Vault, Redis, Cosmos/Mongo, Blob Storage, private endpoints, private DNS links, and External Secrets identity.

Prod `CT-SHARED-RESOURCES-PROD` AGK resource groups are visible and mirror the same hub/spoke/tenant model:

- `rg-agk-hub-prod-westeurope`
- `rg-agk-prod-westeurope`
- `rg-agentic-karl-tenant-prod-westeurope`

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

- `/Users/ZaharA/knauf/agk-infrastructure/docs/SHARED-AZURE-FIREWALL.md` for shared firewall/route-table work.
- `/Users/ZaharA/knauf/agk-infrastructure/docs/CONFLUENT-CLOUD-PEERING.md` for Kafka/Confluent private peering.

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

- `agk-deployment-configs` currently contains `agentic-karl/dev/...` only.
- No `agentic-karl/prod/...` service values were present at last verification. Prod Azure tenant resources exist, but prod app deployment through ArgoCD still requires prod GitOps directories and app repo `infrastructure/prod/values.yaml`.
- Dev services present: `agentic-karl`, `agentic-karl-rag-api`, `agentic-karl-meilisearch`, plus `common-namespace-resources` and `network-policy`.

ArgoCD bootstrap workflows in `agk-deployment-configs`:

- Nonprod workflow targets `aks-agk-nonprod-001`, `rg-agk-nonprod-westeurope`, `acragkhubnonprod001`, `kv-agk-hub-nonprod-001`, runner `agk-dc-nonprod-runner`, secret `ENV_AZURE_CREDENTIALS_NONPROD`.
- Prod workflow targets `aks-agk-prod-001`, `rg-agk-prod-westeurope`, `acragkhubprod001`, `kv-agk-hub-prod-001`, runner `agk-dc-prod-runner`, secret `ENV_AZURE_CREDENTIALS_PROD`.

## Agentic Karl Azure Resources

Nonprod tenant root:

- Terraform: `/Users/ZaharA/knauf/agk-infrastructure/terraform/subscription/nonprod/tenant/agentic-karl`
- Subscription: `CT-SHARED-RESOURCES`.
- Tenant RG: `rg-agentic-karl-tenant-nonprod-westeurope`.
- Tenant state: `rg-agk-nonprod-tfstate-westeurope` / `agknonprodwestfstate` / `tfstate` / `agk.tenant.agentic-karl.tfstate`.
- App state: same backend with key `agk.tenant.agentic-karl.agentic-karl.tfstate`.
- AKS: `aks-agk-nonprod-001` in `rg-agk-nonprod-westeurope`.
- Hub RG: `rg-agk-hub-nonprod-westeurope`.
- Hub ACR: `acragkhubnonprod001`.
- Hub Key Vault: `kv-agk-hub-nonprod-001`.
- Tenant Key Vault: `kv-agntkarl-nonprod-001`.
- MongoDB vCore: `cosmos-agk-nonprod-westeurope-001`.
- Redis: `redis-agk-nonprod-westeurope-redis-agk-dev-001`.
- Blob storage: `agkblobdevwesteu`, file share `karlshare`, container `files`.
- External Secrets MI: `mi-agentic-karl-dev-westeurope-aks-external-secrets-001`.
- PostgreSQL server: `pgsql-agk-hub-nonprod-westeurope-001`.
- PostgreSQL DB: `agentic-karl-dev`.

Prod tenant root:

- Terraform: `/Users/ZaharA/knauf/agk-infrastructure/terraform/subscription/prod/tenant/agentic-karl`
- Subscription: `CT-SHARED-RESOURCES-PROD`.
- Tenant RG: `rg-agentic-karl-tenant-prod-westeurope`.
- Tenant state: `rg-agk-prod-tfstate-westeurope` / `agkprodwestfstate` / `tfstate` / `agk.tenant.agentic-karl.tfstate`.
- App state: same backend with key `agk.tenant.agentic-karl.agentic-karl.tfstate`.
- AKS: `aks-agk-prod-001` in `rg-agk-prod-westeurope`.
- Hub RG: `rg-agk-hub-prod-westeurope`.
- Hub ACR: `acragkhubprod001`.
- Hub Key Vault: `kv-agk-hub-prod-001`.
- Tenant Key Vault: `kv-agntkarl-prod-001`.
- MongoDB vCore: `cosmos-agk-prod-westeurope-001`.
- Redis: `redis-agk-prod-westeurope-redis-agk-prod-001`.
- Blob storage: `agkblobprodwesteu`, container `files`.
- External Secrets MI: `mi-agentic-karl-prod-westeurope-aks-external-secrets-001`.
- PostgreSQL server: `pgsql-agk-hub-prod-westeurope-001`.
- PostgreSQL DB: `agentic-karl-prod`.

## Agentic Karl Dev Runtime

New AGK dev:

- Domain: `https://agentic-karl.agk.dev.knauf.digital`
- ACR image: `acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl:<version>`
- Config repo path: `/Users/ZaharA/knauf/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`
- App overlay path: `/Users/ZaharA/knauf/agentic-karl/infrastructure/dev/values.yaml`
- ArgoCD domain: `argocd.agk.nonprod.knauf.digital`
- ArgoCD app: `agentic-karl-dev-agentic-karl`
- Namespace: `agentic-karl-dev`

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

App code references:

- `/Users/ZaharA/knauf/agentic-karl/api/strategies/openidStrategy.js`
- `/Users/ZaharA/knauf/agentic-karl/api/server/routes/oauth.js`

## Secrets And External Secrets

Nonprod External Secrets service account and SecretStore live in:

- `/Users/ZaharA/knauf/agk-deployment-configs/agentic-karl/dev/common-namespace-resources/values.yaml`

Known nonprod values:

- ServiceAccount: `sa-external-secrets`.
- Workload identity client ID: `b573fdae-1009-46d4-8c58-16694e48f65f`.
- Tenant ID: `ad200093-0cba-48cb-9853-16fb53354a4d`.
- SecretStore: `kv-agntkarl-nonprod-001`.
- Vault URL: `https://kv-agntkarl-nonprod-001.vault.azure.net/`.

Known prod External Secrets identity from Azure/Terraform:

- Expected ServiceAccount: `sa-external-secrets` in namespace `agentic-karl-prod`.
- Workload identity client ID: `af3876d3-0183-4213-8877-e66daff78ef2`.
- Federated subject: `system:serviceaccount:agentic-karl-prod:sa-external-secrets`.
- SecretStore should point at `kv-agntkarl-prod-001`.
- Vault URL should be `https://kv-agntkarl-prod-001.vault.azure.net/`.

Main app ExternalSecret lives in:

- `/Users/ZaharA/knauf/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`

Important nonprod mappings:

- `OPENID_CLIENT_SECRET` <- `AGK-OPENID-CLIENT-SECRET`
- `OPENID_SESSION_SECRET` <- `AGK-OPENID-SESSION-SECRET`
- `MONGO_URI` <- `agentic-karl-MONGODB-CONNECTION-STRING`
- `REDIS_URI` <- `agentic-karl-REDIS-CONNECTION-STRING`
- `AZURE_STORAGE_CONNECTION_STRING` <- `agentic-karl-BLOB-STORAGE-CONNECTION-STRING`
- OpenAI/Azure OpenAI env vars <- `AGK-OPENAI-API-KEY`
- Blob storage volume secret keys reference `AGK-AZURE-STORAGEACCOUNT-NAME` and `AGK-AZURE-STORAGEACCOUNT-KEY`.

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

As of last verification, `origin/main` in the app repo still has only the CT shared release job in `.github/workflows/release_pipeline.yaml`. Open PR `#51` (`deploy-both-devs`) adds AGK dev deployment after the CT release; verify whether it has merged before assuming dual deployment is live.

Intended dual-dev flow:

1. Existing CT release job builds and publishes `acrctshared001.azurecr.io/tools-non-prod/agentic-karl:<version>`.
2. AGK deploy job imports the same tag into `acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl:<version>`.
3. Workflow commits the version to:
   - `/Users/ZaharA/knauf/agentic-karl/infrastructure/dev/values.yaml`
   - `/Users/ZaharA/knauf/agk-deployment-configs/agentic-karl/dev/services/agentic-karl/values.yaml`
4. ArgoCD auto-syncs `agentic-karl-dev-agentic-karl`; workflow can refresh and poll for Synced/Healthy.

Important AGK dev workflow constants from PR `#51`:

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

The Key Vault rotation issue from this session was resolved by refreshing the ExternalSecret path and restarting pods so they picked up the latest `AGK-OPENID-CLIENT-SECRET`.

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

For prod Agentic Karl app onboarding:

1. Confirm prod DNS, Okta app, secrets, and release policy.
2. Add `/Users/ZaharA/knauf/agentic-karl/infrastructure/prod/values.yaml`.
3. Add `agentic-karl/prod/common-namespace-resources`, `agentic-karl/prod/network-policy`, and `agentic-karl/prod/services/agentic-karl` in `agk-deployment-configs`.
4. Use prod ACR `acragkhubprod001`, prod namespace `agentic-karl-prod`, prod Key Vault `kv-agntkarl-prod-001`, and prod app resources from the prod Terraform tenant.
5. Expected generated ArgoCD app name is `agentic-karl-prod-agentic-karl` once the prod service directory exists.
6. Update release/promotion automation intentionally; do not let dev release jobs push prod without an approved promotion step.

## GitHub Azure Credentials Caveat

GitHub secret values cannot be read back. Existing release logs prove `AZURE_CREDENTIALS` can read the two CT Key Vaults. To confirm it also covers AGK, verify the secret's `clientId`.

If `AZURE_CREDENTIALS.clientId` is `73332216-62c9-46a5-a3d0-09a353447f9c` (`sp-ct-shared-resources`), it has sufficient nonprod access:

- Owner on subscription `ad3f0a71-cc5b-4d00-8289-23623cf2064c`.
- Member of `C-CT-devops`.
- Access to CT and AGK Key Vaults through group/direct policies.

If it is a different service principal, test or grant:

- Read `kv-ct-shared-devops-001`.
- Read `kv-ct-shared-tools`.
- Import/write into `acragkhubnonprod001`.
- Read `kv-agk-hub-nonprod-001`.

Prod release or promotion automation needs separately verified prod credentials for `e0515a24-7205-481b-b657-944901020e32`, `acragkhubprod001`, `kv-agk-hub-prod-001`, and `kv-agntkarl-prod-001`.

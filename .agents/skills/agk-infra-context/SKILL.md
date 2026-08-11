---
name: agk-infra-context
description: Use when working on Agentic Karl / AGK infrastructure, architecture maps, Azure CLI, AKS, ArgoCD, Key Vault, ExternalSecret, Terraform, Helm/GitOps values, release and promotion pipelines, adding services, or debugging dev, stage, or prod deployments in this fork.
---

# AGK Infra Context

Operational map and safety rules for Agentic Karl infrastructure.

Last verified: 2026-08-11 against fetched `main` for the owning repositories, live Azure control-plane metadata, current GitOps values, and public stage HTTPS checks.

Do not treat this file as a deployment-state cache. GitOps, Terraform, Azure, Kubernetes, and ArgoCD remain authoritative. Do not add mutable image tags, temporary PR dependency trees, or point-in-time health claims here.

## Start Here

1. Check the current branch and preserve unrelated work:
   ```bash
   git status --short --branch
   ```
2. Set `KNAUF_ROOT` explicitly to the directory containing the Knauf repositories.
3. Fetch current `main` without changing worktrees:
   ```bash
   git -C "$KNAUF_ROOT/agentic-karl" fetch origin main
   git -C "$KNAUF_ROOT/agentic-karl-rag-api" fetch origin main
   git -C "$KNAUF_ROOT/agk-infrastructure" fetch origin main
   git -C "$KNAUF_ROOT/agk-deployment-configs" fetch origin main
   ```
   Fetch the relevant additional owner (`Customer-Tech-Shared`, `agentic-karl-quality`, or legacy GitOps) when the task crosses into it.
4. Check Azure identity and subscription before every cloud operation:
   ```bash
   az account show --query '{name:name,id:id,tenantId:tenantId,principal:user.name,type:user.type}' -o json
   ```
5. Pass `--subscription` on read-only commands. Change the CLI default only when a command cannot accept an explicit subscription.
6. Use the routing table below and load only the references relevant to the task. Recheck mutable facts in their owning source before answering “current” or “latest.”

If Azure is not authenticated:

```bash
az login --tenant ad200093-0cba-48cb-9853-16fb53354a4d
```

## Reference Routing

Read each linked reference when its task applies. Do not rely on the short summary in this file when the detailed procedure is relevant.

| Task                                                                                                                        | Required reference                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure login, subscriptions, human RBAC, control-plane vs data-plane access, GitHub Actions/service-principal permissions    | [Access and identities](references/access-and-identities.md)                                                                                       |
| AKS or ArgoCD inspection, ExternalSecret refresh, restarts, private endpoints, VPN/DNS diagnosis, private Mongo maintenance | [Runtime operations](references/runtime-operations.md)                                                                                             |
| Terraform placement/state/workflows, adding a service, deployment workflow changes, pre-PR and promotion checks             | [Infrastructure change workflows](references/infrastructure-change-workflows.md)                                                                   |
| Langfuse authentication boundaries, trace lookup, LangGraph observations, missing traces, and storage-access failures       | [Langfuse troubleshooting](references/langfuse-troubleshooting.md); use the generic `langfuse` skill for current CLI/API syntax                    |
| Full dev/stage/prod topology, repositories, service dependencies, data stores, observability, and release flows             | [Architecture reference](../../../knauf/docs/reference/agentic-karl-architecture.md) — inspect its table of contents and load the relevant section |
| File upload/storage lifecycle and image handling                                                                            | [File architecture overview](../../../knauf/docs/architecture/files/overview.md)                                                                   |
| Conversation, Project, and Agent Knowledge retrieval                                                                        | [RAG search](../../../knauf/docs/architecture/files/rag-search.md)                                                                                 |
| Queueing, workers, retry policy, generations, and deletion                                                                  | [Async indexing](../../../knauf/docs/architecture/files/async-indexing.md)                                                                         |

The bundled references preserve durable operational guidance. The architecture documents preserve detailed system behavior. Owning repositories and live systems remain authoritative for mutable state.

## Operating Rules

- Prefer GitOps and Terraform changes over live mutations.
- Use live Azure, Kubernetes, and ArgoCD mutations only for approved validation, emergency repair, or secret rotation.
- Never print or store secret values. Inspect names, IDs, enabled state, timestamps, mappings, and resource metadata.
- Run read-only checks or dry-runs before Kubernetes or ArgoCD mutations.
- Use `argocd ... --grpc-web` for AGK ArgoCD.
- Do not run local Terraform against remote state. CI/CD owns state access. Local Terraform is limited to formatting and `terraform init -backend=false` plus `terraform validate`.
- For Key Vault values consumed as pod environment variables: update Key Vault, refresh the ExternalSecret, then restart the Deployment.
- Prove no existing Terraform root, backend key, workflow, or lifecycle owner exists before creating one.
- Place external-provider resources with the application or platform lifecycle that owns them; do not create provider-named roots for credential convenience.
- Validate deployment workflow changes with `.github/workflows/agk-deploy-smoke.yaml` before relying on a full release. Running it requires explicit mutation approval because it creates and deletes temporary branches/images even though it does not change real release tags.

## Sources Of Truth

| Concern                                                                         | Owner                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| App code, `librechat.yaml`, service overlays, app release workflows             | `Knauf-Group/agentic-karl`                                                                      |
| RAG behavior and RAG release workflows                                          | `Knauf-Group/agentic-karl-rag-api`                                                              |
| Azure resources, identities, private endpoints, DNS, Terraform secrets          | `Knauf-Group/agk-infrastructure`                                                                |
| Kubernetes values, image tags, ingress, ExternalSecret mappings, network policy | `Knauf-Group/agk-deployment-configs`                                                            |
| Admin panel and Langfuse image promotion                                        | `agk-deployment-configs/.github/workflows/promote-*.yaml`; upstream images are externally owned |
| Shared Terraform modules referenced by infrastructure                           | `Knauf-Group/Customer-Tech-Shared`                                                              |
| Stage E2E and k6 quality gates                                                  | `Knauf-Group/agentic-karl-quality`                                                              |
| Legacy CT dev only                                                              | `Knauf-Group/ct-shared-deployment-configs`                                                      |
| Full shareable topology                                                         | `agentic-karl/knauf/docs/reference/agentic-karl-architecture.md`                                |
| Live resource existence and model/router policy                                 | Azure control plane                                                                             |
| Deployed health and rendered manifests                                          | ArgoCD and Kubernetes                                                                           |

## Azure Foundry And Model Safety

AGK owns private Foundry accounts in the nonprod and prod hub resource groups. GitOps selects runtime deployments:

- Default KARL, memory, and titles use `model-router-chat`, a stable alias for `model-router` over the Foundry **project** endpoint Responses API (`serverless: true`, `useResponsesApi: true`). The account-level endpoint does not support this route.
- Created agents and prompt drafting use `agent-default`, resolved through `AZURE_FOUNDRY_AGENT_DEPLOYMENT`.
- Verify the direct deployment separately for dev, stage, and prod; do not assume nonprod environments match.
- Image generation uses the deployment selected by `IMAGE_GEN_OAI_BASEURL` and `IMAGE_GEN_OAI_MODEL` in GitOps.
- RAG embeddings and Document Intelligence use the environment-specific Foundry endpoints declared in RAG GitOps values.

### Azure Model Router request invariant

- Router candidates are heterogeneous. A request option is safe only when every configured candidate accepts the same option and value.
- Do not add `verbosity` to the default KARL model spec, Azure endpoint defaults, agent parameters, or Responses request without end-to-end compatibility tests against every candidate.
- `verbosity: low` becomes `text.verbosity: low` and has caused Foundry HTTP 400 `unsupported_value` failures before tools can run.
- Keep concise behavior in the KARL prompt.
- Keep the provider-side `maxTokens: 8192` safety fuse unless production truncation evidence justifies a reviewed change.
- `maxTokens` maps to Responses `max_output_tokens` and covers reasoning plus visible output. AGK removes a failed partial response and retries once with the existing compact replacement instruction. A second output-limit stop fails the turn instead of persisting truncated output.

Verify deployments and router policy with the management API. The generic deployment command may use an older API and omit routing:

```bash
az cognitiveservices account deployment list \
  --subscription <subscription-id> \
  --resource-group <hub-resource-group> \
  --name <foundry-account> \
  --query '[].{deployment:name,state:properties.provisioningState,model:properties.model.name,version:properties.model.version,sku:sku.name,capacity:sku.capacity,raiPolicy:properties.raiPolicyName}' \
  -o table

az rest --method get \
  --url 'https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<hub-resource-group>/providers/Microsoft.CognitiveServices/accounts/<foundry-account>/deployments/model-router?api-version=2026-03-01' \
  --query '{state:properties.provisioningState,routing:properties.routing}' \
  -o json
```

`GlobalStandard` capacity controls quota; it is not provisioned throughput or a fixed PTU charge.

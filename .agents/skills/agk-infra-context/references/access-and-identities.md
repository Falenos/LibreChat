# Access And Identities

Use this reference for Azure CLI authentication, subscription selection, RBAC diagnosis, GitHub Actions credentials, or any question about who can access an AGK resource.

## Contents

- [Identity boundaries](#identity-boundaries)
- [Tenant and subscriptions](#tenant-and-subscriptions)
- [Effective human access](#effective-human-access)
- [GitHub Actions and release credentials](#github-actions-and-release-credentials)
- [Safe inventory](#safe-inventory)

## Identity Boundaries

Treat these as independent identities and permission systems:

- the signed-in Azure CLI human;
- the GitHub Actions workload identity or service principal;
- the External Secrets workload identity in each namespace;
- the ArgoCD user/session;
- Kubernetes RBAC for the selected AKS context.

Human access does not prove pipeline access. Azure control-plane access does not prove service data-plane access. Azure RBAC does not prove ArgoCD or Kubernetes RBAC.

Never hard-code a colleague's current roles or assume inherited group membership. Verify the effective identity and scope for the operation being diagnosed.

## Tenant And Subscriptions

Tenant: `Knauf` (`ad200093-0cba-48cb-9853-16fb53354a4d`).

| Environment   | Subscription               | ID                                     |
| ------------- | -------------------------- | -------------------------------------- |
| Dev and stage | `CT-SHARED-RESOURCES`      | `ad3f0a71-cc5b-4d00-8289-23623cf2064c` |
| Prod          | `CT-SHARED-RESOURCES-PROD` | `e0515a24-7205-481b-b657-944901020e32` |

Authenticate and confirm the active identity:

```bash
az login --tenant ad200093-0cba-48cb-9853-16fb53354a4d
az account show --query '{name:name,id:id,tenantId:tenantId,principal:user.name,type:user.type}' -o json
```

Pass `--subscription <subscription-id>` to read-only commands. Change the CLI default only when a command cannot accept an explicit subscription, then immediately verify it with `az account show`.

## Effective Human Access

Resolve the current human object ID and inspect inherited assignments at the narrowest relevant scope:

```bash
AGK_USER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"
az role assignment list \
  --assignee "$AGK_USER_OBJECT_ID" \
  --include-groups \
  --include-inherited \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>" \
  --query '[].{role:roleDefinitionName,scope:scope,principalType:principalType,principalName:principalName}' \
  -o table
```

Use this lookup only when `az account show` reports a human user. For a service principal, managed identity, or federated workflow, resolve the principal object ID from the owning identity/workflow instead. If Microsoft Graph access blocks `az ad signed-in-user show`, use the independently verified human object ID; do not guess from a display name.

An Azure resource-group `Owner` or `Contributor` assignment covers resource management, not every data plane:

- Key Vault secret contents require an appropriate Key Vault data-plane role such as `Key Vault Secrets Officer` or `Key Vault Administrator`.
- Blob contents require `Storage Blob Data Reader`, `Storage Blob Data Contributor`, or `Storage Blob Data Owner` according to the operation.
- ACR publishing and cross-registry import have different action/data permissions. Verify the exact source-read and target-import requirements and registry role-assignment mode; do not assume `AcrPush` alone grants import.
- AKS debugging requires Azure cluster access plus Kubernetes RBAC; Azure `Reader` alone does not grant pod logs, restarts, or secret access.
- ArgoCD application read/sync access is separate from Azure and Kubernetes RBAC.

Use current Azure role definitions and organization policy as the authority; the examples above describe the permission boundary, not a grant request.

## GitHub Actions And Release Credentials

List GitHub secret names only as metadata:

```bash
gh secret list --repo Knauf-Group/<repository>
```

GitHub secret values cannot be read back. Do not infer the credential's `clientId`, tenant, subscription, or permissions from the secret name or an old workflow log.

Verify a release identity through the owning workflow or the isolated smoke workflow. For AGK app deployment changes, `.github/workflows/agk-deploy-smoke.yaml` checks the required Azure, Key Vault, GitHub, ACR, deployment-config, and ArgoCD boundaries without changing real release tags. It still creates and deletes temporary branches/images, so running it requires explicit mutation approval; do not use it during a strictly read-only audit.

Verify nonprod and prod independently. A working nonprod identity does not prove access to the prod subscription, ACR, Key Vaults, AKS/ArgoCD, or GitHub repositories.

For a release or promotion identity, verify only the capabilities the workflow needs:

1. Azure login in the intended tenant and subscription.
2. Read access to the exact Key Vault secrets used by the workflow.
3. Import/write access to the target ACR repository.
4. Read/write access to the owning app and GitOps repositories.
5. ArgoCD read/refresh/sync access required by that workflow.
6. Access to any provenance artifact or prior workflow run required by promotion.

Do not replace a missing permission with a broader credential or a new side pipeline. Fix the existing lifecycle owner's identity and scope.

## Safe Inventory

Inspect counts or metadata before requesting broader access:

```bash
az group list --subscription <subscription-id> --query 'length(@)'
az resource list --subscription <subscription-id> --resource-group <resource-group> \
  --query '[].{name:name,type:type,location:location}' -o table
az keyvault secret list --subscription <subscription-id> --vault-name <vault-name> \
  --query '[].{name:name,enabled:attributes.enabled,updated:attributes.updated}' -o table
```

Never print secret values, connection strings, tokens, kubeconfig contents, or GitHub credential payloads.

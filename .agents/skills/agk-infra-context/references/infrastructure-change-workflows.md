# Infrastructure Change Workflows

Use this reference when placing Terraform or GitOps changes, adding a service, changing deployment automation, or preparing an infrastructure PR.

## Contents

- [Choose the lifecycle owner](#choose-the-lifecycle-owner)
- [Terraform roots and workflows](#terraform-roots-and-workflows)
- [Add a service](#add-a-service)
- [Change release or promotion automation](#change-release-or-promotion-automation)
- [Review before a PR](#review-before-a-pr)

## Choose The Lifecycle Owner

Start from resource lifecycle and ownership, not provider name or credential convenience.

| Change                                                                                                     | Default owner                                                           |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Hub-wide services, tfstate bootstrap, hub VNet/firewall/Bastion, hub ACR/Key Vault, PostgreSQL server      | `agk-infrastructure/terraform/subscription/<env>/base/hub/<layer>`      |
| Spoke AKS, subnets, runners, workload identities, and route tables                                         | `agk-infrastructure/terraform/subscription/<env>/base/<env>/<layer>`    |
| Tenant resource group, Key Vault, storage, Redis, MongoDB, tenant External Secrets identity                | `agk-infrastructure/terraform/subscription/<env>/tenant/<tenant>`       |
| App databases, roles, bindings, app-owned secrets, and app-owned external-provider resources               | `agk-infrastructure/terraform/subscription/<env>/tenant/<tenant>/<app>` |
| Kubernetes image/config, ingress, probes, limits, ExternalSecret mappings, SecretStore, and network policy | `agk-deployment-configs/<project>/<env>/...`                            |
| Service Helm defaults, overlays, release automation, and code behavior                                     | owning service repository                                               |
| Legacy CT dev deployment only                                                                              | `ct-shared-deployment-configs`                                          |

Choose the narrowest existing lifecycle owner. Do not create a provider-named Terraform root merely because credentials differ. A new root, backend key, workflow, or credential path needs a separate owner, apply cadence, or shared lifecycle that the existing layers cannot represent.

## Terraform Roots And Workflows

Read the current `agk-infrastructure` workflow and root READMEs before describing apply order or path filters. CI/CD owns remote state access.

Read `agk-infrastructure/docs/SHARED-AZURE-FIREWALL.md` for shared firewall or route-table work. Read `agk-infrastructure/docs/CONFLUENT-CLOUD-PEERING.md` for Kafka/Confluent private peering.

- Reuse an existing root and applying workflow when its lifecycle matches.
- Add provider credentials to that owner workflow; do not create a side pipeline for credential convenience.
- Include a changed workflow path in its PR/push path filters when the workflow must validate itself.
- Preserve private-network requirements when selecting runners. Install a missing CLI in the existing job when practical instead of changing the runner boundary.
- Reuse an established shared module when it fits. Pin external modules to an immutable tag or commit.
- Use a direct Terraform resource in the correct root when no suitable module exists.

Pull requests normally plan and merges to `main` apply through the owning workflow; `workflow_dispatch` may discover multiple configured roots or layers. Verify current triggers, path filters, discovery logic, and `needs` ordering in the workflow instead of assuming one universal layer order.

Limit local Terraform to formatting and backend-disabled validation:

```bash
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate -no-color
```

Never run a local plan or apply against AGK remote state. Remove only `.terraform` or lock artifacts created by the validation run; preserve every pre-existing repository file, including a committed `.terraform.lock.hcl`.

## Add A Service

1. Identify the owning repository, environments, namespace, image repository, ingress, external dependencies, data lifecycle, and secrets.
2. Search existing AGK environments and sibling Knauf repositories before designing a new pattern:
   ```bash
   rg -n '<service-or-provider>|ExternalSecret|SecretStore|ingress|networkPolicy' \
     "$KNAUF_ROOT/agk-deployment-configs" "$KNAUF_ROOT/agk-infrastructure"
   ```
3. Add or update `Knauf-Group/<service>/infrastructure/<env>/values.yaml` only when the service has an owning repository and the ApplicationSet expects service-owned values. For externally owned images, inspect the current single-source/local-service ApplicationSet pattern instead of inventing a repository.
4. Add GitOps values at `agk-deployment-configs/<project>/<env>/services/<service>/values.yaml`.
5. Update `common-namespace-resources` or network policy only when the namespace needs a new shared resource or connection.
6. Classify every secret:
   - Terraform-generated infrastructure output: create it in the existing tenant/app root and let CI/CD write Key Vault.
   - Manually managed application configuration: update the correct Key Vault through the approved process.
7. Map source secret names to runtime environment variables in the service GitOps values. Never store the value in Git.
8. Add only the Azure/provider resources the service actually needs and place them with their lifecycle owner.
9. Verify image repository/tag ownership and release workflow. For externally owned images, prefer the established reviewed import/promotion pattern into the environment ACR; never deploy `latest` or assume the main app release rail owns it. Do not hand-edit workflow-owned tags.
10. Inspect ArgoCD status and dry-run before an approved sync. Use rendered manifests or diff only when required and handle their output as sensitive because values or rendered Secret data can appear.

## Change Release Or Promotion Automation

Fetch the current app, RAG, infrastructure, and GitOps owners before editing workflow semantics. Use `.github/workflows/agk-deploy-smoke.yaml` to validate dependency access without changing real release tags only after explicit mutation approval: it creates and deletes temporary branches/images and is not a read-only audit.

Keep release rails independent:

- `agentic-karl` and `agentic-karl-rag-api` own separate versions and workflows.
- When an app change requires a RAG change, manually bump, coordinate, and release both repositories.
- Deploy the compatible RAG contract before the dependent app image.
- Do not claim digest/provenance guarantees for a workflow that operates only on mutable tags.

For production promotion, verify:

1. The workflow's required stage run, provenance artifact, source tag, or source digest according to the owning repository.
2. The target GitOps paths and all images updated together by the workflow.
3. Prod Azure identity, Key Vault, ACR, repository, and ArgoCD permissions independently from nonprod.
4. Required DNS, identity-provider application, runtime secrets, and environment overlays.
5. Read-only ArgoCD state and a dry-run before an approved live action.

Do not let a dev release update prod without the repository's reviewed promotion boundary.

## Review Before A PR

- Confirm the current branch and fetch `main` for every owner used as evidence.
- Confirm the Azure tenant, subscription, and identity for live checks.
- State the lifecycle owner, Terraform root/state key if applicable, and applying workflow in the PR.
- Explain why no new root/state/workflow is required, or document the lifecycle reason when one is unavoidable.
- Search sibling environments and related Knauf repositories for the established pattern.
- Inspect GitHub secret names as metadata only; do not infer values or permissions.
- Run YAML/action checks when workflows change.
- Run Terraform formatting and backend-disabled validation only.
- Inspect CI plans for destroys, unexpected replacements, new backend keys, and resources outside the intended owner.
- Run ArgoCD status checks and dry-runs before approved live actions. Inspect rendered manifests/diffs only when necessary and keep their potentially sensitive output out of chat and logs.
- Update the architecture reference when stable topology, ownership, or environment flow changes.
- Update the skill/reference files when a durable operational procedure or safety invariant changes.

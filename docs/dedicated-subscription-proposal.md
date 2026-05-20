# Proposal: Dedicated Azure Subscription Model for agentic-karl Infrastructure


## Original proposal

### Objective

To improve operational efficiency, deployment agility, and infrastructure ownership,
we propose establishing dedicated Azure subscriptions for the application
environments under the direct management of the application engineering team.

The goal is to reduce operational dependency on DevOps teams for routine
infrastructure activities while still maintaining collaboration for complex or
organization-wide scenarios when necessary.

### Current Challenges

The current shared infrastructure model introduces operational dependencies that
impact day-to-day engineering activities. Key challenges include:

- Limited permissions within shared Azure environments
- Dependency on external teams for routine infrastructure changes
- Approval-based workflows for standard operational tasks
- Delays in provisioning and troubleshooting activities
- Reduced agility in managing Terraform and cloud resources

While centralized governance remains important, the current model creates
unnecessary overhead for routine infrastructure management and operational support. (Violation of Conways Law)

### Proposed Approach

We propose creating separate Azure subscriptions for:

| Environment | Subscription Model     |
|-------------|------------------------|
| Development | Dedicated Subscription |
| Production  | Dedicated Subscription |

These subscriptions would be managed directly by the application engineering team
with the appropriate level of access required for infrastructure operations and
support.

Today agentic-karl is a tenant of the shared CT non-prod infrastructure.

Every one of these resources sits in a Terraform state file shared with every
other tenant of the shared subscription. Two structural consequences follow:

A dedicated subscription + dedicated repo  before going live means migration (e.g. of terraform state)
migration is ever needed.


The pattern this proposal asks for is already firmly established at Knauf, see CMS as a blueprint.
Repository: `Knauf-Group/cms-cf-infrastructure`

Companion repo: `Knauf-Group/cms-cf-deployment-configs`
with a dedicated Azure CMS subscription.

- Subscription base coupling (Hub&Spoke, VNet, etc) should follow the same approach.

- Modules sourced from Customer-Tech-Shared via per-module Git tags —
  exactly the pattern CMS already uses today. Customer-Tech-Shared
  publishes per-module SemVer tags of the form `<module><version>`
  (e.g. `vnet10.1.1`, `snet12.0.0`, `peer13.0.1`), and consumers
  reference them directly:

  ```hcl
  module "vnet-aks-spoke" {
    source = "git::https://github.com/Knauf-Group/Customer-Tech-Shared.git//infrastructure/terraform/modules/vnet?ref=vnet10.1.1"
    # ...
  }

  module "snet-clusternodes" {
    source = "git::https://github.com/Knauf-Group/Customer-Tech-Shared.git//infrastructure/terraform/modules/snet?ref=snet12.0.0"
    # ...
  }

  module "peering_aks_spoke_to_shared_hub" {
    source = "git::https://github.com/Knauf-Group/Customer-Tech-Shared.git//infrastructure/terraform/modules/peer?ref=peer13.0.1"
    # ...
  }
  ```

  This means we can consume the Customer-Tech-Shared module catalog
  exactly as CMS does, today, with no changes needed on the
  Customer-Tech-Shared or DevOps side. `ct-shared-infra` itself still
  uses an older `azurerm_<version>` combined tag in places — that does
  not block us; we adopt the per-module tags directly.

  Our new infrastructure repository consumes the Cloud Infrastructure Base
but does not own it.

**Per-module versioning for our own modules.** For modules we build
inside `agentic-karl-infrastructure` we use
[terraform-module-releaser](https://github.com/techpivot/terraform-module-releaser).
It is a GitHub Action that gives every module directory its own SemVer
tag (`Cosmos4MongoDB/v1.2.3`, …) plus release notes. We adopt this
inside our own repo for the modules we own — no dependency on
Customer-Tech-Shared or the platform team.

Like CMS, we own our own hub in our subscription and peer it to the CT
shared hubs for DNS resolution. 

**Companion app-deployment repo**

We propose a **dedicated `agentic-karl-deployment-configs` repo** for the
ArgoCD side, mirroring the CMS pair (`cms-cf-infrastructure` +
`cms-cf-deployment-configs`).

This keeps the two layers cleanly separated and aligned with the same
"own repo + own pipeline + own ownership" argument that drives the
infrastructure proposal: Terraform/Azure resources live in
`agentic-karl-infrastructure`, Kubernetes/Helm/ArgoCD manifests live in
`agentic-karl-deployment-configs`. Different lifecycles, different
reviewers, different blast radius — same team owns both.


## Coupling between the agentic-karl pipeline and the platform base

```
┌──────────────────────────────────────────────────────────────────┐
│  Platform Team (Cloud-CoE)                                        │
│  ─────────────────────────                                        │
│  Owns:   Subscriptions, shared Hub VNet, Firewall,                │
│          DNS zones, Policies                                       │
│  Source: Customer-Tech-Shared, per-module SemVer Git tags         │
│          (e.g. vnet10.1.1, snet12.0.0, peer13.0.1)                │
│  Comm:   Consumers pick up updates via Renovate / Git tags        │
└──────────────────────────────────────────────────────────────────┘
                              │ de-facto contract:
                              │ names, IDs, DNS zones, peering, RG layout
                              │ (relied upon, not formally guaranteed)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  agentic-karl team (AICoE)                                        │
│  ─────────────────────────                                        │
│  Owns:   Spoke VNet + own Hub, app RGs, AKS,                      │
│          managed Redis, blob storage, APIM products                │
│  Repo:   agentic-karl-infrastructure (new, this proposal)         │
│  Subs:   ak-nonprod, ak-prod (dedicated)                          │
│  CI:     GitHub Actions, plan-on-PR + apply-on-merge per env      │
│  Reads:  shared hub VNet ID via tfvar; reverse peering via        │
│          aliased azurerm.shared provider (like CMS)               │
│  Bumps:  Renovate on CTS per-module tags;                         │
│          terraform-module-releaser for own modules                │
└──────────────────────────────────────────────────────────────────┘
```

This wiring delivers what the original brief asks for:

- **Operational autonomy.** All routine `plan` / `apply` / debug happens
  inside the agentic-karl repo, against the agentic-karl subscriptions, with
  the AICoE service principals. No DevOps ticket for routine changes.
- **Governance preserved.** Azure Policies on the subscription, RBAC at
  management-group level, base modules provided by Cloud-CoE, version bumps
  reviewable as PRs.
- **No Terraform tricks post go-live.** If we would manage this before the Go-Live we would not need to reimport existing resources into the terraform state after the migration of the infra code. 



## Risks, open questions, and migration

### Risks

- drift from base infra code
- costs: 
  - new subscription and AKS plan are not expensive, but sharing resources like clusters for runtime or db are not any more possible
- **DNS strategy.** Where do `privatelink.*` zones live — in agentic-karl's
  subscription, in the platform-managed shared hub, or centrally? 
- **Identity & RBAC.** Does it reside in base or project? Who rotates secrets?
- **Other Capacity duplication.** Each dedicated subscription means a new
  Log Analytics workspace, Key Vault, AGW, Firewall, ACR. CMS accepted this
  cost; agentic-karl should plan to.



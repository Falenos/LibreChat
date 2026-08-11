# Runtime Operations

Use this reference for AKS, ArgoCD, External Secrets, private endpoint diagnosis, or small private-database maintenance.

## Contents

- [Safety boundary](#safety-boundary)
- [AKS inspection](#aks-inspection)
- [ArgoCD inspection](#argocd-inspection)
- [ExternalSecret refresh and restart](#externalsecret-refresh-and-restart)
- [Private endpoint diagnosis](#private-endpoint-diagnosis)
- [Private Mongo maintenance](#private-mongo-maintenance)

## Safety Boundary

Start with read-only checks. Use dry-runs before approved Kubernetes or ArgoCD changes. Do not mutate live Azure, Kubernetes, or ArgoCD resources unless the task explicitly authorizes that operation.

Do not print Kubernetes Secrets, ExternalSecret target values, connection strings, tokens, or Key Vault values. Inspect names, mappings, conditions, resource versions, and timestamps.

Private AKS, MongoDB, PostgreSQL, Search, and Foundry endpoints require working VPN routes and private DNS. Azure control-plane login alone does not prove data-plane reachability. Never enable public access to work around a laptop routing or DNS problem.

## AKS Inspection

Confirm the Azure identity and subscription before obtaining or using credentials. Obtaining credentials changes the local kubeconfig; preserve existing contexts and use an explicit context for every command.

```bash
az aks get-credentials \
  --subscription <subscription-id> \
  --resource-group <aks-resource-group> \
  --name <aks-name>

kubectl config get-contexts
kubectl --context <aks-context> -n <namespace> get deployments,pods,externalsecrets,secretstores
kubectl --context <aks-context> -n <namespace> describe deployment <deployment>
```

Do not assume the current kubeconfig context targets the intended environment. Do not use `--overwrite-existing` unless replacing that named entry is intentional.

## ArgoCD Inspection

Use `--grpc-web` for AGK ArgoCD. Authenticate separately for nonprod and prod with the approved SSO or least-privileged identity; use an admin identity only through the break-glass process:

```bash
argocd login argocd.agk.nonprod.knauf.digital --username <user> --grpc-web
argocd login argocd.agk.prod.knauf.digital --username <user> --grpc-web
```

Read current state before any action:

```bash
argocd app get <app> --server <argocd-host> --grpc-web
```

Use `argocd app diff` or `argocd app manifests` only when the task requires rendered-content diagnosis and the output can be handled as sensitive. Helm parameters, environment values, or rendered Secret data may appear; do not paste broad output into chat or logs.

Dry-run an approved sync before running it live:

```bash
argocd app sync <app> --server <argocd-host> --dry-run --grpc-web
```

Rendered manifests and ArgoCD health are runtime evidence. GitOps source alone does not prove the deployed revision, health, or ExternalSecret refresh state.

## ExternalSecret Refresh And Restart

Inspect the resource without printing its generated Kubernetes Secret:

```bash
kubectl --context <aks-context> -n <namespace> get externalsecret <name> \
  -o custom-columns='NAME:.metadata.name,READY:.status.conditions[-1].status,REASON:.status.conditions[-1].reason,REFRESH:.status.refreshTime'
```

For a Key Vault value consumed as a pod environment variable:

1. Confirm the Key Vault update timestamp without reading the value.
2. Wait for the configured refresh interval or perform an explicitly approved force refresh.
3. Verify the ExternalSecret condition and `.status.refreshTime` are newer than the Key Vault update.
4. Restart only the consuming Deployment because existing process environments do not change when the Kubernetes Secret changes.
5. Verify rollout and test with a fresh authentication/session flow when rotating OpenID credentials.

An approved force refresh can update an annotation with a current timestamp:

```bash
kubectl --context <aks-context> -n <namespace> annotate externalsecret <name> \
  force-sync="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --overwrite
```

Restart and inspect rollout only after the refreshed target Secret exists:

```bash
kubectl --context <aks-context> -n <namespace> rollout restart deployment/<deployment>
kubectl --context <aks-context> -n <namespace> rollout status deployment/<deployment>
```

## Private Endpoint Diagnosis

Read the current endpoint hostname, private IP, port, subnet, and DNS-zone ownership from Terraform/Azure before testing. Do not copy an old endpoint IP from documentation.

Inspect private-endpoint metadata without accessing the service data plane:

```bash
az network private-endpoint list \
  --subscription <subscription-id> \
  --resource-group <resource-group> \
  --query '[].{name:name,state:provisioningState,approval:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}' \
  -o table
```

Test the three boundaries separately:

```bash
route -n get <private-ip>
# Linux: ip route get <private-ip>
dig @<vpn-dns-server> <private-hostname> A
dig @<vpn-dns-server> <service-srv-name> SRV
nc -vz <private-hostname-or-ip> <port>
```

Interpret failures in order:

1. Missing or wrong route: fix the VPN/client route through the network owner.
2. Missing `A` or `SRV` response: fix the linked private DNS zone/record and VPN DNS forwarding through Terraform.
3. Route and DNS work but TCP fails: inspect NSG, firewall, service network policy, and allowed source CIDR.
4. TCP works but the client fails: verify TLS/SNI, authentication, connection options, and the service-specific client.

For MongoDB vCore, verify both the `A` record and `_mongodb._tcp` `SRV` record in `privatelink.mongocluster.cosmos.azure.com`. A private DNS zone for another cluster is not sufficient.

## Private Mongo Maintenance

Keep AGK MongoDB private. For a small, deterministic maintenance action, prefer a short-lived reviewed GitOps Job running inside the target namespace:

1. Create a temporary branch in `agk-deployment-configs`.
2. Add one `batch/v1` Job under a temporary `maintenance/<env>/<purpose>/` path.
3. Use the deployed application image and existing ConfigMap/Secret references so the Job follows the workload's network and authentication path.
4. Print non-secret before/after metadata only.
5. Create a temporary ArgoCD Application for that branch/path, dry-run, sync after approval, and inspect Job status/logs.
6. Delete the temporary ArgoCD Application and remote branch after verification; restore the previous local branch.

Use this pattern for one small, reviewed, deterministic change. Use product code or a migration for exploratory queries, bulk changes, long-running work, or repeatable behavior.

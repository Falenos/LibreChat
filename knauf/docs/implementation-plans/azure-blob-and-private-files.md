# Azure Blob Storage — production architecture, what's done, what's still pending

This doc is the running record of KARL's file-storage strategy on Azure: how it works, what's been landed (locally + upstream), what's still open, and where each piece lives in the code.

Related docs:
- [`../reference/code-change-protocol.md`](../reference/code-change-protocol.md) — tier ladder referenced in the Tier 5 / SEAMS decisions below.
- [`../guides/upstream-sync.md`](../guides/upstream-sync.md) — how the Tier 5 overlay gets retired if/when upstream adopts equivalent behavior.
- [`../../../SEAMS.md`](../../../SEAMS.md) — `[knauf]` marker index that this rollout appends rows to.

Background notes (local-only, not committed — `.claude/*` is gitignored):
- `.claude/notes/Architecture/files-and-file-search.md` — overall file-handling architecture
- `.claude/notes/Architecture/files-problems-and-fixes.md` — known-issues catalogue
- `.claude/notes/Architecture/files-scaling-and-durability.md` — pod-safety / scaling angle

Last updated: 2026-05-22, after end-to-end smoke test against real Azure storage account `karlblob` in resource group `karl-storage` (CT-SANDBOX subscription).

---

## TL;DR — where we are

- KARL runs `fileStrategy: "azure_blob"` (Tier 0, [librechat.yaml](../../../librechat.yaml)).
- Upstream LibreChat's Azure Blob strategy is **insecure by default** (public containers, unsigned URLs returned from every helper) — unusable for our compliance posture as shipped.
- KARL carries a **Tier 5 overlay (KK20-167)** on top of the upstream Azure files that adds time-limited SAS signing (Account Key or Managed Identity / User Delegation SAS), refresh-on-expiry, a private-default access mode, and a handful of S3-parity bug fixes the upstream path was missing. Every modified upstream file is tagged with `[knauf:KK20-167]` and indexed in `SEAMS.md`.
- The overlay is **verified end-to-end against a real Azure storage account** (`karlblob.blob.core.windows.net`, CT-SANDBOX). Avatars and file_search uploads both land in Azure with proper SAS URLs (`sig`, `sp=r`, `spr=https`, 300s TTL).
- Outstanding work (deployment-configs PR, prod Managed Identity, follow-up UX) is documented under **Still pending** below.

---

## The three-layer access-control model

```
┌─ Layer 1: Storage account (Azure-side) ─────────────────────────────┐
│ • Container Private (no anonymous access)                           │
│ • Account key access ENABLED today (connection-string mode)         │
│ • → Managed Identity in prod (no key in cluster) — PENDING          │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌─ Layer 2: SAS token (per-blob, per-request) ────────────────────────┐
│ • sp=r (read-only)                                                  │
│ • spr=https (HTTPS only)                                            │
│ • se = st + 300s (5 min TTL)                                        │
│ • Scoped to one specific blob                                       │
│ • Signed with the account key → tamper-evident                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌─ Layer 3: Backend authz (application-side) ─────────────────────────┐
│ • `fileAccess` middleware verifies file.user === req.user.id        │
│ • SAS is only signed for blobs the requester owns                   │
│ • Okta/OpenID provides req.user.id                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Critical to understand:** per-user isolation is enforced at **Layer 3 only**. The userId in the blob path (`files/uploads/<userId>/...`) is a **naming convention**. Anyone holding a valid SAS for a blob can read it — security depends on the backend correctly signing only blobs the requesting user owns, and SAS TTL bounding leak damage to 5 minutes.

---

## File-type routing in upstream + our fork

Upstream's upload router branches by file type. Crucial for K8s pod-safety reasoning:

| File type / context | Destination | Stored where | K8s-safe? |
|---|---|---|---|
| **PDF / DOCX / XLSX / ODT** chat attachments | `document_parser` (in-process text extraction) | Extracted text → MongoDB `files.text`. Binary discarded after multer temp dir read. | ✅ |
| **Images** (PNG/JPG/GIF/WEBP) | `fileStrategy` (azure_blob) | Azure Blob `files/images/<userId>/...` | ✅ |
| **PPTX / ZIP / JSON / other binaries** | `fileStrategy` (azure_blob) | Azure Blob `files/uploads/<userId>/...` | ✅ |
| **File_search agent attachments** | `fileStrategy` (azure_blob) | Azure Blob `files/uploads/<userId>/...`, then RAG API fetches via SAS to vectorize | ✅ |
| **User / agent avatars** | `processAzureAvatar` → `fileStrategy` (azure_blob) | Azure Blob `files/images/<userId>/...` | ✅ |

In all production paths, **nothing is written to the pod's local filesystem** durably — only multer's per-request temp files, which are read and unlinked within the same HTTP request.

### The document_parser trade-off

Upstream's `document_parser` (`packages/api/src/files/documents/crud.ts:19-51`) parses PDF/DOCX/XLSX/ODT to text in-process and stores **only the text** in Mongo. The original binary is never persisted anywhere. This is by design — fast LLM context injection — but it has consequences:

- ✅ Pod-safe (no disk writes)
- ✅ Cheap (text is ~5-10× smaller than the binary)
- ✅ Fast (single Mongo query gets text + metadata)
- ❌ Original file is **lost** — you cannot "open original" from a citation
- ❌ Cannot cite a specific page of the original PDF with rendered context
- ❌ 15MB hard cap (`DOCUMENT_PARSER_MAX_FILE_SIZE`) — larger PDFs can't be ingested at all

For KARL's "open original from citation" UX (Workstream C of the plan), we either need to:
1. Land an upstream PR that **also** uploads the binary alongside the text extraction, or
2. Maintain a Tier 5 overlay that does the dual-write ourselves.

See **Still pending** below.

---

## What's been landed

### Tier 5 overlay (KK20-167)

The Knauf fork carries an overlay on top of upstream's Azure Blob files that adds the signing + refresh + private-default behavior we need. The overlay touches these upstream files; every edit is wrapped with a `[knauf:KK20-167]` marker and indexed in [`SEAMS.md`](../../../SEAMS.md):

| File | Role |
|---|---|
| `api/server/services/Files/Azure/crud.js` | `getSignedAzureURL` (Account Key + Managed Identity / User Delegation SAS), `needsRefreshAzure`, `getNewAzureURL`, `refreshAzureFileUrls`, `refreshAzureUrl`, container-anchored `extractBlobPathFromAzureUrl`, `getAzureURL` signing parity, `deleteFileFromAzure` URL parsing, `SASProtocol.Https`, lazy-read of `AZURE_STORAGE_PUBLIC_ACCESS`, 300s default TTL |
| `api/server/services/Files/Azure/images.js` | Avatar processing emits the signed URL |
| `api/server/routes/files/files.js` | `/files` list dispatches the URL refresh via a `fileUrlRefreshBySource` map (S3 + Azure) |
| `api/server/controllers/UserController.js` | User-avatar URL refresh dispatch (`avatarNeedsRefreshBySource`, `getNewAvatarUrlBySource`) |
| `api/server/controllers/agents/v1.js` | Agent-avatar URL refresh dispatch (`urlRefreshersBySource`) |
| `api/server/utils/getFileStrategy.js` | `getFileURLRefreshCacheTime` shared half-TTL refresh-cache helper |
| `api/cache/getLogStores.js` | `AZURE_EXPIRY_INTERVAL` cache namespace |
| `packages/api/src/agents/avatars.ts` | `refreshListAvatars` accepts an optional `refreshAzureUrl` alongside `refreshS3Url` |
| `packages/data-provider/src/config.ts` | `CacheKeys.AZURE_EXPIRY_INTERVAL` enum |
| `api/test/server/services/Files/Azure/crud.test.js` | New file — 24 unit tests covering signing, refresh, extractor, guards |

Test coverage: **38/38 unit tests** in `api/test/server/services/Files/Azure/crud.test.js` pass. Coverage spans:

- `needsRefreshAzure` — SAS-token detection via `sig` (not `se`), expiry math, public/private-mode behavior, invalid-URL handling
- `extractBlobPathFromAzureUrl` — virtual-hosted-style, path-style (Azurite), SAS-bearing URLs, container override, legacy-container fallback, invalid URLs
- `getNewAzureURL` — invalid URL, public mode, path-parts guard, **explicit `containerName` for multi-container deployments**
- `getSignedAzureURL` — both configuration-error branches, `sig`/`sp=r`/`spr=https` presence, default TTL
- `getAzureURL` — signing-when-private parity with S3, plain URL when public
- `deleteFileFromAzure` — happy path (strips SAS from filepath), 404 swallowing, user-id mismatch rejection, non-404 rethrow
- `refreshAzureFileUrls` — empty input, non-azure files skipped, malformed entries don't crash the batch
- `refreshAzureUrl` — null/undefined fileObj, non-azure source passthrough, no-refresh-needed passthrough
- **Managed Identity signing path** — `DefaultAzureCredential` outside production, `ManagedIdentityCredential` in production, BlobServiceClient + credential reused across concurrent requests (singleton invariant)

Verified end-to-end against `karlblob.blob.core.windows.net` (CT-SANDBOX dev storage account):

- ✅ Agent avatar upload → SAS URL with `sig`, `sp=r`, `spr=https`, `se = st + 300s`
- ✅ File_search PDF upload → SAS URL, RAG API fetched + vectorized (`embedded: true` in Mongo)
- ✅ 403 on expired SAS (confirms TTL enforcement)
- ⏳ Refresh-on-list path not yet wall-clock-verified end-to-end (need 5+ min wait then `GET /api/files` — should regenerate URL)

### Knauf-controlled bits

- `librechat.yaml` ships `fileStrategy: "azure_blob"` (Tier 0).
- `.env.example` documents the supported env vars (Tier 4c — see file for the `[knauf:KK20-167]` block).

---

## Recently completed (in PR branch, since the original plan was drafted)

Tracked here so the "Still pending" list below reflects *what's actually next*, not what's already shipped.

- ✅ **Post-review hardening on `crud.js`** (commit 3 of #46):
  - `needsRefreshAzure` now detects SAS via `sig` (the cryptographic signature) not `se` (just the expiry timestamp) — defense-in-depth fix mirroring S3's `X-Amz-Signature` check.
  - `BlobServiceClient` + credential hoisted to module-level singletons on the Managed Identity path, keyed on account name. Eliminated the per-request credential reconstruction that cold-started the AAD token cache.
  - `ManagedIdentityCredential` used explicitly in production (`NODE_ENV === 'production'`); `DefaultAzureCredential` kept for dev. No more silent fall-through to Azure CLI / env-var identities in prod.
  - `uploadStream` inline comments (`Use default concurrency (5)` / `Use default buffer size (8MB)`) restored.
  - `needsRefreshAzure` and `refreshAzureUrl` log lines now include the offending URL / `file_id` for prod-incident debuggability.
  - Inner `try/catch` removed in the MI branch (was double-logging the same error).
- ✅ **Final cleanups + expanded tests** (commit 4 of #46):
  - `isNaN` → `Number.isNaN` (no more global-isNaN coercion footgun).
  - `getUserDelegationKey` collapses concurrent first-callers via promise-based memoization (the resolved-value cache had a benign race; the promise cache resolves it).
  - `getNewAzureURL` now accepts an optional `containerName` argument so multi-container deployments can refresh URLs without rewriting them into the default container.
  - **Test count 24 → 38**. New coverage for: `deleteFileFromAzure` (happy path, 404 swallow, user-id mismatch, non-404 rethrow); `refreshAzureFileUrls` (empty list, non-azure files skipped, malformed entries); `refreshAzureUrl` (null fileObj, non-azure passthrough, no-refresh passthrough); `getNewAzureURL` containerName override for multi-container; Managed Identity signing in production AND development (validates `ManagedIdentityCredential` vs `DefaultAzureCredential` selection); BlobServiceClient + credential singleton (one credential constructed for N concurrent signed-URL requests).

---

## Still pending

Ordered by dependency / blast radius. Items in **A–C** unblock prod rollout; **D–G** are follow-up work.

### A. Track upstream parity

The overlay exists because upstream's vanilla `azure_blob` strategy doesn't meet our compliance bar. If/when upstream catches up (private-by-default + signed URLs), drop the overlay.

- [ ] On each upstream sync, re-check whether the upstream files now ship equivalent behavior natively. The `seams.js diff-check` will flag drift between our overlay and upstream context lines.
- [ ] If upstream adopts compatible behavior, retire the overlay in one PR: remove all `[knauf:KK20-167]` markers, the SEAMS.md rows, and any redundant Knauf-side env/config.
- [ ] Until then, keep the overlay in sync with upstream's Azure file structure on every sync — if upstream renames helpers or moves the strategy interface, the markers will surface the conflict early.

### B. Switch prod to Managed Identity (eliminate account key in cluster)

Owner: infra + Knauf team. Code already supports both — only deployment-side work.

- [ ] Create an AKS pod identity (or workload identity) for the KARL backend deployment.
- [ ] Grant it **Storage Blob Data Contributor** on the `files` container + **Storage Blob Delegator** on the storage account (delegation is required for User Delegation SAS).
- [ ] Replace `AZURE_STORAGE_CONNECTION_STRING` with `AZURE_STORAGE_ACCOUNT_NAME` in prod env / sealed secrets.
- [ ] After verifying MI works in prod, **disable account key access entirely** on the storage account (Portal → Configuration → "Allow storage account key access: Disabled"). Removes the lose-the-key risk.

### C. Citation → open original file (Workstream C in the plan)

The existing modal preview flow works for file_search citations today via the proxied download. What's missing:

- [ ] **New route `GET /api/files/sas/:file_id`** in `api/server/routes/knauf/fileSasLink.js` — Tier 3 net-new Knauf file. Returns `{ url, expiresAt }` after `fileAccess` middleware ownership check. Refuses (404) when `file.source !== 'azure_blob'`.
- [ ] **"Open original" button** in `client/src/components/Chat/Messages/Content/FilePreviewDialog.tsx`. Opens `window.open(url, '_blank', 'noopener,noreferrer')`. Marker: `[knauf:KK20-XXX] open-original-button`.
- [ ] **Jump-to-page in PDF preview** — thread the citation's `pages: number[]` to `FilePreviewDialog`, append `#page=N` to the iframe src. Marker: `[knauf:KK20-XXX] cited-page-jump`.
- [ ] i18n keys (Knauf-style):
  - `com_knauf_open_original` — "Open original"
  - `com_knauf_open_original_unavailable` — shown when source isn't `azure_blob`
- [ ] Empty state for `useFileDownload` 404 (file deleted): "file no longer available" instead of silent failure.

Critical files:
- [api/server/routes/knauf/](../../../api/server/routes/knauf/) — pattern: see `autogeneratePrompt.js`
- [client/src/components/Chat/Messages/Content/FilePreviewDialog.tsx](../../../client/src/components/Chat/Messages/Content/FilePreviewDialog.tsx)
- [client/src/components/Web/Citation.tsx](../../../client/src/components/Web/Citation.tsx)
- [client/src/data-provider/Files/queries.ts](../../../client/src/data-provider/Files/queries.ts) (`useFileDownload`)

### D. Preserve original binary for `document_parser` paths

PDF/DOCX/XLSX chat attachments currently lose the binary after text extraction. For citation-to-source-file UX and audit/compliance use cases, we want the binary preserved.

Two ways:

- **D1 (preferred):** Open an upstream PR that, after `parseDocument` succeeds, also calls `streamFileToAzure(file)` and stores both `filepath` (signed Azure URL) AND `text` (extracted) in the Mongo record. The schema already has both fields. Owner: TBD.
- **D2 (fallback Knauf overlay):** Patch `processAgentFileUpload` in `api/server/services/Files/process.js:757-808` with a `[knauf]` marker that dual-writes. Tier 5.

Open question: should `document_parser` PDFs be re-fetchable as a SAS URL for the user? Today the `filepath: 'document_parser'` constant signals "this is a text record, no blob URL". After dual-write, we'd want `filepath` to be the actual blob URL and a separate flag like `hasExtractedText: true` for the text-in-Mongo state.

### E. Granular `fileStrategy` config in KARL fork

To protect against a future config change silently rerouting one slot back to `local`:

- [ ] Replace `librechat.yaml`'s string-form with the object form:
  ```yaml
  fileStrategy:
    avatar: "azure_blob"
    image:  "azure_blob"
    document: "azure_blob"
  ```
- Tier 0, low-risk change. Defer until upstream PR is merged so the granular schema is in upstream's Zod validator.

### F. Compliance / hardening

Required by Knauf's compliance posture before prod-rollout:

- [ ] **Enable Azure Storage diagnostic logs** → Log Analytics workspace (or Event Hub for SIEM). Audit who accessed which blob and when.
- [ ] **Lock down network access** to the storage account: Private Endpoint from the AKS subnet, public access disabled. Defense in depth.
- [ ] **Soft delete + versioning** already enabled at storage-account creation — verify retention policy (currently 7 days).
- [ ] **Storage account key rotation policy** (Azure Policy) — automatic rotation every 90 days. Only relevant if we keep the key path enabled for disaster recovery.
- [ ] **Tag the storage account** with cost-center + owner — required by Knauf cloud governance.

### G. Small cleanups (post-merge follow-up ticket)

Low-priority polish that didn't justify its own commit on this PR:

- [ ] Replace `blobPath.includes(req.user.id)` in `deleteFileFromAzure` with an exact-segment match (`blobPath.split('/').includes(req.user.id)`). Pre-existing upstream code; the substring check passes for pathologically-named users. Pure defense-in-depth.
- [ ] Wall-clock-verify the refresh-on-`/api/files`-list path end-to-end in dev: upload a file, wait `AZURE_URL_EXPIRY_SECONDS + 1m`, hit `GET /api/files`, confirm the persisted `filepath` got rewritten with a fresh `se=`. Code is in place; just needs an actual 5-minute wait.
- [ ] Promote-pipeline workflow sanity check: confirm `ct-shared-workflows@v2.9.0`'s `promote-app-kubernetes` actually substitutes `dev` → `prod` in `destination-environment-config-repository-app-directory` (currently hard-coded to `./dev/services/agentic-karl/agentic-karl` in our `promote_pipeline.yaml`). Spot-check the first promote run after the deployment-configs PR-2 lands.
- [ ] Document in [UPSTREAM_SYNC.md](../../../UPSTREAM_SYNC.md) which upstream Azure files this overlay shadows so future syncs surface the conflict surface early.

---

## How this lands in dev + prod — actual deployment flow

### CI/CD topology

| Component | Repo | What it does |
|---|---|---|
| Code (this fork) | `Knauf-Group/agentic-karl-v2` | Source, Dockerfile, Helm-friendly defaults |
| Deployment configs | `Knauf-Group/ct-shared-deployment-configs` | `dev/services/agentic-karl/agentic-karl/values.yaml` and same path under `prod/` |
| Shared workflows | `Knauf-Group/ct-shared-workflows@v2.9.0` | Build image → push to ACR → bump tag in deployment configs → ArgoCD syncs |
| Cluster | AKS via ArgoCD | dev = `argocd-shared-dev.knauf.digital`, prod = `argocd-shared-prod.knauf.digital` |
| ACR | `acrctshared001.azurecr.io` | `tools-non-prod/agentic-karl:<tag>` for dev, `tools-prod/agentic-karl:<tag>` for prod |

The on-merge-to-main release pipeline does the full dev rollout end-to-end. Prod is gated behind a manual `workflow_dispatch` (`promote_pipeline.yaml`) that promotes the dev-tagged image to prod ACR and updates the prod values.

### What the dev values look like today (relevant slices)

`dev/services/agentic-karl/agentic-karl/values.yaml`:

- `image.repository: acrctshared001.azurecr.io/tools-non-prod/agentic-karl`
- `externalSecret.secretStore.name: kv-ct-shared-tools` (Azure Key Vault for non-prod)
- `externalSecret.secrets` (sensitive env vars, pulled from Key Vault):
  - Today: `MONGO_URI`, `JWT_SECRET`, `OPENID_CLIENT_SECRET`, `AZURE_OPENAI_API_KEY`, `REDIS_URI`, etc.
  - **Missing:** anything for Azure Blob Storage.
- `configmap` (non-sensitive env vars):
  - Today: `ENDPOINTS`, `RAG_API_URL`, model config, rate limits, etc.
  - **Missing:** `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_CONTAINER_NAME`, `AZURE_STORAGE_PUBLIC_ACCESS`, `AZURE_URL_EXPIRY_SECONDS`.
- `storageAccount.enabled: true` mounts an SMB file share `karlshare` at `/app/client/public/images` — **this is the legacy local-strategy path**, persisted via Azure Files (SMB) so it survives pod restarts. It's the durability workaround for `fileStrategy: "local"` that the Blob strategy makes obsolete.

Prod (`prod/services/agentic-karl/agentic-karl/values.yaml`) is nearly identical — only diff is `kv-ct-sharedprod-tools` secret store, `tools-prod` namespace, prod domains, and removal of spot-node tolerations.

### Exactly what's needed in the deployment configs to enable Azure Blob

Two distinct PR motions, in this order:

#### PR-1: New secret in Azure Key Vault (manual, infra)

For each environment, add the connection string (dev only — for prod we want Managed Identity, see PR-3):

```
Key Vault: kv-ct-shared-tools
  Secret name: KARL-AZURE-STORAGE-CONNECTION-STRING
  Value:       <dev karlblob connection string>
```

Owner: someone with Key Vault Secrets Officer on `kv-ct-shared-tools`.

#### PR-2: `Knauf-Group/ct-shared-deployment-configs` — add the env vars

Two file edits, both straightforward additions:

**`dev/services/agentic-karl/agentic-karl/values.yaml`** — under `externalSecret.secrets`:

```yaml
    secrets:
      # ... existing entries ...
      AZURE_STORAGE_CONNECTION_STRING: KARL-AZURE-STORAGE-CONNECTION-STRING   # ← add
```

And under `configmap`:

```yaml
  configmap:
    # ... existing entries ...
    AZURE_CONTAINER_NAME: "files"                # ← add
    AZURE_STORAGE_PUBLIC_ACCESS: "false"         # ← add (explicit safety)
    AZURE_URL_EXPIRY_SECONDS: "300"              # ← add (5 min TTL)
```

Same shape for `prod/services/agentic-karl/agentic-karl/values.yaml` once dev is proven.

**Do NOT remove `storageAccount.volumes` yet.** Keep the SMB mount for safety until we're sure no upload path still writes to `/app/client/public/images`. Plan a follow-up to drop it once blob is verified end-to-end in prod.

#### PR-3 (production-only, follow-up): switch prod to Managed Identity

Once dev is proven on connection-string mode, prod should use Workload Identity to eliminate the account key from the cluster:

1. **Azure side** (manual / Terraform):
   - Create a User-Assigned Managed Identity, e.g. `id-karl-prod-blob`.
   - Federate it to the AKS workload identity for `serviceAccount` `agentic-karl` in namespace `tools-prod`.
   - Assign roles on the prod storage account (`karlblob-prod` or whatever exists):
     - **Storage Blob Data Contributor** on the `files` container
     - **Storage Blob Delegator** on the storage account (required for User Delegation SAS)

2. **`ct-shared-deployment-configs/prod/services/agentic-karl/agentic-karl/values.yaml`**:
   - Remove `AZURE_STORAGE_CONNECTION_STRING` from `externalSecret.secrets`.
   - Add to `configmap`:
     ```yaml
     AZURE_STORAGE_ACCOUNT_NAME: "karlblob-prod"
     ```
   - Add the service-account override that ties the pod to the Managed Identity (typical shape; verify against `ct-shared-chart` v2.2.0):
     ```yaml
     serviceAccount:
       create: true
       name: "agentic-karl"
       annotations:
         azure.workload.identity/client-id: "<managed-identity-client-id>"
     podAnnotations:
       azure.workload.identity/use: "true"
     ```

3. **Disable account-key access** on the prod storage account once Managed Identity is confirmed working: Portal → Configuration → "Allow storage account key access: Disabled".

### What needs to ship in this repo (`agentic-karl-v2`) for prod-readiness

Independent of the deployment-configs PRs, these land in the fork itself:

| Item | Where | Status |
|---|---|---|
| Image ships the overlay | Built from this repo's `feat/KK20-167-azure-blob-private-container` branch (and `main` once merged) via the standard release pipeline | ✅ once this PR merges |
| `librechat.yaml` carries `fileStrategy: "azure_blob"` | [librechat.yaml](../../../librechat.yaml) | ✅ already done |
| Granular `fileStrategy` (per-slot routing) | [librechat.yaml](../../../librechat.yaml) | ⏳ optional defense-in-depth, see item E above |
| `.env.example` documents the new env vars for local dev | [.env.example](../../../.env.example) | ⏳ small follow-up — add the 4 new vars with comments |
| Workstream C UI work (open original from citation) | `client/src/...` + new `api/server/routes/knauf/fileSasLink.js` | ⏳ separate KK20 ticket once base PR merges |

### Rollout sequence (the actual order of operations)

```
1.  [this fork] KK20-167 PR merges to main
            → release_pipeline builds image with the overlay
        │
        ▼
2.  [infra] Create dev storage account + container "files" (Private)
            Add KARL-AZURE-STORAGE-CONNECTION-STRING to kv-ct-shared-tools
        │
        ▼
3.  [deployment-configs] PR against ct-shared-deployment-configs
            Adds env vars to dev/services/agentic-karl/agentic-karl/values.yaml
        │
        ▼
4.  [release_pipeline] updates dev values image tag → ArgoCD syncs
            → pods restart with new env + new image
        │
        ▼
5.  [verify] Upload an avatar in dev. Check Mongo: filepath is a SAS URL.
            Wait 6 min. Hit /api/files. URL refreshes. Citation modal opens originals.
        │
        ▼
6.  [promote] workflow_dispatch promote_pipeline → image promoted to tools-prod
        │
        ▼
7.  [infra] Create prod storage account + container "files" (Private) + Managed Identity
        │
        ▼
8.  [deployment-configs] follow-up PR — prod values.yaml: switch to AZURE_STORAGE_ACCOUNT_NAME,
            wire service account to Workload Identity, remove key-based secret
        │
        ▼
9.  [verify in prod] same checks as step 5
        │
        ▼
10. [infra hardening]
        - Disable account key access on storage accounts
        - Add Private Endpoint from AKS subnet
        - Enable diagnostic logs → Log Analytics
        - Drop the SMB karlshare volume from values.yaml (last cutover)
---

## Critical file map

| Concern | File |
|---|---|
| Azure CRUD (signing, refresh, delete, extractor) | [api/server/services/Files/Azure/crud.js](../../../api/server/services/Files/Azure/crud.js) |
| Azure avatar processing | [api/server/services/Files/Azure/images.js](../../../api/server/services/Files/Azure/images.js) |
| Azure container client + startup | [packages/api/src/cdn/azure.ts](../../../packages/api/src/cdn/azure.ts) |
| Strategy factory | [api/server/services/Files/strategies.js](../../../api/server/services/Files/strategies.js) |
| Upload routing (text extraction vs blob) | [api/server/services/Files/process.js](../../../api/server/services/Files/process.js) |
| Document parser (text-in-Mongo path) | [packages/api/src/files/documents/crud.ts](../../../packages/api/src/files/documents/crud.ts) |
| Files list / refresh dispatch | [api/server/routes/files/files.js](../../../api/server/routes/files/files.js) |
| Avatar refresh dispatch | [api/server/controllers/UserController.js](../../../api/server/controllers/UserController.js), [api/server/controllers/agents/v1.js](../../../api/server/controllers/agents/v1.js) |
| Refresh cache TTL helper | [api/server/utils/getFileStrategy.js](../../../api/server/utils/getFileStrategy.js) |
| Cache namespaces | [api/cache/getLogStores.js](../../../api/cache/getLogStores.js) |
| `AZURE_EXPIRY_INTERVAL` enum | [packages/data-provider/src/config.ts](../../../packages/data-provider/src/config.ts) |
| Tests | `api/test/server/services/Files/Azure/crud.test.js` (24/24 passing on the overlay branch) |

---

## Environment variables (final shape, post-PR-merge)

```bash
# Required: pick ONE auth mode
AZURE_STORAGE_CONNECTION_STRING=...        # dev / disaster recovery
# OR
AZURE_STORAGE_ACCOUNT_NAME=karlblob        # prod: Managed Identity via DefaultAzureCredential

# Required: container name (must exist, must be Private)
AZURE_CONTAINER_NAME=files

# Required: never `true` in production
AZURE_STORAGE_PUBLIC_ACCESS=false

# Optional: SAS TTL — 300s (5 min) is the post-PR default; 60s for fast TTL testing only
AZURE_URL_EXPIRY_SECONDS=300

# Optional: refresh-window override (advanced — leave unset unless you've measured a need)
# AZURE_REFRESH_EXPIRY_MS=
```

In `librechat.yaml`:

```yaml
fileStrategy: "azure_blob"                 # string form, default for all slots — sufficient
# Future granular form (after item E above):
# fileStrategy:
#   avatar: "azure_blob"
#   image:  "azure_blob"
#   document: "azure_blob"
```

---

## Verification recipes (for future "did we regress this?" checks)

### Quick smoke: avatar upload roundtrip

```bash
# 1) Upload an agent avatar via the UI.
# 2) Inspect the Mongo record:
docker exec chat-mongodb mongosh "LibreChat" --quiet --eval \
  'printjson(db.agents.findOne({}, { avatar:1, _id:0 }))'

# 3) URL must contain ?sv=...&se=...&sp=r&spr=https&sig=...
# 4) curl the URL → 200 immediately, 403 after se+1 minute.
```

### Refresh path

```bash
# Upload a file. Wait > AZURE_URL_EXPIRY_SECONDS. Hit GET /api/files
# (or navigate around the UI). Re-query Mongo → filepath has new `se=` ~TTL into the future.
```

### Per-user isolation (Layer 3)

```bash
# User A uploads a file. Note A's file_id from Mongo.
# Log in as user B in another browser session. Call GET /api/files/download/<A.userId>/<A.file_id>
# Expected: 403 from `fileAccess` middleware. If 200, the authz check has regressed.
```

### Document parser routing

```bash
# Upload a PDF as a chat attachment (not file_search resource).
# Mongo record should have:
#   source: 'text', filepath: 'document_parser', text: '<extracted content>'
# NOT in the blob container — that's expected by upstream design until D above lands.
```

---

## Open questions / known unknowns

- [ ] The `AZURE_REFRESH_EXPIRY_MS` env var (advanced override of the refresh detection window) — when is it actually useful vs the default half-TTL heuristic? Doesn't matter for v1 but worth documenting if we ever turn it on.
- [ ] `userDelegationKey` is module-global mutable state — two concurrent requests on first access both call `getUserDelegationKey`. Race is benign (last writer wins, both keys valid) but inefficient. Worth a follow-up PR if delegation-key call rate becomes a hotspot.
- [ ] `getNewAzureURL` calls `getAzureContainerClient()` with no arg → always defaults to `AZURE_CONTAINER_NAME`. If a deployment ever uses multiple containers, refresh rewrites to the default. Pre-existing limitation; document if we ever need multi-container.

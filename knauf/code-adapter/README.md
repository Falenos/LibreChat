# code-adapter — LibreChat Code API → Azure Container Apps dynamic sessions

Tier-3 Knauf sidecar (KK20-108 workstream). Presents the **LibreChat Code API**
contract on the front (`LIBRECHAT_CODE_BASEURL=http://<svc>:3112/v1`) and runs
the code in **ACA dynamic session pools** (Microsoft-managed Hyper-V sandboxes)
on the back. Zero LibreChat source changes; removing `LIBRECHAT_CODE_BASEURL`
rolls the whole feature back.

Design rationale and the backend decision live in
[`knauf/docs/proposals/code-interpreter-implementation-designs.md`](../docs/proposals/code-interpreter-implementation-designs.md)
(Option 2); why this is a separate service rather than a router inside LibreChat is argued in
[`knauf/docs/proposals/code-adapter-placement.md`](../docs/proposals/code-adapter-placement.md).
This README is the operational reference for the service itself.

## The ACA backend contract (verified live, Aug 2026)

The KK20-108 spike against live West Europe pools found the two built-in pool
types are **two different data-plane contracts** — not one parameterized API.
The adapter encodes both as "dialects" in [`src/azure/acaClient.ts`](src/azure/acaClient.ts);
raw response fixtures live in [`test/fixtures/aca/`](test/fixtures/aca/).

|              | Python pool (`lang=py`)                                                                                         | Shell pool (`lang=bash`)                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Exec path    | `POST {pool}/code/execute`                                                                                      | `POST {pool}/executions`                            |
| api-version  | `2024-02-02-preview`                                                                                            | `2025-02-02-preview`                                |
| Request body | `{properties:{codeInputType:"inline",executionType:"synchronous",code}}`                                        | `{shellCommand}` (top-level)                        |
| Response     | `{properties:{status:"Success"\|"Failure",stdout,stderr}}`                                                      | `{status:"<exit code>",result:{stdout,stderr}}`     |
| Exit code    | **none** — runs in an IPython kernel, so `sys.exit()` is swallowed; the sentinel wrapper recovers the real code | **native** — `status` is the real numeric exit code |
| Files        | `POST /files/upload`, `GET /files`, `GET /files/content/{name}` (all `?identifier=`)                            | same shape                                          |

The api-versions are pinned per pool (`ACA_API_VERSION_PY` / `ACA_API_VERSION_SH`).
Bumping either requires refreshing the matching fixtures — `test/unit/acaShape.spec.ts`
is the tripwire that fires when a shape drifts.

## Contract served (under `/v1`, JWT-authenticated)

| Endpoint                                                         | Caller in the fork                                                                                | Notes                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /exec`                                                     | `execute_code`/`bash_tool` (@librechat/agents), `readSandboxFile`/`writeSandboxFile` (process.js) | `{lang, code, args?, files?, session_id?}` → `{session_id, stdout, stderr, code, files[]}`. `lang`: `py` → PythonLTS pool, `bash` → Shell pool, else **501**. |
| `POST /exec/programmatic`                                        | PTC (not enabled in KARL)                                                                         | **501 PTC_NOT_SUPPORTED**                                                                                                                                     |
| `POST /upload`                                                   | crud.js `uploadCodeEnvFile`                                                                       | multipart `file` + `kind/id/version` → `{message:'success', storage_session_id, files:[{fileId, filename}]}`                                                  |
| `POST /upload/batch`                                             | crud.js `batchUploadCodeEnvFiles`                                                                 | adds `read_only`; per-file `{status, fileId?, filename, error?}` + `succeeded`/`failed`                                                                       |
| `GET /download/:sid/:fid?kind=&id=[&version=]`                   | crud.js (stream) + process.js (arraybuffer)                                                       | served from staging blob — outlives the ACA session                                                                                                           |
| `GET /sessions/:sid/objects/:fid?…`                              | process.js `getSessionInfo` freshness probe                                                       | `{lastModified, size, …}`; a 404 routes LibreChat into its re-upload path (designed TTL recovery)                                                             |
| `DELETE /sessions/:sid/objects/:fid` / `DELETE /files/:sid/:fid` | crud.js primary + fallback                                                                        | same handler; terminal 404 = success for the caller                                                                                                           |

Unprefixed and unauthenticated (k8s only): `/healthz`, `/readyz`, `/metrics`.

## How /exec works

1. **Session** — adapter-minted `karl-<32hex>` doubles as the ACA `identifier`
   (foreign inbound ids are re-minted, never forwarded — no identifier injection).
2. **Staged inputs** — uploads land in blob (`code-adapter-staging/<sid>/<fileId>`)
   plus a Mongo row (`code_adapter_files`, TTL 24 h) because LibreChat uploads
   before any session exists. At exec time they are pushed into the session
   (nested paths pushed flat as `.karl_in_<n>`, moved into place by the wrapper).
3. **The wrapper** (the key design piece) — user code is never sent raw. A
   base64-embedded subprocess wrapper tees full stdout/stderr to
   `/mnt/data/.karl_out.log` / `.karl_err.log` and prints a per-request random
   sentinel `KARL_<hex> RC=<n> OUT=<bytes> ERR=<bytes>` + inline heads. This
   yields **real exit codes** (ACA's response has none) and detects/recovers
   output beyond ACA's ~4000-char stdout cap (full logs fetched via the pool
   files API, capped at `STDOUT_MAX_BYTES`). Sentinel missing → degraded mode:
   raw stdout + 0/1 synthesis + `wrapper_parse_failures_total` metric.
4. **Capture** — on rc==0 the session's files are listed and diffed: unchanged
   or read-only inputs are echoed `inherited:true`; new/changed writable files
   are persisted to blob + Mongo under the exec session so `/download` works
   after the session cooldown destroys the sandbox.
5. **Retries** — `SessionWithIdentifierNotFound` (cooldown expiry) → transparent
   re-mint + re-push + one re-run. Pool 401/403 → single-flight token refresh +
   one retry. Exec 5xx is **not** retried (not idempotent).

## Documented divergences from the ClickHouse/codeapi backend

- **220 s hard exec cap** (ACA platform limit; codeapi allowed ~300 s). Timeout
  returns HTTP 200 `{code:1}` with a stderr telling the model to split work and
  persist intermediates to `/mnt/data` — never a 5xx.
- **Languages**: `py` and `bash` only (`node`/`bun` → 501). The dominant KARL
  traffic is `bash` + `python3` heredocs, both covered.
- **128 MB upload cap** (pool file API) vs codeapi's 150 MB.
- Exit codes are real when the wrapper runs (`EXEC_WRAPPER=full`, default);
  with `EXEC_WRAPPER=off` they degrade to 0/1 synthesis.

## Auth

Inbound: verifies the per-request JWT minted by
[`packages/api/src/auth/codeapi.ts`](../../packages/api/src/auth/codeapi.ts) —
EdDSA (RS256 opt-in), issuer/audience required, optional `kid` pin,
`maxTokenAge` 300 s. The public key is config, not secret.
Outbound: **no pool credentials anywhere** — Entra tokens via
`DefaultAzureCredential` (workload identity in-cluster: SA annotation
`azure.workload.identity/client-id` + pod label
`azure.workload.identity/use: "true"`; az CLI locally), audience
`https://dynamicsessions.io`, role **Azure ContainerApps Session Executor** on
each pool.

## Environment

See [`.env.example`](.env.example) for the full annotated surface. Required:
`ACA_POOL_ENDPOINT_PY`, `ACA_POOL_ENDPOINT_SH`, `MONGO_URI`,
`AZURE_STORAGE_CONNECTION_STRING`, and (outside `CODE_ADAPTER_LOCAL_MODE`)
`CODEAPI_JWT_PUBLIC_KEY`. `ACA_API_VERSION` is pinned deliberately — bumping it
requires refreshing `test/fixtures/aca/` (see below).

## Development

```bash
npm ci
npm test                # unit + contract suites (no Azure needed)
npm run lint            # tsc --noEmit
cp .env.example .env    # fill pool endpoints for live runs
npm run build && node --env-file=.env dist/index.js
npm run smoke           # live golden-path against real pools (az login required)
```

The **contract suite** (`test/contract/`) replays the exact call shapes of
`crud.js`, `process.js`, `CodeExecutor` and `BashExecutor` — it is the
regression gate when LibreChat upstream syncs touch the Code API client side.
`test/fixtures/aca/` holds pinned real pool responses (S5 spike); the parser in
`src/azure/acaClient.ts` is tolerant across the two observed preview shapes,
and refreshing those fixtures is the documented step for an api-version bump.

## Build & deploy

Image: `.github/workflows/build-code-adapter.yaml` (`az acr build` →
`acragkhubnonprod001.azurecr.io/agentic-karl-dev/agentic-karl-code-adapter:<VERSION>`),
same self-contained pattern as `build-rag-api-overlay.yaml`. Deploy: GitOps
single-source service `agentic-karl-code-adapter` in
`Knauf-Group/agk-deployment-configs` (ClusterIP 3112, replicaCount 2, first
workload-identity app pod on AGK). Azure resources (session pools, UAMI,
federated credential, role assignments) come from `Knauf-Group/agk-infrastructure`
Terraform. Blob cleanup is a container lifecycle rule (>2 days); Mongo rows are
the source of truth and expire via TTL.

## Follow-ups (tracked in the rollout plan)

- Move blob access to workload identity and drop
  `AZURE_STORAGE_CONNECTION_STRING` (the last secret this service holds).
- Datadog scrape of `/metrics` (`code_adapter_exec_total`,
  `…_wrapper_parse_failures_total`, `…_entra_token_*`).

# Code Interpreter & Artifacts — how they work + local setup

A hands-on guide to turning on **Code Interpreter** (sandboxed code execution) and **Artifacts** (React/HTML/Mermaid preview) on a local KARL, plus how the sandbox works under the hood. For the **production** rollout (deploying the sandbox on AGK, JWT trust, the `/dev/kvm` decision) see the companion plan: [`../implementation-plans/code-interpreter-artifacts-rollout.md`](../implementation-plans/code-interpreter-artifacts-rollout.md).

> Both features ship with upstream LibreChat and are fully wired in the fork — they are **dark on KARL by config**, not missing code. Enabling them locally is config-only; the committed `librechat.yaml` is never touched.

---

## The two gates (mental model)

Enabling is controlled by two independent switches:

| Switch | Where | Turns on |
|---|---|---|
| `interface.runCode` | `librechat.yaml` — already `true` | The manual **Run** button on code blocks + the composer "Run Code" badge. (Permission: `RUN_CODE`.) |
| `execute_code` / `artifacts` in `endpoints.agents.capabilities` | `librechat.yaml` — currently `[file_search, tools]` | Agent **auto-run** of code, and whether **Artifacts** is offered at all. |

- **Code Interpreter** additionally needs a running **sandbox backend** (below).
- **Artifacts** needs **no backend** — it renders in the browser via Sandpack; only an egress decision.

We enable both locally by adding `execute_code` + `artifacts` to the capabilities list in a **local-only** `librechat.local.yaml`, loaded via `CONFIG_PATH`, so the committed file stays canonical.

---

## Part A — the Code Interpreter sandbox

Upstream no longer calls a paid API; it targets the self-hosted, Apache-2.0 **[ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter)** service. Run it as a **sibling repo**, never inside the fork.

```bash
# 1. Clone next to agentic-karl-v2
cd ~/repos/knauf
git clone --depth 1 https://github.com/ClickHouse/code-interpreter.git
cd code-interpreter

# 2. Build + start (first build ~10 min; compiles from source, no prebuilt image).
#    Defaults are correct for local dev: LOCAL_MODE=true (auth bypassed),
#    KVM_ENABLED=true (microVM isolation; needs /dev/kvm on the host).
docker compose up -d --build

# 3. Seed language runtimes — THE step that's easy to miss.
#    A fresh sandbox has an empty package volume, so every exec returns
#    HTTP 400 {"message":"python-3.14.4 runtime is unknown"} until seeded.
./build-packages.sh                                   # Python+pandas/numpy/matplotlib, Node, Bun, Bash
docker compose restart sandbox-runner service-worker  # re-scan the seeded volume

# 4. Verify the sandbox directly
curl -s http://localhost:2000/api/v2/runtimes         # lists python/node/bun/bash
curl -s -X POST http://localhost:3112/v1/exec \
  -H 'Content-Type: application/json' \
  -d '{"lang":"py","code":"print(40+2)"}'
# -> {"stdout":"42\n","code":0,"files":[],...}   (api log: "LOCAL MODE - Authentication bypassed")
```

The gateway KARL talks to is `http://localhost:3112/v1`.

### Where `KVM_ENABLED` / `kvmEnabled` goes

This is a **sandbox** knob — it belongs to the code-interpreter service, **never** to KARL (`librechat.yaml`, KARL's `.env`, or KARL's compose). It picks the isolation mode:

| Value | Isolation | Use |
|---|---|---|
| `KVM_ENABLED=true` (default) | NsJail **inside a libkrun microVM** — separate guest kernel | Untrusted code; needs `/dev/kvm` on the host |
| `KVM_ENABLED=false` | NsJail only — namespaces/cgroups/seccomp, **shared host kernel** | Trusted local use, or hosts without KVM |

- **Locally (docker):** it's an env var read by the sandbox repo's `docker-compose.yaml` (`KVM_ENABLED=${KVM_ENABLED:-true}`). Override per-run or in the sandbox repo's own `.env`:
  ```bash
  KVM_ENABLED=false docker compose up -d      # e.g. if /dev/kvm is unavailable
  ```
- **In production (AKS):** it's the `kvmEnabled` value in the codeapi **Helm chart** (same knob, chart layer). See the rollout plan — microVM mode needs a nested-virtualization node pool.

---

## Part B — wire KARL to the sandbox (local config)

The loader honours a `CONFIG_PATH` override ([`api/server/services/Config/loadCustomConfig.js`](../../../api/server/services/Config/loadCustomConfig.js)). `.env` is gitignored and `librechat.local.yaml` is gitignored, so none of this leaks into the committed tree.

```bash
cd ~/repos/knauf/agentic-karl-v2

# 1. Create the local config = a full copy of the canonical file + two capabilities.
cp librechat.yaml librechat.local.yaml
```

Then add two lines to the `endpoints.agents.capabilities` list in `librechat.local.yaml`:

```yaml
  agents:
    # ...
    capabilities:
      - file_search
      - tools
      # [knauf-local KK20-108] evaluation only — NOT in committed librechat.yaml.
      - execute_code
      - artifacts
```

In your (gitignored) `.env`:

```dotenv
CONFIG_PATH="/home/equilibrium/repos/knauf/agentic-karl-v2/librechat.local.yaml"   # absolute path
LIBRECHAT_CODE_BASEURL="http://localhost:3112/v1"
```

Restart the backend so it re-reads `.env`, and confirm the capabilities are live:

```bash
npm run backend:dev
curl -s localhost:3080/api/endpoints | jq '.agents.capabilities'   # includes execute_code, artifacts
```

> **Why a full copy, not a committed overlay?** Fork rule: don't split `librechat.yaml` into base + overlay. `librechat.local.yaml` is a standalone dev copy; the committed file stays the single source of truth (and is what the prod image bakes in). Keep them from drifting with a quick diff after any pull that touches the yaml — expect only the two capability lines:
> ```bash
> git diff --no-index -- librechat.yaml librechat.local.yaml
> ```

No `CODEAPI_JWT_*` is needed locally: the sandbox runs `LOCAL_MODE=true` (auth bypassed) and KARL's `getCodeApiAuthHeaders` sends no header. The full JWT surface is documented (commented, off) in [`.env.example`](../../../.env.example) for production.

---

## Part C — Artifacts

Artifacts needs **no backend**. Once `artifacts` is in the capabilities list (Part B), the composer offers it. Rendering happens in a Sandpack iframe **in the browser**:

- Unset `SANDPACK_BUNDLER_URL` → the public CodeSandbox bundler (browser must reach `*.codesandbox.io`).
- Tailwind is pulled from `cdn.tailwindcss.com/3.4.17` (hardcoded in [`client/src/utils/artifacts.ts`](../../../client/src/utils/artifacts.ts)), so present even with a self-hosted bundler.

On a locked-down corporate network, preflight by loading both URLs in a browser; if blocked, artifact previews render blank (no server error). Production can self-host the bundler (`SANDPACK_BUNDLER_URL`).

---

## Using it in the UI (as ADMIN)

- **Run button** — ask for a Python snippet, hover the code block → **Run**; output streams beneath.
- **Agent auto-run** — composer **"+"** → toggle **Run Code**, then e.g. "compute Fibonacci(20) by running Python"; or enable Code Interpreter on an agent in the builder (admins get the detailed builder by default).
- **Files** — attach a **CSV** to a code-interpreter agent → "load with pandas, print describe()" → "plot a chart"; the PNG returns inline. `.py`/`.zip` are blocked by the KK20-190 MIME allow-list — relax `supportedMimeTypes` in `librechat.local.yaml` only if needed.
- **Artifacts** — composer **"+"** → toggle **Artifacts** → "React counter with Tailwind" or "Mermaid flowchart of a login flow" → renders in the side panel.

---

## Running the sandbox alongside KARL — can it live in `docker-compose.override.yml`?

**Short answer: keep it as its own stack (recommended). You *can* wire it into KARL's compose, but it's not the best-practice path.**

- **Option A — separate stack (recommended, and how prod is shaped).** Run the sandbox from its own repo (`docker compose up -d` in `~/repos/knauf/code-interpreter`). KARL's dev backend runs on the host and reaches `http://localhost:3112/v1` directly. This keeps KARL's compose lifecycle, its slow external build, and its 8 extra services cleanly separated — and mirrors production, where the sandbox is a distinct AGK service, not part of the KARL pod.

- **Option B — launch from KARL's compose (optional convenience, with caveats).** KARL's `docker-compose.override.yml` is **gitignored** and exists to bind-mount `librechat.yaml`; it ships no code-interpreter services. You could add them via Compose's `include:` pointing at the sibling repo:
  ```yaml
  # docker-compose.override.yml (local only, gitignored)
  include:
    - path: ../code-interpreter/docker-compose.yaml   # assumes the sibling checkout
  ```
  Caveats that make this **not** the default recommendation:
  1. There are **no prebuilt images** — this pulls the sandbox's full from-source build into KARL's `docker compose up` (slow, heavy).
  2. It hard-codes a **relative path** to a specific sibling checkout — fragile across machines.
  3. You'd still run `./build-packages.sh` + restart the runner to seed runtimes.
  4. KARL's `api` service is `manual-start` and dev runs the backend **on the host**, so `localhost:3112` already works — the override buys little. If you ever run KARL's `api` **in a container**, `localhost` won't reach the sandbox: use `LIBRECHAT_CODE_BASEURL=http://api:3112/v1` on the shared compose network (or `host.docker.internal`).

Net: co-launching is possible for convenience, but the separate stack is simpler, matches prod, and avoids baking a sibling-path assumption into KARL.

---

## How the sandbox works

**Request flow** for one execution:

```
KARL (execute_code tool) --POST /v1/exec (+Bearer JWT; empty in LOCAL_MODE)--> api:3112
  api --enqueue job + signed execution manifest--> redis
  service-worker --pulls job--> sandbox-runner:2000 --executes in NsJail/microVM--> stdout/stderr/files[]
  api --response {stdout, files[]}--> KARL --GET /download/{session}/{fileId}--> persists via azure_blob --> renders in chat
```

The services (from the sandbox `docker-compose.yaml`):

| Service | Port | Role |
|---|---|---|
| **api** | 3112 (`/v1`) | HTTP gateway KARL calls. Verifies auth (bypassed in LOCAL_MODE), enqueues jobs, signs the execution manifest, returns results. Target of `LIBRECHAT_CODE_BASEURL`. |
| **service-worker** | — | Pulls jobs off Redis, drives the runner. |
| **sandbox-runner** | 2000 (`/api/v2`) | **Where code executes**, inside the isolation layer; loads runtimes from the seeded `/pkgs` volume. |
| **egress_gateway** | 3190 | The **only** network path out of the sandbox — code has no general network; outbound goes through here with a signed grant. |
| **tool_call_server** | 3033 | Routes programmatic tool calls from inside the sandbox back to the orchestrator. |
| **file_server** + **minio** | 13000, 19000 | S3-compatible session storage for input/output files. |
| **redis** | 16379 | Job queue + session state. |

**Isolation** — set by `KVM_ENABLED` (see Part A): microVM (separate guest kernel, strong) vs NsJail-only (shared host kernel, trusted-use).

**Auth** — locally bypassed via `LOCAL_MODE`. In prod the api verifies a short-lived JWT KARL mints per request ([`packages/api/src/auth/codeapi.ts`](../../../packages/api/src/auth/codeapi.ts)) with a public key matching KARL's private signing key, plus `CODEAPI_INTERNAL_SERVICE_TOKEN` for service-to-service calls.

**Files** are session-scoped: inputs land in MinIO and are mounted into the sandbox workspace; files the code writes are captured and returned in `files[]`. KARL's `processCodeOutput` downloads them, stores them via the Azure Blob strategy, and renders them — this path is separate from RAG/file-search indexing, so there's no overlap with the async-indexing (KK20-195) work.

---

## Stop / cleanup

```bash
cd ~/repos/knauf/code-interpreter
docker compose down            # stop; keeps the seeded data/pkgs (no re-seed next time)
docker compose down -v         # also wipe MinIO/redis volumes (fresh state)
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `exec` → HTTP 400 `"python-3.14.4 runtime is unknown"` | Runtimes not seeded, or seeded after the runner started. Run `./build-packages.sh` then `docker compose restart sandbox-runner service-worker`; confirm with `GET :2000/api/v2/runtimes`. |
| `/api/endpoints` doesn't show `execute_code`/`artifacts` | Backend didn't load the local config. Check `CONFIG_PATH` is an **absolute** path in `.env` and restart `backend:dev`; the startup log prints the loaded config path. |
| Run button / toggle missing for a USER | `KNAUF_RESTRICT_*` forces `RUN_CODE` off for the USER role — expected. Test as ADMIN. |
| Artifact preview renders blank | Browser can't reach the CodeSandbox bundler or `cdn.tailwindcss.com`. Check network/proxy. |
| Sandbox won't start / KVM errors | Host lacks `/dev/kvm`. Fall back to `KVM_ENABLED=false docker compose up -d`. |

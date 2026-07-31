# Code Interpreter & Artifacts — how they work + local setup

A hands-on guide to turning on **Code Interpreter** (sandboxed code execution) and **Artifacts** (React/HTML/Mermaid preview) on a local KARL, plus how the sandbox works under the hood. For the **production** rollout (deploying the sandbox on AGK, JWT trust, the `/dev/kvm` decision) see the companion plan: [`../implementation-plans/code-interpreter-artifacts-rollout.md`](../implementation-plans/code-interpreter-artifacts-rollout.md).

> **Status (KK20-243):** **Artifacts and Skills are enabled** in the committed `librechat.yaml` and ship to every environment. **Code Interpreter is still dark** — `execute_code` is excluded, because the sandbox is not deployed on AGK. So the local-setup half of this guide is now only about Code Interpreter; artifacts and skills work out of the box.

---

## The gates (mental model)

| Switch | Where | Turns on |
|---|---|---|
| `artifacts` in `endpoints.agents.capabilities` | `librechat.yaml` — **enabled** | Whether Artifacts is offered at all. No RBAC permission exists. The `karl` spec's `artifacts: 'default'` is what makes it on for new chats. |
| `skills` in `endpoints.agents.capabilities` | `librechat.yaml` — **enabled** | The deployment skills in `skill/`. Additionally needs the `SKILLS` permission and per-agent opt-in (`skills_enabled`, or the spec's `skills` field). |
| `execute_code` in `endpoints.agents.capabilities` | `librechat.yaml` — **excluded** | Agent **auto-run** of code. Also needs a reachable sandbox. |
| `interface.runCode` | `librechat.yaml` — already `true` | Only the manual **Run** button on code blocks + the composer "Run Code" badge. (Permission: `RUN_CODE`.) Not agent auto-run. |

- **Code Interpreter** additionally needs a running **sandbox backend** (below).
- **Artifacts** needs **no backend** — it renders in the browser via Sandpack; only an egress decision.
- **Skills** needs **no backend** — a skill is markdown injected into context, and `read_file` on a skill reference is served from the in-process deployment registry.

To evaluate **Code Interpreter** locally, add `execute_code` to the capabilities list in a **local-only** `librechat.local.yaml` loaded via `CONFIG_PATH`, so the committed file stays canonical. That file is gitignored. You no longer need it for artifacts or skills.

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

# 1. Create the local config = a full copy of the canonical file + one capability.
cp librechat.yaml librechat.local.yaml
```

Then add **one** line to the `endpoints.agents.capabilities` list in `librechat.local.yaml`
(`artifacts` and `skills` are already there in the committed file since KK20-243):

```yaml
  agents:
    # ...
    capabilities:
      - file_search
      - tools
      - artifacts
      - skills
      # [knauf-local KK20-108] evaluation only — NOT in committed librechat.yaml.
      - execute_code
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

Artifacts needs **no backend**, and `artifacts` is already in the committed capabilities list (KK20-243), so the composer offers it out of the box. The `karl` spec additionally sets `artifacts: 'default'`, which is what makes it on for new chats — without that key `applyModelSpecEphemeralAgent` writes `''` and forces it off on every new conversation. Rendering happens in a Sandpack iframe **in the browser**:

- Unset `SANDPACK_BUNDLER_URL` → the public CodeSandbox bundler (browser must reach `*.codesandbox.io`).
- Tailwind is pulled from `cdn.tailwindcss.com/3.4.17` (hardcoded in [`client/src/utils/artifacts.ts`](../../../client/src/utils/artifacts.ts)), so present even with a self-hosted bundler.

On a locked-down corporate network, preflight by loading both URLs in a browser; if blocked, artifact previews render blank (no server error). Production can self-host the bundler (`SANDPACK_BUNDLER_URL`).

---

## Part D — Skills (teach agents to use these features well)

**Skills** are reusable instruction bundles (`SKILL.md` files) the model can pull into context on demand — the natural companion to Code Interpreter + Artifacts, since a skill can encode *how* to use them well. This is a **built-in LibreChat feature** (v0.8.7); enabling it is config + markdown, no application code.

**It's a third capability on the same gate, and it is already on** — `skills` is in the committed `endpoints.agents.capabilities` (KK20-243). That switch turns the subsystem on (`skillsCapabilityEnabled`, [`api/server/services/Endpoints/agents/initialize.js`](../../../api/server/services/Endpoints/agents/initialize.js)).

Two RBAC details that are easy to get wrong: the schema defaults are `use: true` / `create: true`, but the committed `interface.skills` block sets **`create: false`** on purpose — authoring stays with platform engineering. And that block has to exist at all, because `hasExplicitConfig` only rewrites a role document when the matching `interface.*` key is present; without it the role docs freeze at whatever was written when they were first created. The `AGENT_BUILDER` role is separate again and needs [`knauf/scripts/seed-agent-builder-role.js`](../../scripts/seed-agent-builder-role.js) run manually per environment.

**Skills do NOT need the code sandbox.** A `SKILL.md` body is injected into the model's context as a primed message; bundled `references/*` files are read **host-side** via the `read_file` tool. Only `scripts/*` execution (via `bash_tool`) needs the sandbox — optional. So skills work even with `execute_code` off.

**Three sources** (all merged behind one catalog):
- **Deployment skills** — read-only, from `DEPLOYMENT_SKILLS_DIR` (default `./skill`, already tracked + mounted + copied by `Dockerfile.multi`). Layout: `skill/<name>/SKILL.md` (+ optional `references/`, `scripts/`). **Loaded once at startup** — restart after edits. Bad frontmatter **aborts boot**; a clean boot logs `[deploymentSkills] Loaded N deployment skill(s)`.
- **User-created** — authored/uploaded in the Skills UI (Mongo-backed, live-editable).
- **GitHub sync** — mirrored via `skillSync.github` in the yaml.

**Frontmatter** is strictly validated ([`packages/data-schemas/src/methods/skill.ts`](../../../packages/data-schemas/src/methods/skill.ts)): required `name` (kebab-case ≤64) + `description`; useful optionals `argument-hint`, `user-invocable`, `disable-model-invocation`, `always-apply`, `allowed-tools`. Unknown keys are rejected — which aborts boot for a deployment skill.

**The description cap that matters is 250, not 1024.** `formatSkillCatalog` truncates every catalog entry at 250 chars, so any trigger word past that point never reaches the model. 1024 is only the storage limit. See [`skill/README.md`](../../../skill/README.md) for the full authoring rules.

**Invocation:** the model picks from an injected catalog (name + description only — cheap), the user types `$` for a manual popover, or `always-apply` primes every turn. Per agent: the builder's **Skills** toggle (`skills_enabled`) + an optional allowlist. Note the modelSpec `skills: true` on the `karl` spec makes `skills_enabled` unconditional for default-spec chats, which short-circuits the composer chip.

**Six deployment skills ship in `skill/`:**

- **`agent-builder-coach`** — grounded guidance for designing, configuring, testing, and preparing governed custom agents for admin-controlled publication.
- **`karl-brand`** — the single source of truth for Knauf brand tokens: the official colour system, a chart palette validated for CVD separation and contrast in both light and dark, ink/surface tokens, and the real KNAUF wordmark as an inline SVG path. Other skills read it via `read_file skills/karl-brand/SKILL.md`; it must stay model-invocable for that to work.
- **`karl-artifacts`** — artifact type selection, the react import allowlist, the top preview-breaking mistakes, update-in-place discipline, and branded report / slides / dashboard templates that consume `karl-brand`.
- **`karl-guide`** — user-facing product guidance for Karl capabilities, navigation, role/group access, settings, limits, and troubleshooting.
- **`karl-mermaid`** — Mermaid 11.15.0 generation and repair rules. Its catalog description triggers for every Mermaid request, and `karl-artifacts` reads it explicitly before emitting a Mermaid artifact.
- **`web-research`** — routing and source discipline for Azure-hosted model search, exact-page `open_url`, File Search, and stable answers that need no browsing.

A seventh candidate, `karl-data-analysis`, is parked at `skill/_disabled/` — its body describes `bash_tool` and `/mnt/data`, so it stays out of the catalog until `execute_code` is on. One `git mv` re-enables it.

They deliberately **layer on** the prompts LibreChat already injects — they restate no directive syntax. `packages/api/src/skills/__tests__/deploymentSkills.knauf.spec.ts` guards the shipped tree; run it after editing any skill.

---

## Using it in the UI (as ADMIN)

- **Run button** — ask for a Python snippet, hover the code block → **Run**; output streams beneath.
- **Agent auto-run** — composer **"+"** → toggle **Run Code**, then e.g. "compute Fibonacci(20) by running Python"; or enable Code Interpreter on an agent in the builder (admins get the detailed builder by default).
- **Files** — attach a **CSV** to a code-interpreter agent → "load with pandas, print describe()" → "plot a chart"; the PNG returns inline. `.py`/`.zip` are blocked by the KK20-190 MIME allow-list — relax `supportedMimeTypes` in `librechat.local.yaml` only if needed.
- **Artifacts** — composer **"+"** → toggle **Artifacts** → "React counter with Tailwind" or "Mermaid flowchart of a login flow" → renders in the side panel.
- **Skills** — type `$` in the composer → the popover lists all six skills above; pick one, or let the model invoke it from its catalog (watch for a `skill(...)` call in the run, then a `read_file` on the relevant `skills/<name>/SKILL.md`). New agents start with **Use Knauf skills** enabled; existing agents retain their saved setting. Good end-to-end prompts: *"build a Knauf-branded status report"*, *"draw a sequence diagram of this flow"*, *"what can Karl do?"*, and *"help me test this agent"*.

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

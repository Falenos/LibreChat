# Code Interpreter backend — self-hosted ClickHouse vs Azure managed (decision doc)

> **Status: DECIDED (Aug 2026) — Option B, Azure Container Apps dynamic sessions + Tier-3 adapter.** The deciding factors were the ones §8.3 predicted: AGK cannot comfortably host the `SYS_ADMIN`/`seccomp:Unconfined` pod NsJail needs (designs doc risk R1), and the managed Hyper-V + ~zero-idle-cost model fits the platform. The adapter lives at [`knauf/code-adapter/`](../../code-adapter/); the build-out is Option 2 of [`code-interpreter-implementation-designs.md`](code-interpreter-implementation-designs.md). This doc remains the decision record. Ticket: **KK20-108**.
>
> **Correction (Aug 2026):** §1a below understates the integration seam. The full verified endpoint inventory an alternate backend must serve additionally includes `POST /upload/batch` (with a `read_only` flag), `GET /sessions/{s}/objects/{f}` (freshness probe), the `DELETE /files/{s}/{f}` fallback, `POST /exec/programmatic` (PTC), the `?kind&id&version` identity query on every file call, and per-file `storage_session_id` + `inherited` response fields. Also, `@librechat/agents` is a published npm dependency, not vendored — and its `CodeExecutor`/`BashExecutor` freeze the exec URL at module load, so `LIBRECHAT_CODE_BASEURL` must be set before boot and cannot be swapped at runtime. The authoritative contract table is now [`knauf/code-adapter/README.md`](../../code-adapter/README.md).

> **First, a scoping clarification.** This decision is about the **Code Interpreter execution backend only**. **Artifacts is not a backend choice** — it renders in the browser (Sandpack) and needs no execution service; its only infra axis is the bundler host (see [§7](#7-artifacts-not-a-backend-decision)). So "an Azure service for artifacts" doesn't exist; the comparison below is entirely about where user code *runs*.

---

## TL;DR — recommendation

| Option | Isolation | LibreChat integration | Cost model | Ops burden | Verdict |
|---|---|---|---|---|---|
| **A. Self-host ClickHouse/code-interpreter** (Apache-2.0) | NsJail (shared kernel) *or* libkrun microVM (needs `/dev/kvm`) | **Zero code** — it *is* the LibreChat Code API | Fixed infra (runs 24/7) | High — you run 8 services + the KVM node-pool question | **Recommended primary**, NsJail-only to start |
| **B. Azure Container Apps dynamic sessions** | Hyper-V, MS-managed | **Needs a Tier-3 adapter** (contract + auth differ) | Consumption `$0.03`/session-hour, ~zero idle | Low sandbox ops; you own a small adapter | **Recommended to pilot** if the KVM/ops burden is the blocker |
| **C. Azure OpenAI Assistants `code_interpreter`** | MS-managed | Separate endpoint; **not** the `execute_code` path | per-session | — | **Rejected — API retires 2026-08-26** |
| D. DIY sandbox (ACI/AKS, hand-rolled) | whatever you build | you build everything | infra | Very high | Rejected — rebuilds A badly |

**Recommendation:** start with **Option A (self-hosted ClickHouse), running NsJail-only on standard AKS nodes** — it's zero-code (it implements LibreChat's exact API), multi-language, has no per-execution metering, keeps all data in-cluster, and NsJail-only avoids the nested-virtualization node-pool problem. Accept the weaker (shared-kernel) isolation because KARL runs **authenticated internal Knauf users**, not arbitrary public code. Add microVM isolation later (a nested-virt node pool) only if the threat model tightens. **Keep Option B (ACA dynamic sessions + adapter) as the escape hatch** if the sandbox ops burden proves unwelcome — it's the more Azure-idiomatic, serverless choice and removes the isolation-infra problem entirely, at the cost of building and owning an adapter and living with its limits.

---

## 1. The integration seam — what any backend must satisfy in LibreChat

There are **two independent code-execution integrations** in LibreChat. They are not interchangeable:

### 1a. The `execute_code` tool → the "LibreChat Code API" (the one that matters)

This is the path KARL uses (agents auto-run + the manual **Run** button + `interface.runCode`). The tool ([vendored `@librechat/agents` `CodeExecutor`](../../../packages/api)) and the file services ([`api/server/services/Files/Code/crud.js`](../../../api/server/services/Files/Code/crud.js)) call a **fixed HTTP contract** rooted at `LIBRECHAT_CODE_BASEURL`:

| Call | Purpose |
|---|---|
| `POST {base}/exec` — body `{ lang, code, entity_id?, files? }` → `{ session_id, stdout, stderr, code, files[] }` | Execute code |
| `POST {base}/upload` / `POST {base}/upload/batch` → `{ storage_session_id, files:[{fileId,filename}] }` | Seed input files |
| `GET {base}/download/{session_id}/{fileId}` | Fetch an output artifact |
| `DELETE {base}/sessions/{session}/objects/{fileId}` | Delete session files |

Auth headers are minted per request by [`packages/api/src/auth/codeapi.ts`](../../../packages/api/src/auth/codeapi.ts) (short-lived JWT; empty in the sandbox's `LOCAL_MODE`). Output files land in `/mnt/data`, are returned in `files[]`, then [`processCodeOutput`](../../../api/server/services/Files/Code/process.js) downloads and re-persists them via KARL's `azure_blob` strategy.

**The key fact: any backend that speaks this exact contract is a drop-in (`LIBRECHAT_CODE_BASEURL` and nothing else). Any backend that doesn't needs an adapter.** ClickHouse/code-interpreter speaks it natively; ACA dynamic sessions does not.

### 1b. The Assistants `code_interpreter` capability (a different, dead-end path)

`Capabilities.code_interpreter` ([`packages/data-provider/src/config.ts`](../../../packages/data-provider/src/config.ts)) is a capability of the **`assistants`/`azureAssistants` endpoint**, backed by the OpenAI/Azure OpenAI Assistants API — entirely separate from the agents `execute_code` path. KARL sets `assistants: false` and runs agents/modelSpecs, so this is unused. It is also **deprecated** (see [§6](#6-option-c--azure-openai-assistants-code_interpreter--rejected)). Ignore it.

### 1c. There is no native Azure Container Apps client in LibreChat

Confirmed by search: nothing in `packages/`, `api/`, or the vendored agents references dynamic sessions / session pools / `/executions`. So Option B is only reachable through an **adapter** (or a fork of the executor, which we reject).

---

## 2. Option A — self-host ClickHouse/code-interpreter

The Apache-2.0 service ([github.com/ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter)) that upstream LibreChat targets. Components: `api` gateway, `service-worker`, `sandbox-runner`, `egress_gateway`, `tool_call_server`, `file_server` + MinIO, Redis. Ships a `helm/codeapi` chart.

- **Integration: zero code.** It *is* the LibreChat Code API (§1a). Point `LIBRECHAT_CODE_BASEURL` at it; enable JWT (`CODEAPI_AUTH_PROVIDER=librechat-jwt`) for prod. Nothing in the fork changes.
- **Isolation:** `KVM_ENABLED=true` → NsJail inside a **libkrun microVM** (separate guest kernel; strong; needs `/dev/kvm`). `KVM_ENABLED=false` → **NsJail-only** (namespaces/cgroups/seccomp, shared host kernel; weaker).
- **The AKS problem:** microVM mode needs `/dev/kvm`, i.e. a **nested-virtualization node pool** (Dsv3/Esv3+ families) with device exposure + taints. Standard AKS nodes don't have it. **NsJail-only sidesteps this entirely** and is defensible for authenticated internal users.
- **Cost:** infrastructure only, but it runs continuously (worker pool + Redis + MinIO). No per-execution charge.
- **Languages/limits:** Python, Node, Bun, Bash out of the box (runtimes seeded by a package-init job); output cap configurable (64 KB default), file artifacts to ~150 MB. Multi-language and large-output friendly.
- **Data residency:** everything in-cluster / in-tenant.
- **Ops:** you operate, patch, scale, and secure 8 services + storage; egress is locked down by the built-in egress gateway.

**Best for:** multi-language, large outputs/files, no per-exec metering, full data-plane control — if you accept the ops burden (and either NsJail-only or a nested-virt pool).

---

## 3. Option B — Azure Container Apps dynamic sessions (managed) + adapter

Azure's managed "safely run AI-generated code" service. A **session pool** hands out **Hyper-V-isolated** sandboxes on demand; the built-in **code interpreter** runs Python (GA; JavaScript in preview) with numpy/pandas/matplotlib preinstalled. Dynamic sessions are GA.

- **Contract (differs from LibreChat's):** `POST {POOL_MANAGEMENT_ENDPOINT}/executions?api-version=<v>&identifier=<session>` with a body like `{ "properties": { "codeInputType": "inline", "executionType": "synchronous", "code": "…" } }`; files via the pool's file endpoints (`/files` upload, `/files/content/{name}?identifier=`). The `identifier` is a **client-chosen string** (4–128 chars) — maps cleanly to LibreChat's `session_id`/conversation.
- **Auth (differs from LibreChat's):** Microsoft **Entra token**, audience **`https://dynamicsessions.io`**, RBAC role **"Azure ContainerApps Session Executor"** on the pool, obtained via **managed identity** (`DefaultAzureCredential`). No static key.
- **Isolation:** Hyper-V per session, operated by Microsoft — **no `/dev/kvm`/node-pool problem**. This is the headline advantage.
- **Cost:** consumption, **`$0.03` per session-hour**; ~zero idle cost (besides the tiny adapter). Sessions are destroyed after a cooldown.
- **Limits to weigh:**
  - **Output truncates at ~4000 characters** for the built-in code interpreter (documented hard limit) — real friction for verbose runs; the adapter must detect/segment or write-to-file-and-download around it.
  - Network egress is **off by default** (good), so runtime `pip install` needs an explicit egress-enabled pool.
  - Python-centric; other languages need a **custom container session** (BYO image — still Hyper-V isolated), which erodes the "managed, zero-infra" benefit.
- **The required adapter (Tier 3 sidecar).** Because the contracts differ in path, payload, auth, and file addressing, you deploy a small stateless service that **presents the LibreChat Code API on one side and calls ACA on the other**, keeping `execute_code` (and the whole fork) untouched. This is squarely a **Tier-3 sidecar/edge-proxy** in the fork ladder — net-new, not an upstream modification. It must:

  | LibreChat Code API (in) | → adapter does → | ACA dynamic sessions (out) |
  |---|---|---|
  | `POST /exec {lang,code,files}` | mint Entra token (MI, aud `dynamicsessions.io`); map `session_id`→`identifier` | `POST /executions?identifier=…` `{properties:{code,…}}` |
  | response `{stdout,stderr,files[]}` | reshape; **handle the 4000-char cap** (e.g. force artifacts to `/mnt/data` + download) | executions response |
  | `POST /upload[/batch]` | forward multipart | pool `/files` upload |
  | `GET /download/{session}/{fileId}` | forward | pool `/files/content/{file}?identifier=` |
  | JWT/`LOCAL_MODE` auth | validate KARL's minted JWT (reuse `codeapi.ts` verifier posture) | — |

  Effort: a few hundred lines + its own Helm deploy, managed identity + role assignment, and ongoing maintenance as the ACA API-version moves. LangChain/Semantic-Kernel already wrap this API (proof the contract is stable and small), but LibreChat has no such client, so we build the adapter.

**Best for:** an Azure-first shop that wants MS-run isolation and serverless cost and would rather build a thin adapter than run a nested-virt node pool — accepting the output cap and Python-centricity.

---

## 4. Option D — DIY sandbox — rejected

Hand-rolling a sandbox on ACI/AKS re-implements exactly what ClickHouse already ships (queue, isolation, egress control, file server, the LibreChat contract). No upside over Option A. Rejected.

---

## 5. Comparison matrix

| Dimension | A. ClickHouse self-host | B. ACA dynamic sessions + adapter |
|---|---|---|
| LibreChat code change | **None** (native contract) | Adapter sidecar (net-new Tier-3) |
| Isolation | NsJail *or* microVM (you choose/operate) | Hyper-V (MS-operated) |
| `/dev/kvm` / node pool | microVM yes; NsJail no | **Never your problem** |
| Cost | Fixed infra, always-on | `$0.03`/session-hr, ~zero idle |
| Languages | Python/Node/Bun/Bash (+more) | Python GA, JS preview; else custom container |
| Output size | configurable (64 KB default) | **~4000 chars (hard cap)** |
| File artifacts | ~150 MB | via pool file endpoints |
| Egress control | built-in egress gateway | off by default; per-pool |
| Data residency | fully in-cluster/tenant | in your Azure subscription/region |
| Ops burden | **High** (8 services + storage + KVM decision) | Low sandbox ops; **own the adapter** |
| Failure blast radius | you patch/scale | MS patches/scales the sandbox |
| Fit with AGK (Azure/GitOps) | Helm chart, but heavy | Very Azure-idiomatic |

---

## 6. Option C — Azure OpenAI Assistants `code_interpreter` — rejected

The Assistants API's built-in code interpreter would only plug into LibreChat's **assistants endpoint** (§1b), not the agents `execute_code` path KARL uses. More decisively: **Microsoft retires the Azure OpenAI Assistants API on 2026‑08‑26.** Its successor, the **Foundry Agent Service** code interpreter tool ($0.03/session US base), is a *different* API that LibreChat's `execute_code` does not target. Building toward a service that retires in ~a month is a non-starter. Rejected.

> **Its successor is also not a fit** (researched + fact-checked July 2026): the Foundry Agent Service Code Interpreter
> exposes **no deterministic "execute this code" endpoint** — code runs only when the Foundry *agent's own LLM* authors
> and invokes it (non-verbatim, Python-only, no stderr/exit-code model, double token cost + $0.03/session). Its sandbox
> is ACA dynamic sessions underneath — i.e. Option B's engine. If Azure-managed execution is wanted, integrate ACA
> directly. Concrete build-out for both finalists: [`code-interpreter-implementation-designs.md`](code-interpreter-implementation-designs.md).

---

## 7. Artifacts — not a backend decision

Artifacts renders client-side in a Sandpack iframe. There is **no execution service** and thus **no Azure "artifacts service"** to choose. The only infra axis:

- **Bundler:** unset `SANDPACK_BUNDLER_URL` → public CodeSandbox bundler (browser egress to `*.codesandbox.io`); or **self-host the Sandpack bundler** (a static site) — deployable on **Azure Static Web Apps** or a small Container App behind Traefik — and set `SANDPACK_BUNDLER_URL` to it. This is the only "Azure option," and it's about *hosting a static bundler*, not code execution.
- **Tailwind CDN** (`cdn.tailwindcss.com`) is hardcoded in [`client/src/utils/artifacts.ts`](../../../client/src/utils/artifacts.ts); closing that egress fully would need a small Tier-4c seam to vendor it.

So artifacts ships independently of whichever code-interpreter backend wins here — enable the capability, decide bundler egress, done.

---

## 8. Recommendation & next steps

1. **Primary: Option A, NsJail-only, on standard AKS nodes.** Zero code, multi-language, no per-exec cost, data in-cluster, and no nested-virt pool. Justified by the authenticated-internal-user threat model. Revisit microVM (nested-virt pool) only if untrusted-code exposure grows. → this is what the [rollout plan](../implementation-plans/code-interpreter-artifacts-rollout.md) already sequences.
2. **Escape hatch: Option B (ACA + adapter).** If the sandbox ops burden is unwelcome, pilot ACA dynamic sessions behind a Tier-3 adapter. Spin up a session pool, prove `POST /executions` with a managed identity, then build the adapter against the contract table in §3. The output cap and Python-centricity are the acceptance risks to validate first.
3. **Decide the isolation bar** (NsJail-only vs microVM vs MS-Hyper-V) explicitly with security — it's the real fork in the road, and it largely picks A-NsJail vs A-microVM vs B for you.
4. **Artifacts:** orthogonal — enable the capability and pick the bundler egress posture (§7).

## Open questions

- Is shared-kernel (NsJail-only) isolation acceptable for KARL's internal, authenticated audience, or is a separate guest kernel (microVM / Hyper-V) required by policy? (Decides A-NsJail vs A-microVM vs B.)
- Expected execution volume — at high volume, ACA's per-session-hour cost vs always-on ClickHouse infra changes the economics. Model both.
- Does the ACA ~4000-char output cap materially hurt the KARL use cases (data analysis, chart code)? Prototype before committing to B.

---

## Sources

- ClickHouse/code-interpreter (Apache-2.0): https://github.com/ClickHouse/code-interpreter
- Dynamic sessions overview — Microsoft Learn: https://learn.microsoft.com/en-us/azure/container-apps/sessions
- Use dynamic sessions (API, auth, identifiers, security) — Microsoft Learn: https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage
- Code interpreter sessions — Microsoft Learn: https://learn.microsoft.com/en-us/azure/container-apps/sessions-code-interpreter
- Dynamic sessions GA announcement — Microsoft Community Hub: https://techcommunity.microsoft.com/blog/appsonazureblog/azure-container-apps-dynamic-sessions-general-availability-and-more/4303561
- "Secure Sandboxes at Scale" (pricing `$0.03`/session-hour) — Microsoft Community Hub: https://techcommunity.microsoft.com/blog/appsonazureblog/new-secure-sandboxes-at-scale-with-azure-container-apps-dynamic-sessions/4142148
- LangChain Azure dynamic sessions tool (contract reference): https://docs.langchain.com/oss/javascript/integrations/tools/azure_dynamic_sessions
- Azure OpenAI Assistants API retirement (2026‑08‑26) — Microsoft Q&A: https://learn.microsoft.com/en-us/answers/questions/5873362/azure-open-ai-assistants-apis-deprecated-transitio
- Foundry Agent Service code interpreter (`$0.033`/session) — Microsoft Learn: https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/code-interpreter

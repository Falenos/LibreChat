# Code execution backend — decision record

> **Status: DECIDED (Aug 2026) — Azure Container Apps dynamic sessions**, behind the
> [`knauf/code-adapter`](../../code-adapter/) sidecar. Ticket: **KK20-108**.
> This is the condensed record; it supersedes the two longer evaluation drafts (backend-options +
> implementation-designs) that weighed a self-hosted sandbox in depth. How the chosen backend works is in
> [`how-it-works.md`](how-it-works.md); why a sidecar rather than in-process code is in
> [`placement-and-justification.md`](placement-and-justification.md).

## What was decided

KARL executes model-authored code in **Azure Container Apps dynamic sessions** — Microsoft-managed, per-session
Hyper-V-isolated sandboxes — reached through a small Knauf adapter that presents LibreChat's Code API. Two built-in
pools: **Python** (`lang=py`) and **Shell** (`lang=bash`).

## The options that were weighed

| Option                                                               | What it is                                                                                                                            | Verdict                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **A. Self-hosted sandbox** (ClickHouse/code-interpreter, Apache-2.0) | The service upstream LibreChat targets; speaks the Code API natively (zero adapter). Runs ~8 services + Redis + MinIO on our own AKS. | **Rejected** — see the deciding factor below                                                   |
| **B. ACA dynamic sessions + adapter**                                | Microsoft-run Hyper-V sandboxes; needs a Tier-3 adapter because the contract/auth differ.                                             | **CHOSEN**                                                                                     |
| C. Azure OpenAI Assistants `code_interpreter`                        | A different endpoint (assistants, not the agents `execute_code` path KARL uses).                                                      | **Rejected** — API retired 2026-08-26; its Foundry successor exposes no verbatim-exec endpoint |
| D. DIY sandbox on ACI/AKS                                            | Hand-roll queue + isolation + file server.                                                                                            | **Rejected** — rebuilds option A badly                                                         |

## The deciding factor

It was not a feature comparison — it was **platform fit**, and it came down to one question:
_will AGK admission allow the privileged pod the self-hosted sandbox needs?_

The self-hosted sandbox's NsJail isolation (in the no-nested-virtualization mode AGK's standard nodes force) requires
a container with `SYS_ADMIN` + `seccompProfile: Unconfined`. **AGK has zero precedent for any capability-bearing or
privileged pod** — every workload in the GitOps repo runs with `securityContext: {}` on one shared spot pool. Shipping
the first `SYS_ADMIN` pod there, to run adversarial model-authored code, is the posture AGK is least suited to. The
nested-virtualization alternative (a dedicated `/dev/kvm` node pool for microVM isolation) is a node-pool project AGK
also has no precedent for.

ACA removes the question entirely: **Microsoft operates the isolation** (Hyper-V per session), so there is no
privileged pod, no node-pool spike, and no kernel to patch. The costs we accept in exchange — building and owning a
small adapter, the ~220 s exec cap, the 128 MB upload cap, and living on a preview data-plane API — are all bounded
and are documented in [`how-it-works.md`](how-it-works.md).

Secondary factors that pointed the same way: **~zero idle cost** (consumption billing, sessions self-destruct after a
cooldown) vs the always-on fleet of the self-hosted option; and a far smaller ops surface (one stateless proxy vs
eight services + storage + a fork of the sandbox repo to maintain).

## What the choice costs (and how it's mitigated)

| Cost                                                                                                                                                                                               | Mitigation                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter is net-new code we own                                                                                                                                                                     | ~2,000 lines, one contract, contract-replay test suite; Tier-3, zero upstream edits                                                                                              |
| No native exit code (Python pool) / ~4000-char stdout cap                                                                                                                                          | The adapter's sentinel wrapper restores both                                                                                                                                     |
| 220 s exec cap, 128 MB upload cap                                                                                                                                                                  | Friendly `code:1` messages; RAG remains the large-file path                                                                                                                      |
| Preview data-plane API churn                                                                                                                                                                       | api-versions pinned per pool + fixture tripwire test; the adapter is the single choke point                                                                                      |
| First workload-identity app pod on AGK                                                                                                                                                             | Proven on a small pod, not the main app (see placement doc §3.4)                                                                                                                 |
| **Built-in Shell pool lacks the data-science stack** (verified: no pandas/numpy; egress disabled ⇒ no `pip install`) — and agent code execution runs entirely through `bash_tool` → the Shell pool | **Open decision, below.** The built-in `PythonLTS` + `Shell` pools were the S1 plan; the pandas gap in the pool agents actually use means the bash pool must gain the libraries. |

## Open decision — the execution pool must carry the data-science stack

The S1 spike confirmed the `Shell` pool runs `python3`, but a later check found it
has **no pandas/numpy/matplotlib**, and the entire agent path (`bash_tool`,
`lang=bash`) routes there — while pandas lives only in the `Python` pool, which
agents never call (evidence in [`how-it-works.md`](how-it-works.md)). So the
two-built-in-pools plan doesn't support KARL's data-analysis use case. Options,
to settle before the `agk-infrastructure` Terraform lands:

1. **Consolidate on the built-in Python (code-interpreter) pool — RECOMMENDED.**
   Verified live: that pool already has **both `bash` (`/usr/bin/bash`) and
   pandas/numpy/matplotlib**, and a bash subprocess inside it sees pandas. Route
   **both** `lang=py` and `lang=bash` to it (the adapter's wrapper runs bash via
   `subprocess.run(['bash', …])`, still giving a real exit code) and **drop the
   Shell pool**. This closes all three gaps with **no image to build/own and no
   egress**: pandas is present for bash; `py`/`bash` share one sandbox per
   conversation (files visible across both); egress stays disabled. Adapter change
   only (point both dialects at `/code/execute`); infra simplifies to one pool.
2. **CustomContainer pool with a bespoke image.** Only if KARL needs libraries the
   code-interpreter image lacks. Cost: build+own an image (+`build-*` workflow),
   confirm CustomContainer billing and that it still exposes the exec/file API.
   Reserve as a fallback.
3. **Enable egress + `pip install` at session start.** Verified working (~7 s for
   pandas on a cold session), but it opens sandbox internet egress — the posture
   you want **off** for untrusted model code — and adds per-session latency.
   Quick unblock, not the end state.

This does **not** reopen the ACA-vs-self-hosted decision — it is about _which pool_
(and image) ACA runs, entirely within the chosen backend.

## Verification

The choice was de-risked with a live spike (S1/S5) before committing infra: both pools created in West Europe, the
`Shell` image confirmed to carry `python3` + the tooling the wrapper needs, the real request/response contracts pinned
as fixtures, and the full path — including a CSV→pandas→PNG round-trip — run end to end. See
[`how-it-works.md`](how-it-works.md) and `knauf/code-adapter/test/fixtures/aca/`.

## Not a backend decision: Artifacts

Artifacts (React/HTML/Mermaid preview) renders **client-side in a Sandpack iframe** and needs no execution service —
its only infra axis is the bundler egress, tracked separately in the artifacts + skills rollout. It ships independently
of whatever code-execution backend is chosen.

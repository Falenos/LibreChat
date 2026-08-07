# Code execution (KK20-108)

How KARL runs model-authored Python and Bash: **Azure Container Apps dynamic sessions** behind the
[`knauf/code-adapter`](../../code-adapter/) Tier-3 sidecar. This folder is the code-execution story end to end;
Artifacts and Skills are separate features documented in
[`../architecture/code-interpreter-and-artifacts.md`](../architecture/code-interpreter-and-artifacts.md) and the
[artifacts + skills rollout](../implementation-plans/code-interpreter-artifacts-rollout.md).

| Doc                                                              | Read it for                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [how-it-works.md](how-it-works.md)                               | The architecture and request flow; the exec wrapper (real exit codes + output-cap recovery); **session/sandbox reuse and isolation** (same conversation = same sandbox, different = isolated; files persist, variables don't); the file journey; local vs prod. Start here. |
| [backend-decision.md](backend-decision.md)                       | Why ACA dynamic sessions and not a self-hosted sandbox (or Azure OpenAI Assistants) — the decision record and the platform-fit reasoning that drove it.                                                                                                                     |
| [placement-and-justification.md](placement-and-justification.md) | Why the adapter is a separate sidecar rather than code inside LibreChat — the dimension-by-dimension comparison, re-verified after building it live.                                                                                                                        |
| [deployment.md](deployment.md)                                   | **Infra deployment runbook** — step-by-step across agk-infrastructure (Terraform: pool + workload identity), agk-deployment-configs (GitOps service), LibreChat wiring, and the capability flip; verified-environment table, ordering constraints, verification, rollback.  |

**Operational reference** (env vars, the served contract table, how to run/test/build/deploy) lives with the service:
[`knauf/code-adapter/README.md`](../../code-adapter/README.md).

**Rollout status:** the adapter is built and verified live against a spike subscription; the remaining AGK work —
`agk-infrastructure` Terraform (one code-interpreter pool + workload identity) and the `agk-deployment-configs` deploy —
is the step-by-step [deployment runbook](deployment.md).

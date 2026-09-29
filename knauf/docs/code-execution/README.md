# Code execution (KK20-108)

How KARL runs model-authored Python and Bash: **Azure Container Apps dynamic sessions** behind the
[`knauf/code-adapter`](../../code-adapter/) Tier-3 sidecar. This folder is the code-execution story end to end;
Artifacts and Skills are separate features documented in
[`../architecture/code-interpreter-and-artifacts.md`](../architecture/code-interpreter-and-artifacts.md) and the
[artifacts + skills rollout](../implementation-plans/code-interpreter-artifacts-rollout.md).

| Doc                                                              | Read it for                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [how-it-works.md](how-it-works.md)                               | The architecture and request flow; the exec wrapper (real exit codes + output-cap recovery); **the sandbox/file model** (every exec is a fresh, isolated sandbox — files persist only by being re-pushed from staging each call, not by session reuse; variables never persist); the file journey; local vs prod. Start here.           |
| [backend-decision.md](backend-decision.md)                       | Why ACA dynamic sessions and not a self-hosted sandbox (or Azure OpenAI Assistants) — the decision record and the platform-fit reasoning that drove it.                                                                                                                                                                                 |
| [placement-and-justification.md](placement-and-justification.md) | Why the adapter is a separate sidecar rather than code inside LibreChat — the dimension-by-dimension comparison, re-verified after building it live.                                                                                                                                                                                    |
| [deployment.md](deployment.md)                                   | **Infra deployment runbook** — step-by-step across agk-infrastructure, immutable image publication, the asynchronous dev→stage GitOps rail, LibreChat wiring, verification, manual image rollback, and the separate production path.                                                                                                    |
| [deploy-to-dev.md](deploy-to-dev.md)                             | **The execution checklist for nonproduction rollout** — provenance-driven automatic dev→stage delivery, the infrastructure/security prerequisites that stay outside that rail, layer-by-layer verification, and reviewed rollback to a retained prior digest.                                                                           |
| [sandbox-inventory.md](sandbox-inventory.md)                     | **What the sandbox actually has** (probed live, KK20-398) — the two Pythons and which one `bash_tool` uses, the document stack (python-docx/pptx, reportlab, WeasyPrint, pypdf, rasterisers), binaries present and absent, fonts, LibreOffice timings, `/mnt/data` hygiene, and how to re-run the probe. |
| [scaling.md](scaling.md)                                         | **Capacity and scaling** — the four concurrency domains and which one binds (the session pool, not the pods); what one execution costs in pool-slot time (exec + 300 s cooldown) and the sustained-throughput math; why adapter memory, not CPU, is the pod limit; the timeout ladder; metrics to watch and the knob-per-symptom table. |

**Operational reference** (env vars, the served contract table, how to run/test/build/deploy) lives with the service:
[`knauf/code-adapter/README.md`](../../code-adapter/README.md).

**Rollout status:** dev/stage infrastructure and adapter wiring exist; production activation remains
separate. The app uses the default-off `KNAUF_CODE_EXECUTION_ENABLED` kill switch plus a
controlled `LIBRECHAT_CODE_BASEURL`, and hides code-dependent skills whenever the effective
environment is unavailable. See the [deployment runbook](deployment.md).

# Agentic Karl Load And Stress Testing Plan

Generated: 2026-05-21

## Goal

Prepare Agentic Karl for production rollout by finding capacity limits, failure modes, and scaling requirements before real user traffic exposes them. Daily active users alone is not enough for sizing. The test needs peak concurrent users, messages per minute, average prompt/response tokens, RAG usage rate, upload rate, and image generation rate.

## System Under Test

```text
Users
  |
  v
Cloudflare / Azure Firewall / Ingress
  |
  v
LibreChat SPA
  |
  v
LibreChat API (Node / Express)
  |-- POST /api/agents/chat ---------------> Azure OpenAI chat/image models
  |-- GET  /api/agents/chat/stream/:id ----> SSE back to browser
  |-- writes/reads ------------------------> Cosmos DB Mongo API
  |-- stream jobs/rate limits/sessions ----> Redis, required for multi-pod scale
  |-- uploads/images ----------------------> shared storage / Azure Files / Blob target
  |-- conversation search -----------------> MeiliSearch
  |
  +-- file_search tool --------------------> rag_api /query
  |                                             |
  |                                             v
  |                                      pgvector / Cosmos DB for PostgreSQL
  |
  +-- file upload with file_search --------> rag_api /embed
                                                |
                                                v
                                         Azure OpenAI embeddings
```

Pod/scaling clarification: the API routes are not split across different API pods. Each `LibreChat API` pod is an identical replica of the full Node/Express API and can receive any API route through the Kubernetes Service/Ingress. When the plan says "API pods", it means multiple copies of the same backend app behind the load balancer. RAG API, Redis, MeiliSearch, databases, and storage are separate components/services, not route-specific pieces of the LibreChat API pod.

This is why Redis and shared storage matter. With multiple identical API pods, long-running stream state, sessions, rate limits, abort/resume metadata, and uploaded artifacts must live outside one pod. Otherwise a reconnect, retry, pod restart, or HPA scale event can land on a different pod that does not know about the original request.

Important route correction: the C4 flow names chat as `POST /messages`, but live generation runs through `POST /api/agents/chat` and streams through `GET /api/agents/chat/stream/:streamId`. `/api/messages` is mainly message/history CRUD and search.

## What We Test

For the first team-approved run, do not try to test everything below at equal depth. Treat the table as a full reference map. The MVP stress test should focus on the real peak user mix:

- Normal chat with SSE streaming.
- RAG chat only at the expected production ratio.
- File uploads/embedding only if users are expected to upload during peak periods.
- History/search reads at the expected production ratio.
- Image generation or MCP/tool-heavy flows only if they are enabled and material in actual usage.

Deeper failure injection, malformed files, reconnect storms, direct DB pressure, and dependency chaos are phase-two tests. They are useful, but they should not block the first peak-load answer unless the team already considers them likely rollout risks.

| Area | Routes / Workload | Why |
|---|---|---|
| Baseline API | `/health`, `/api/config`, `/api/auth/*`, `/api/convos`, `/api/messages` | Proves auth, session, config, and history reads do not become the first bottleneck. |
| Native chat | `POST /api/agents/chat`, then `GET /api/agents/chat/stream/:streamId` | Main user path. Measures request burst handling, long-lived SSE, LLM latency, DB writes, abort/reconnect. |
| Remote agent APIs | `POST /api/agents/v1/chat/completions`, `POST /api/agents/v1/responses` | API-key clients may create different traffic than the browser UI. |
| RAG ingestion | `POST /api/files` with `tool_resource=file_search`, downstream `/embed` | Exercises upload size, local/shared storage, RAG API CPU, embeddings quota, pgvector inserts, file metadata consistency. |
| RAG runtime | Chat with file_search enabled, downstream `/query` per file | Current tool fans out one `/query` per file, so file count per agent/conversation is a multiplier. |
| Image generation | Chat prompt that invokes `image_gen_oai` | Stresses model quota, base64 artifact memory, image storage, and SSE attachment delivery. |
| Search/indexing | message/conversation writes plus `/api/search` and conversation search | Verifies MeiliSearch indexing/backlog and Mongo write pressure during active chat. |
| Failure modes | pod restart, Redis interruption, RAG 500/slow, AOAI 429, DB latency, user aborts | Confirms graceful degradation and no orphaned jobs/files/vectors. |

## Tooling Recommendation

Use two layers, not one overloaded test script.

1. k6 for deterministic HTTP load:
   - Good for open-loop RPS and ramp tests on auth, config, history, chat-start POSTs, file upload starts, search, and read/write endpoints.
   - Use `constant-arrival-rate` or `ramping-arrival-rate` to hold target request rates independent of response time.
   - Use thresholds for p95/p99, error rate, dropped iterations, and status checks.

2. A small Node/TypeScript or Locust runner for full chat lifecycles:
   - It should submit `POST /api/agents/chat`, capture `streamId`, open the SSE stream, measure time-to-first-event, final-event success, stream duration, reconnect, and abort.
   - This is better than pretending the POST alone represents a chat. The long-lived stream is part of the workload.
   - If the team strongly prefers one JS-based ecosystem, Artillery is a reasonable alternative for HTTP/multipart/distributed runs, with custom processor code for the SSE lifecycle.

Tool caveat: k6 officially supports HTTP/1.1, HTTP/2, WebSockets, and gRPC out of the box. It does not list SSE as a first-class protocol. Use it for HTTP pressure and use a custom SSE-aware runner for stream correctness.

This lines up with current tool best practice:

- Use an open-model generator for throughput tests. k6 `constant-arrival-rate` starts iterations at a fixed rate independent of system response, which is the right fit for finding API capacity and queueing behavior.
- Use thresholds as pass/fail gates, not only dashboards. The test should fail automatically when error rate, p95/p99, dropped iterations, or stream success are outside the agreed SLO.
- Do not force one tool to cover every protocol. k6 is strong for HTTP pressure, but the real chat lifecycle includes a long-lived SSE stream, so an SSE-aware runner is needed for correctness.
- Keep Artillery or Locust as alternatives when the team wants scenario logic in JS/TS or Python, especially for multipart uploads, custom lifecycles, or distributed user simulation.

## Test Phases

### 0. Readiness Audit

- Confirm actual production Helm values, not chart defaults.
- Run at least 2 API pods, Redis enabled, RAG API configured, explicit CPU/memory requests and limits, HPA enabled, and production-like ingress.
- Pin RAG image tags. Avoid `latest`.
- Confirm ingress/SSE settings: no proxy buffering on stream routes, long read/send timeouts, enough connection limits.
- Confirm shared storage or blob storage for uploads before scaling API pods.
- Confirm Azure OpenAI quotas for chat, embeddings, and image generation.

### 1. Smoke And Baseline

- 1 to 10 virtual users.
- Validate login/token handling, config load, chat start, SSE final event, file upload, RAG query, image generation, and cleanup.
- Establish baseline p50/p95/p99 before pushing load.

### 2. Average Load

- Model realistic production mix for 15,000 DAU.
- Suggested first mix until analytics are available:
  - 70% normal chat without RAG
  - 20% chat with pre-ingested RAG files
  - 5% file uploads/RAG ingestion
  - 3% conversation/history/search reads
  - 2% image generation or other tool-heavy flows
- Run 30 to 60 minutes. Increase in steps such as 50, 100, 250, 500 concurrent active users.

### 3. Stress And Breakpoint

- Increase load until one hard limit appears.
- Record which component fails first: API CPU/memory, SSE connection count, Redis ops/memory, Mongo latency/pool wait, RAG CPU, pgvector query/insert latency, Azure OpenAI 429, ingress timeout, or storage I/O.
- Stop before damaging shared lower environments.

### 4. Spike

- Jump from baseline to 2x or 3x expected peak within 1 to 5 minutes.
- Validate queueing behavior, HPA reaction time, 429 behavior, and user-visible errors.

### 5. Soak

- Run the expected peak mix for 1 to 2 hours in the first pass. Extend to 2 to 4 hours before final sign-off if memory growth, stream key growth, or indexing backlog is a concern.
- Watch memory growth, file descriptor growth, Redis stream key growth, Meili backlog, orphaned jobs, orphaned vectors, and slow DB query drift.

### 6. Optional Failure Injection

- Restart one API pod during active streams.
- Restart one RAG pod during ingestion.
- Inject Azure OpenAI 429 or use reduced quota.
- Add RAG API latency/500 responses.
- Temporarily interrupt Redis.
- Verify stream resume, abort cleanup, partial response saves, file metadata consistency, and no duplicate balance/transaction records.

## Metrics And Observability

ArgoCD pod health is not enough. It tells us whether Kubernetes objects are synced and pods are alive, not whether users are getting good answers quickly.

Minimum monitoring for the load test:

- API: request rate, status codes, p50/p95/p99 latency by route, active SSE streams, stream duration, time-to-first-event, final-event success, abort count, reconnect count, process CPU/memory, event loop lag, open file descriptors.
- LLM provider: Azure OpenAI request count, latency, TPM/RPM usage, 429s, 5xx, tokens per model, image generation latency.
- RAG API: `/embed` latency, `/query` latency, concurrent jobs, parsing time, chunk count, embedding request count, CPU/memory.
- pgvector/Postgres: query latency, insert latency, CPU, memory, IO, locks, index size/bloat, connection count.
- Cosmos Mongo API: p95/p99 query/write latency, throttling, connection pool usage, wait queue timeouts, duplicate-key errors, slow queries.
- Redis: ops/sec, memory, keys, stream lengths, pub/sub errors, reconnects, evictions, latency.
- MeiliSearch: task queue depth, indexing latency, search latency, memory/disk.
- Kubernetes/Ingress: HPA events, pod restarts, readiness/liveness failures, throttling, OOM kills, ingress 499/502/504, connection/read timeouts.
- Business/user: chat success rate, time to first token/event, time to final answer, upload-to-embedded time, user-visible error rate.

Recommended stack:

- If already available: Prometheus/Grafana for metrics, Loki or Azure Log Analytics for logs, Tempo/OpenTelemetry or Application Insights for traces.
- If not available yet: start with Azure Monitor Container Insights plus centralized logs, but add app metrics/tracing before final capacity sign-off.
- Add a load-test run id header to every synthetic request so traces/logs/metrics can be filtered per run.

Best-practice observability note:

- Argo CD exposes application sync and health metrics, but those describe deployment state. They do not replace route latency, stream health, provider quota, Redis stream, DB, RAG, and user-visible success metrics.
- Prometheus Operator `ServiceMonitor` or `PodMonitor` resources should scrape app and dependency metrics when Prometheus is used.
- OpenTelemetry now defines GenAI semantic conventions for model, agent, exception, metric, and MCP spans. Use those labels where practical so LLM and agent traces can be compared across providers and tools.
- Azure OpenAI monitoring should include prompt tokens, completion tokens, total inference tokens, model deployment dimensions, 429s, latency, and PTU or usage-tier utilization. Diagnostic settings should route metrics/logs into the chosen analytics workspace before the final test.

## Second-Pass Audit Addendum

The plan is not overcomplicated for execution, but it should be presented in two layers: a one-page decision brief for the first meeting, and this document as the implementation reference. Additional items to include before production sign-off:

- Test safety: define test windows, max virtual users, token budget, Azure OpenAI spend limit, kill switch, rollback contact, and whether tests may hit production-like shared dependencies.
- Provider quota behavior: validate both TPM and RPM for chat, embeddings, and image/image-tool paths. Azure notes that quota limits can change and recommends gradual load increases, varied load patterns, retry logic, and quota increases or PTU for latency-critical/high-volume workloads.
- LLM proxy/stub option: use a controlled mock or proxy for early API breakpoint tests so infrastructure limits can be found without burning real model quota. Run final validation against real Azure OpenAI quotas.
- Auth and edge scope: decide which tests include Cloudflare/Azure Firewall/Ingress/OIDC and which reuse pre-created tokens. The last pre-production run should include the real edge path.
- Rate limit intent: explicitly test `LIMIT_CONCURRENT_MESSAGES`, `CONCURRENT_MESSAGE_MAX`, message rate limits, and file upload limits. We need to know whether failures are expected throttling or real capacity issues.
- Synthetic data: seed synthetic users, conversations, files, vector collections, and agent configs. Do not use private production prompts/documents for load generation.
- File and parser boundaries: include representative document formats plus size-limit, malformed, and decompression-heavy cases. RAG ingestion can fail differently than normal chat.
- Agent/tool chains: if production agents use MCP, web tools, or remote actions, include tool latency, OAuth reconnect, downstream 429/500, and partial-tool-failure tests.
- Redis stream edge cases: test stream reconnect storms, high token rates, aborted jobs, Redis restart, and buffer/reorder behavior. Redis is mandatory for multi-pod stream correctness.
- Direct DB stress: keep API-level tests primary. Run direct DB pressure only after API tests show Mongo/Cosmos, Postgres/pgvector, MeiliSearch, or Redis is the likely bottleneck.
- Frontend/browser load: keep static/browser rendering out of the API stress-test MVP unless the goal expands to end-to-end user experience. A small browser smoke is enough for rollout confidence.
- Data consistency checks: after each run, query for orphaned files, missing vectors, stuck generation jobs, duplicate transactions, incomplete conversations, and Meili indexing backlog.

## Capacity Formulas

Use these during planning and after each run:

```text
peak_chat_rps =
  peak_active_users * messages_per_user_per_minute / 60

azure_openai_input_tpm =
  peak_chat_rps * avg_prompt_tokens * 60

azure_openai_output_tpm =
  peak_chat_rps * avg_completion_tokens * 60

rag_query_rps =
  peak_chat_rps * rag_chat_ratio * avg_file_search_calls_per_chat * avg_files_per_call

embedding_tpm =
  upload_docs_per_min * avg_chunks_per_doc * avg_chunk_tokens
  + rag_query_rps * avg_query_tokens * 60

sse_connections =
  peak_chat_rps * avg_stream_duration_seconds
```

## Initial Success Gates

These need team approval, but they are a sensible first bar:

- Chat start POST error rate below 1%.
- SSE final-event success above 99%.
- Time to first SSE event p95 under 5 seconds excluding provider cold/quota incidents.
- Full answer p95 within agreed model-dependent target.
- No unexplained 5xx spikes from API/RAG.
- Azure OpenAI 429s are either zero at target load or intentionally handled with a clear user-facing degradation path.
- Mongo, Redis, pgvector, and MeiliSearch stay below agreed CPU/memory/connection saturation.
- No pod OOM/restart loop during average, stress below breakpoint, or soak.
- RAG upload-to-embedded p95 within agreed document-size classes.
- Abort/reconnect flows do not leave duplicate/unfinished jobs beyond the expected partial-response behavior.

## Decisions Needed From The Team

- Expected peak concurrent active users, not only DAU.
- Expected messages per active user per minute.
- Average and p95 prompt/response token sizes.
- Percentage of chats using RAG, image generation, and other tools.
- Average files per RAG-enabled agent/conversation.
- Representative document sizes and formats.
- Whether tests hit real Azure OpenAI quotas or a controlled proxy/mock for early breakpoint tests.
- Production observability stack choice.
- Whether we accept Redis as mandatory for multi-pod production.
- Whether upload storage must move to shared object storage before scale testing.

## Reference Docs Checked

- k6 constant arrival rate: https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/
- k6 thresholds: https://grafana.com/docs/k6/latest/using-k6/thresholds/
- k6 supported protocols: https://grafana.com/docs/k6/latest/using-k6/protocols/
- Artillery HTTP engine: https://www.artillery.io/docs/reference/engines/http
- Locust documentation: https://docs.locust.io/en/stable/
- Kubernetes HPA: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
- Prometheus Operator ServiceMonitor/PodMonitor: https://prometheus-operator.dev/docs/developer/getting-started/
- Argo CD metrics: https://argo-cd.readthedocs.io/en/release-3.4/operator-manual/metrics/
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Azure OpenAI monitoring: https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/monitor-openai
- Azure OpenAI monitoring data reference: https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference
- Azure OpenAI quotas and limits: https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits

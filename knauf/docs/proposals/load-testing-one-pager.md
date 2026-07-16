# Agentic Karl Load Testing - One Page Briefing

Updated: 2026-07-15

## Objective

Find the production capacity, bottlenecks, and failure modes before rollout to 15,000+ daily users. The key risk is not raw DAU. It is peak concurrent chat sessions, long-lived SSE streams, Azure OpenAI TPM/RPM, RAG fan-out, and write pressure across Mongo/Cosmos, Redis, pgvector, MeiliSearch, and storage.

The first gate is dev-only. Ordinary KARL, memory, and titles use account-level Model Router; created agents and prompt drafting use direct GPT-5.6 Sol; RAG uses `text-embedding-3-large`; images use GPT Image 1. Do not promote prod configuration during this test cycle.

## System View

```text
Users
  |
  v
Ingress / Edge / OIDC
  |
  v
API pods
  |-- ordinary KARL -------------------> Model Router (Chat Completions)
  |-- agents/prompt drafting ----------> GPT-5.6 Sol (Responses)
  |-- image generation ----------------> GPT Image 1
  |-- GET  /api/agents/chat/stream/:id  SSE stream to browser
  |-- reads/writes --------------------> Cosmos Mongo API
  |-- streams/rate limits/sessions ----> Redis
  |-- file search ---------------------> RAG API /query -> pgvector
  |-- file upload ---------------------> RAG API /embed -> embeddings quota
  |-- search/indexing -----------------> MeiliSearch
  `-- files/images --------------------> shared storage
```

Clarification: API pods are identical replicas of the full backend API. We are not assigning routes to different pods. Kubernetes load-balances requests across full API pod replicas, while RAG API, Redis, MeiliSearch, databases, and storage are separate services.

## MVP Test Scope

For the first production-readiness run, keep the scope focused on actual expected peak usage. The goal is not to simulate every edge case. The goal is to prove the system can handle the real busiest hour and identify the first bottleneck.

1. Core chat lifecycle: start chat, open stream, measure first event, final event, DB saves, and user-visible errors.
2. RAG usage if it is common in production: chat with existing indexed files, plus a small upload/embedding percentage only if users really upload during peak hours.
3. Platform pressure created by real usage: API pods, ingress, Redis, Mongo/Cosmos, RAG API, pgvector, MeiliSearch, storage, and Azure OpenAI quotas.

Keep reconnect, abort storms, pod restarts, malformed documents, MCP/tool failures, and direct DB pressure as phase-two tests unless the team already knows those are high-probability production events.

## Recommended Approach

Use `k6` for deterministic HTTP pressure and thresholds. Use a Node/TS or Locust runner for the full SSE chat lifecycle because chat is not complete when the POST returns. Artillery is a reasonable alternative if the team wants one JS-based scenario framework.

Phase 0: readiness audit
- Confirm Azure persisted the exact OpenAI-only router pool: GPT-5.4 nano, GPT-5.4 mini, GPT-5.4, and GPT-5.5. Confirm 2+ API pods, Redis, resource limits, HPA, pinned images, shared storage, ingress/SSE timeouts, and separate router/Sol/embedding/image quotas.

Phase 1: smoke and baseline
- 1 to 10 virtual users, prove chat, stream final event, upload, RAG query, image/tool path, and cleanup.

Phase 2: expected load
- Run a realistic traffic mix for 30 to 60 minutes. Ramp active users through 5, 25, 50, 100, and 200 before going higher. Start with 70% normal chat, 20% RAG chat, 5% uploads, 3% history/search, and 2% image/tool-heavy flows until analytics replace assumptions.

Phase 3: stress and short soak
- Increase beyond expected peak until the first bottleneck appears, spike to 2x expected peak, and run a short 1 to 2 hour soak at expected peak.

Phase 4: optional resilience follow-up
- Restart pods, slow RAG, interrupt Redis, and simulate Azure OpenAI 429s only after the actual peak-load profile is understood.

Stop immediately if the router selects a model outside the approved pool. Also stop when final-stream success drops below 99%, 429s exceed 1%, 5xx exceeds 0.5%, p95 latency exceeds twice the baseline, or the agreed token budget is reached.

## What We Must Monitor

Argo CD health is not enough. It only tells us whether deployed resources are healthy and synced, not whether users receive answers quickly.

- User/API: route p95/p99, 4xx/5xx, active SSE streams, first-event latency, final-event success, stream duration, reconnects, aborts.
- LLM: Azure OpenAI TPM/RPM, prompt/completion tokens, 429s, model latency, image latency, PTU/usage-tier utilization.
- Data/RAG: Mongo/Cosmos latency and pool wait, Redis stream length and latency, RAG `/embed` and `/query`, pgvector query/insert latency, Meili task backlog.
- Kubernetes: HPA events, CPU/memory, throttling, pod restarts, OOM kills, ingress 499/502/504, connection/read timeouts.
- Consistency: orphaned jobs, orphaned files/vectors, duplicate transactions, incomplete conversations, indexing backlog.

## Decisions Needed

- Peak active concurrent users, messages per minute, average and p95 token sizes.
- RAG usage ratio, average files per chat, upload formats and sizes.
- Whether early breakpoint tests use real Azure OpenAI or a controlled LLM proxy.
- Observability stack: Prometheus/Grafana plus logs/traces, or Azure Monitor/Application Insights equivalent.
- Production requirement for Redis and shared storage before multi-pod scaling.
- Success gates: chat POST error rate, SSE final success, first-event p95, full-answer p95, max acceptable 429s, no pod OOM/restart loops, no data consistency defects.

## Best-Practice Alignment

- Open-model arrival-rate tests for throughput.
- Explicit thresholds as pass/fail gates.
- Separate SSE lifecycle validation from simple HTTP request pressure.
- App, dependency, provider, and user-visible metrics, not only Kubernetes or Argo CD health.
- Gradual provider load increase, quota monitoring, retry/backoff validation, and budget/kill-switch controls.

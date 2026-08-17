# Foundry Model Router latency

Use the Datadog dashboard **Agentic Karl Foundry Model Router — prod** to
separate provider wait from application work without inspecting prompt or
response content. The dashboard and its four draft monitors are managed by
`datadog-foundry-router.tf` in the production Agentic Karl Terraform root.

## Metrics

The application exposes these Prometheus instruments through the authenticated
`/metrics` endpoint. Datadog collects them under the `agentic_karl.foundry`
namespace.

| Prometheus metric                                | Datadog metric                                          | Meaning                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `knauf_foundry_model_call_duration_seconds`      | `agentic_karl.foundry.model_call.duration_seconds`      | End-to-end duration of one observable router call                                         |
| `knauf_foundry_model_call_ttft_seconds`          | `agentic_karl.foundry.model_call.ttft_seconds`          | Start to first non-empty streamed content token; absent when no content token is observed |
| `knauf_foundry_model_calls_total`                | `agentic_karl.foundry.model_calls.count`                | Observable calls by result, returned model, phase, and attempt bucket                     |
| `knauf_foundry_model_stream_idle_timeouts_total` | `agentic_karl.foundry.model_stream_idle_timeouts.count` | Existing stream watchdog expirations                                                      |

Metric labels are bounded:

- `result`: `success`, `provider_error`, `timeout`,
  `stream_idle_timeout`, `cancelled`, or `retry`
- `returned_model`: `gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`,
  `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `model-router`, `other`, or
  `unknown`
- `phase`: `primary`, `tool`, `summarization`, or `other`
- `attempt`: `1` when callback tags are available and no retry is present,
  `2+` when LangChain emits `retry:attempt:<n>`, LangGraph retries the same
  checkpoint namespace, or the application directly observes a replacement
  call, and `unknown` when callback evidence is unavailable

The histograms are Datadog distributions. Use percentile and model/phase
breakdowns to identify tail concentration; use the call counter for volume.

## Structured logs

Search production logs for `FoundryRouterTelemetry`.

`Model call completed` contains:

- request, conversation, message, and model-run correlation IDs
- result, returned model, phase, attempt bucket, duration, and optional TTFT
- optional input/output token counts
- optional bounded Azure request ID
- optional retry reason (`refusal`, `output_limit`, `langchain_retry`, or
  `langgraph_retry`)
- for provider errors only: optional bounded HTTP status, provider code, type,
  parameter, SDK exception class, and retryability

`Generation lifecycle completed` contains:

- request, conversation, message, and optional resumable-stream correlation IDs
- server generation duration and optional time to first model content
- observed parent-graph model-call count and aggregate model wait
- terminal generation result: `success`, `error`, or `cancelled`

`observedParentAggregateModelWaitMs` is the sum of observed parent-graph
physical call durations. It can exceed wall time if model calls overlap;
compare it with `durationMs`, not as a strict subtraction. The companion
`observedParentModelCallCount` and `modelTelemetryScope: parent_graph` make the
same boundary explicit. Subagent child graphs replace the parent callback chain
in the current Agents SDK, so their model calls are excluded rather than
reported with misleading timing.

No prompt, response, exception message, request or response body, filename,
signed URL, email, user identity, or arbitrary header is emitted. Provider
codes, types, parameters, exception classes, and request IDs are retained only
when they match bounded operational formats; unsafe or unbounded values are
dropped. Telemetry logs run inside an empty nested request context so the
shared Winston formatter cannot append tenant or user identity.

Conversation, message, model-run, stream, and provider request IDs are
pseudonymous operational correlation values. Keep them in structured logs
under the existing Datadog access and retention controls; never promote them to
Prometheus labels, dashboard group-by dimensions, or monitor tags.

The first model content time is the earliest non-empty callback token from any
observable model call. It is a correlation aid, not a guarantee that the token
was already rendered to the user; tool and summarization calls can emit first.

The generation lifecycle is not the browser loader interval. A resumable client
can disconnect and subscribe again without starting another model call. Each
`agentic_karl.sse.stream.duration_seconds` observation measures one SSE
connection, so reconnects can split one user-visible wait across multiple
observations. Use `streamId` to correlate the generation logs with
`librechat.sse.stream` traces, whose attributes include resume status, end
reason, first-chunk time, and final-event delivery.

## Telemetry compatibility contract

Dependency upgrades must not silently remove provider-error or retry
diagnostics. Tests for this telemetry must exercise the installed runtime
packages rather than only constructing plain objects with expected property
names:

- resolve OpenAI through the installed `@langchain/openai` package, construct a
  real SDK error, and verify status, code, type, parameter, exception class, and
  request ID survive the bounded summarizer without serializing the message or
  body
- resolve `@langchain/core` from the model stack, run a real retry, and verify
  its generated retry tag crosses the API callback-handler boundary and maps to
  attempt `2+`
- run a real LangGraph node with a retry policy and verify the stable
  `langgraph_checkpoint_ns` lineage maps the replacement model call to attempt
  `2+`

Do not pin an exact dependency version in these contract assertions.
Compatible upgrades should pass unchanged; a changed SDK error shape, package
resolution boundary, callback propagation rule, or retry-tag format must fail
CI and require an explicit telemetry adaptation.

Keep provider-specific diagnostics in structured logs. Prometheus metrics must
remain bounded to the documented result/model/phase/attempt labels; never add
provider codes, parameters, exception classes, request IDs, conversation IDs,
or message IDs as metric labels.

## Diagnosis workflow

1. Start with per-connection SSE p95, model-call p95, and generation stream
   subscriptions on the same dashboard interval.
2. If `type:resume` or `type:resume_state` activity rises, inspect
   `librechat.sse.stream` spans for `librechat.stream.resume:true`,
   `client_aborted`, `subscribe_failed`, and delayed final-event delivery. A
   reconnect can re-show or prolong the client loader without another model
   call.
3. Compare call duration with TTFT:
   - Both high: delay is primarily before the first token.
   - TTFT normal and duration high: inspect stream-idle timeouts and output
     tokens for a slow or stalled stream.
4. Group duration and volume by `returned_model` and `phase`.
5. Inspect `attempt:2+` and `result:retry` for LangChain, LangGraph, or
   refusal/output-limit retries. `attempt:unknown` must not be interpreted as a
   first attempt.
6. For `result:provider_error`, group only by the bounded provider status,
   code, type, parameter, retryability, and exception class fields. Correlate
   the provider request ID with Azure diagnostics; do not inspect or export raw
   exception content. A streamed `server_error` can legitimately have no HTTP
   status because the HTTP stream was already established; classify it as
   retryable from the bounded provider code/type.
7. Correlate a slow generation log by stream/request/message ID with its
   model-call logs and SSE spans. Multiple model-run IDs indicate multiple
   observable calls; multiple SSE spans alone indicate reconnects, not extra
   model work.
8. Compare application timing with Azure `TimeToResponse`, 429, and 5xx metrics.
   If Azure and application tails agree, treat the delay as provider-side.

## Azure support evidence

Provide only the UTC interval, deployment alias, returned backing model, safe
Azure request IDs, result classification, and aggregate metric slices. Do not
attach prompts, responses, user details, signed URLs, or raw application logs
that have not been reviewed for sensitive content.

The monitors remain drafts until a lower-environment scrape and production
traffic confirm metric names and at least 500 calls establish a useful
baseline. Publish thresholds only after that verification; this change does not
alter router candidates, policy, retries, fallback, or timeouts.

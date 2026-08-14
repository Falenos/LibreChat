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
- `returned_model`: approved router candidates, `model-router`, `other`, or
  `unknown`
- `phase`: `primary`, `tool`, `summarization`, or `other`
- `attempt`: `unknown` unless an application-controlled replacement call is
  directly observed, then `2+`

The histograms are Datadog distributions. Use percentile and model/phase
breakdowns to identify tail concentration; use the call counter for volume.

## Structured logs

Search production logs for `FoundryRouterTelemetry`.

`Model call completed` contains:

- request, conversation, message, and model-run correlation IDs
- result, returned model, phase, attempt bucket, duration, and optional TTFT
- optional input/output token counts
- optional bounded Azure request ID
- optional application retry reason (`refusal` or `output_limit`)

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

No prompt, response, filename, signed URL, email, or user identity is emitted.
Telemetry logs run inside an empty nested request context so the shared Winston
formatter cannot append tenant or user identity. The first model content time
is the earliest non-empty callback token from any observable model call. It is
a correlation aid, not a guarantee that the token was already rendered to the
user; tool and summarization calls can emit first.

The generation lifecycle is not the browser loader interval. A resumable client
can disconnect and subscribe again without starting another model call. Each
`agentic_karl.sse.stream.duration_seconds` observation measures one SSE
connection, so reconnects can split one user-visible wait across multiple
observations. Use `streamId` to correlate the generation logs with
`librechat.sse.stream` traces, whose attributes include resume status, end
reason, first-chunk time, and final-event delivery.

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
5. Inspect `attempt:2+` and `result:retry` for known refusal/output-limit
   replacements. `attempt:unknown` must not be interpreted as a first attempt;
   hidden SDK retries are intentionally not inferred.
6. Correlate a slow generation log by stream/request/message ID with its
   model-call logs and SSE spans. Multiple model-run IDs indicate multiple
   observable calls; multiple SSE spans alone indicate reconnects, not extra
   model work.
7. Compare application timing with Azure `TimeToResponse`, 429, and 5xx metrics.
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

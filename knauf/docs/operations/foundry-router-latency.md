# Foundry Model Router latency

Use the Datadog dashboard **Agentic Karl Foundry Model Router — prod** to
separate provider wait from application work without inspecting prompt or
response content. The dashboard and its four draft monitors are managed by
`datadog-foundry-router.tf` in the production Agentic Karl Terraform root.

## Metrics

The application exposes these Prometheus instruments through the authenticated
`/metrics` endpoint. Datadog collects them under the `agentic_karl.foundry`
namespace.

| Prometheus metric                                | Datadog metric                                          | Meaning                                                                           |
| ------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `knauf_foundry_model_call_duration_seconds`      | `agentic_karl.foundry.model_call.duration_seconds`      | End-to-end duration of one observable router call                                 |
| `knauf_foundry_model_call_ttft_seconds`          | `agentic_karl.foundry.model_call.ttft_seconds`          | Start to first streamed chunk; absent when the callback surface provides no chunk |
| `knauf_foundry_model_calls_total`                | `agentic_karl.foundry.model_calls.count`                | Observable calls by result, returned model, phase, and attempt bucket             |
| `knauf_foundry_model_stream_idle_timeouts_total` | `agentic_karl.foundry.model_stream_idle_timeouts.count` | Existing stream watchdog expirations                                              |

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

`Visible turn completed` contains:

- request, conversation, and message correlation IDs
- visible-turn duration and optional time to first model chunk
- completed model-call count and aggregate model wait
- terminal user-visible result: `success`, `error`, or `cancelled`

`aggregateModelWaitMs` is the sum of observed parent-graph physical call
durations. It can exceed wall time if model calls overlap; compare it with
`durationMs`, not as a strict subtraction. Subagent child graphs replace the
parent callback chain in the current Agents SDK, so their model calls are
excluded rather than reported with misleading timing.

No prompt, response, filename, signed URL, email, or user identity is emitted.
The first model chunk is the earliest callback token from any observable model
call. It is a correlation aid, not a guarantee that the chunk was already
rendered to the user; tool and summarization calls can emit first.

## Diagnosis workflow

1. Start with visible SSE p95 and model-call p95 on the same dashboard interval.
2. Compare call duration with TTFT:
   - Both high: delay is primarily before the first token.
   - TTFT normal and duration high: inspect stream-idle timeouts and output
     tokens for a slow or stalled stream.
3. Group duration and volume by `returned_model` and `phase`.
4. Inspect `attempt:2+` and `result:retry` for known refusal/output-limit
   replacements. `attempt:unknown` must not be interpreted as a first attempt;
   hidden SDK retries are intentionally not inferred.
5. Correlate a slow visible-turn log by request/message ID with its model-call
   logs. Multiple model-run IDs indicate multiple observable calls.
6. Compare application timing with Azure `TimeToResponse`, 429, and 5xx metrics.
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

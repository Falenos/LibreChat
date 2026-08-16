# Datadog OpenMetrics And Dashboards

Use this contract for Agentic Karl custom Prometheus metrics, Datadog
Autodiscovery annotations, Terraform dashboards, and metric monitors.

## Start With Existing Precedent

Before adding a new observability stack, inspect the current scheduler
implementation in:

- `agk-deployment-configs/scripts/validate-agentic-karl-scheduler-openmetrics.py`
- `agk-infrastructure/**/datadog-scheduler.tf`

The scheduler rollout exposed failures that Terraform validation alone did not:
legacy OpenMetrics options, incorrect counter matchers, missing percentile
configuration, unsupported dashboard tag keys, and unit-mismatched formulas.
Apply the complete contract below in the first PR series.

## Latest OpenMetrics Contract

Agentic Karl uses the Datadog OpenMetrics integration through
`openmetrics_endpoint`, which selects latest mode.

- Match Prometheus counters without the wire `_total` suffix. Datadog exposes
  the resulting metric with `.count`.
- Map histogram base names normally, then set both:
  - `histogram_buckets_as_distributions: true`
  - `collect_counters_with_distributions: true`
- Do not use `send_distribution_buckets`; it is a legacy-mode option and does
  not make latest-mode histogram percentiles queryable.
- Keep mappings identical across dev, stage, and prod unless the metric is
  intentionally environment-specific.
- Add a repository validation script that parses every environment annotation
  and rejects `_total` counter matchers, missing mappings, missing latest-mode
  options, and the legacy option.

## Percentile Configuration

Ingesting a histogram as a distribution is not enough to enable `p95` or other
percentile queries.

- Add one `datadog_metric_tag_configuration` per distribution metric.
- Set `metric_type = "distribution"` and `include_percentiles = true`.
- Preserve business labels while excluding histogram boundary tags:

  ```hcl
  tags              = ["lower_bound", "upper_bound"]
  exclude_tags_mode = true
  ```

- Datadog metric tag configurations are organization-wide. Assign exactly one
  Terraform state owner for each metric name; never duplicate the same resource
  between nonprod and prod roots.

## Dashboard And Query Safety

- Dashboard JSON tags in the AGK Datadog organization must use the accepted
  `team:*` and `ai:*` keys unless a live API check proves another key is
  accepted. Do not copy richer monitor/resource tag sets into dashboard tags.
- Terraform `validate` and planning do not prove that the Datadog API will
  accept dashboard tags or that a metric query returns data.
- Normalize units before formulas. Never compare nanocores with cores, bytes
  with mebibytes, milliseconds with seconds, or rates with counts.
- Use `.as_count()` for counter volume and rate math where required.
- Gate ratio alerts with meaningful event volume so low traffic does not create
  noisy percentages.
- Keep new monitors in draft until live metric names, tags, units, and
  percentile queries are confirmed.

## Structured Diagnostic Log Contract

For Agentic Karl Model Router latency, retry, provider-error, generation, and
SSE correlation, follow
[`knauf/docs/operations/foundry-router-latency.md`](../../../../knauf/docs/operations/foundry-router-latency.md).
Extend the existing Agentic Karl dashboard rather than creating a second
router-debugging dashboard.

- Metrics contain only bounded aggregate labels. Keep request, conversation,
  message, model-run, stream, and provider request IDs in structured logs.
- Never emit prompts, responses, exception messages, request/response bodies,
  identities, files, signed URLs, arbitrary headers, or secrets.
- Accept provider status, code, type, parameter, exception class, and request
  ID only through bounded allow-list validation; drop unsafe values instead of
  truncating content into a success-shaped diagnostic.
- Run telemetry logging inside an empty nested request context so shared logger
  enrichment cannot append tenant or user identity.
- Add compatibility tests against the packages resolved by the real model
  stack. A dependency bump that changes SDK error fields, package resolution,
  callback propagation, or retry tags must fail CI rather than silently reduce
  diagnostics.

## Delivery Sequence

1. Application emits bounded metrics and has lifecycle/concurrency tests.
2. GitOps maps counters and distributions using latest-mode settings and runs
   annotation validation in CI.
3. Terraform creates the organization-wide percentile configuration,
   dashboards, and draft monitors.
4. Deploy application and GitOps changes, then verify live Datadog series and
   query results.
5. Calibrate and publish monitors only after representative traffic exists.

Review all three repositories before merge. A green Terraform plan does not
replace live ingestion or Datadog API validation.

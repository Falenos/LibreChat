import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  execTotal: Counter<'lang' | 'outcome'>;
  execDuration: Histogram<'lang' | 'outcome'>;
  acaRequestDuration: Histogram<'op'>;
  wrapperParseFailures: Counter<string>;
  truncationRecoveries: Counter<string>;
  uploadBytes: Counter<string>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    execTotal: new Counter({
      name: 'code_adapter_exec_total',
      help: 'Executions by language and outcome',
      labelNames: ['lang', 'outcome'],
      registers: [registry],
    }),
    execDuration: new Histogram({
      name: 'code_adapter_exec_duration_seconds',
      help: 'End-to-end /exec latency',
      labelNames: ['lang', 'outcome'],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 220],
      registers: [registry],
    }),
    acaRequestDuration: new Histogram({
      name: 'code_adapter_aca_request_duration_seconds',
      help: 'ACA data-plane call latency',
      labelNames: ['op'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    wrapperParseFailures: new Counter({
      name: 'code_adapter_wrapper_parse_failures_total',
      help: 'Sentinel missing from pool stdout (wrapper degraded / API drift)',
      registers: [registry],
    }),
    truncationRecoveries: new Counter({
      name: 'code_adapter_truncation_recoveries_total',
      help: 'Full output fetched from /mnt/data logs after inline truncation',
      registers: [registry],
    }),
    uploadBytes: new Counter({
      name: 'code_adapter_upload_bytes_total',
      help: 'Bytes staged via /upload endpoints',
      registers: [registry],
    }),
  };
}

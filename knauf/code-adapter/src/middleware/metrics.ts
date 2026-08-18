import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  execTotal: Counter<'lang' | 'outcome'>;
  execDuration: Histogram<'lang' | 'outcome'>;
  acaRequestDuration: Histogram<'op'>;
  wrapperParseFailures: Counter<string>;
  truncationRecoveries: Counter<string>;
  uploadBytes: Counter<string>;
  tableOperationDuration: Histogram<'op' | 'outcome'>;
  tableConflicts: Counter<'op' | 'status'>;
  tableSchemaFailures: Counter<'entity' | 'reason'>;
  metadataReadiness: Counter<'outcome'>;
  cleanupRuns: Counter<'pass' | 'outcome'>;
  cleanupEntities: Counter<'pass' | 'outcome'>;
  cleanupDuration: Histogram<'pass' | 'outcome'>;
  cleanupLastSuccess: Gauge<'pass'>;
  metadataBackendInfo: Gauge<'backend' | 'table'>;
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
    tableOperationDuration: new Histogram({
      name: 'code_adapter_table_operation_duration_seconds',
      help: 'Table data-plane operation latency by bounded operation and outcome',
      labelNames: ['op', 'outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    tableConflicts: new Counter({
      name: 'code_adapter_table_conflicts_total',
      help: 'Table transaction conflicts and precondition failures',
      labelNames: ['op', 'status'],
      registers: [registry],
    }),
    tableSchemaFailures: new Counter({
      name: 'code_adapter_table_schema_failures_total',
      help: 'Rejected malformed or unknown Table entities',
      labelNames: ['entity', 'reason'],
      registers: [registry],
    }),
    metadataReadiness: new Counter({
      name: 'code_adapter_metadata_readiness_total',
      help: 'Metadata readiness checks by bounded outcome',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    cleanupRuns: new Counter({
      name: 'code_adapter_cleanup_runs_total',
      help: 'Blob-led and metadata reconciliation passes',
      labelNames: ['pass', 'outcome'],
      registers: [registry],
    }),
    cleanupEntities: new Counter({
      name: 'code_adapter_cleanup_entities_total',
      help: 'Cleanup entity outcomes',
      labelNames: ['pass', 'outcome'],
      registers: [registry],
    }),
    cleanupDuration: new Histogram({
      name: 'code_adapter_cleanup_duration_seconds',
      help: 'Cleanup pass duration',
      labelNames: ['pass', 'outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [registry],
    }),
    cleanupLastSuccess: new Gauge({
      name: 'code_adapter_cleanup_last_success_timestamp_seconds',
      help: 'Unix timestamp of the last successful cleanup pass',
      labelNames: ['pass'],
      registers: [registry],
    }),
    metadataBackendInfo: new Gauge({
      name: 'code_adapter_metadata_backend_info',
      help: 'Static metadata backend and table configuration',
      labelNames: ['backend', 'table'],
      registers: [registry],
    }),
  };
}

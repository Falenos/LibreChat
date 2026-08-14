import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Mongoose } from 'mongoose';

const PATH_NORMALIZATIONS: [RegExp, string][] = [
  [/^\/api\/agents\/chat\/stream\/[^/]+(?=\/|$)/, '/api/agents/chat/stream/#id'],
  [/^\/api\/agents\/chat\/status\/[^/]+(?=\/|$)/, '/api/agents/chat/status/#id'],
  [/^\/api\/files\/code\/download\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/code/download/#id/#id'],
  [/^\/api\/files\/download-url\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/download-url/#id/#id'],
  [/^\/api\/files\/download\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/download/#id/#id'],
  [/^\/api\/files\/[^/]+\/preview(?=\/|$)/, '/api/files/#id/preview'],
  [/^\/api\/skills\/[^/]+\/files(?:\/.*)?(?=\/|$)/, '/api/skills/#id/files'],
  [/^\/api\/messages\/artifact\/[^/]+(?=\/|$)/, '/api/messages/artifact/#id'],
  [/^\/api\/messages\/[^/]+\/[^/]+(?=\/|$)/, '/api/messages/#id/#id'],
  [/^\/api\/convos\/[^/]+\/messages\/[^/]+(?=\/|$)/, '/api/convos/#id/messages/#id'],
  [/^\/api\/messages\/[^/]+(?=\/|$)/, '/api/messages/#id'],
  [/^\/api\/convos\/[^/]+(?=\/|$)/, '/api/convos/#id'],
  [/^\/api\/files\/[^/]+(?=\/|$)/, '/api/files/#id'],
  [/^\/api\/agents\/[^/]+(?=\/|$)/, '/api/agents/#id'],
  [/^\/api\/assistants\/[^/]+(?=\/|$)/, '/api/assistants/#id'],
  [/^\/api\/share\/[^/]+(?=\/|$)/, '/api/share/#token'],
  [/^\/share\/[^/]+(?=\/|$)/, '/share/#id'],
  [/^\/api\/(tags|tools|runs|sessions)\/[0-9a-f]{24}(?=\/|$)/i, '/api/$1/#id'],
  [
    /^\/api\/(tools|sessions)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i,
    '/api/$1/#id',
  ],
];

const STATIC_PATHS = new Set([
  '/',
  '/health',
  '/metrics',
  '/api/auth/login',
  '/api/config',
  '/api/agents/chat/abort',
  '/api/agents/chat/active',
  '/api/agents/v1/chat/completions',
  '/api/agents/v1/responses',
  '/api/files',
  '/api/files/config',
  '/api/files/images',
  '/api/files/images/avatar',
  '/api/files/speech/stt',
]);

const UPLOAD_PATHS = new Set([
  '/api/files',
  '/api/files/images',
  '/api/files/images/avatar',
  '/api/files/speech/stt',
  '/api/skills/#id/files',
]);

const UPLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// [knauf] Keep probes and scrapes out of user-traffic metrics.
const OBSERVABILITY_PATHS = new Set(['/health', '/livez', '/readyz', '/metrics']);

export const isObservabilityPath = (rawPath: string): boolean =>
  OBSERVABILITY_PATHS.has(rawPath.split('?')[0]);
// End [knauf]

const LOW_CARDINALITY_PATHS: RegExp[] = [
  /^\/api\/agents\/chat\/stream\/#id$/,
  /^\/api\/agents\/chat\/status\/#id$/,
  /^\/api\/files\/#id\/preview$/,
  /^\/api\/files\/(code\/download|download-url|download)\/#id\/#id$/,
  /^\/api\/skills\/#id\/files$/,
  /^\/api\/messages\/#id$/,
  /^\/api\/messages\/#id\/#id$/,
  /^\/api\/messages\/artifact\/#id$/,
  /^\/api\/convos\/#id$/,
  /^\/api\/convos\/#id\/messages\/#id$/,
  /^\/api\/(files|agents|assistants|tags|tools|runs|sessions)\/#id$/,
  /^\/api\/share\/#token$/,
  /^\/share\/#id(?:\/edit)?$/,
];

const isLowCardinalityPath = (path: string): boolean =>
  STATIC_PATHS.has(path) || LOW_CARDINALITY_PATHS.some((pattern) => pattern.test(path));

const normalizeKnownPath = (path: string): string => {
  for (const [pattern, replacement] of PATH_NORMALIZATIONS) {
    if (pattern.test(path)) {
      return path.replace(pattern, replacement);
    }
  }

  return path;
};

const normalizeUnknownPath = (path: string): string => {
  if (STATIC_PATHS.has(path)) {
    return path;
  }

  if (path === '/api' || path.startsWith('/api/')) {
    return '/api/#path';
  }

  if (path === '/images' || path.startsWith('/images/')) {
    return '/images/#path';
  }

  if (path === '/avatars' || path.startsWith('/avatars/')) {
    return '/avatars/#path';
  }

  if (path === '/t' || path.startsWith('/t/')) {
    return '/t/#path';
  }

  return '/#path';
};

export const normalizePath = (rawPath: string): string => {
  const [pathWithoutQuery] = rawPath.split('?');
  const path = pathWithoutQuery.startsWith('/') ? pathWithoutQuery : `/${pathWithoutQuery}`;
  const normalized = normalizeKnownPath(path || '/');

  if (isLowCardinalityPath(normalized)) {
    return normalized;
  }

  return normalizeUnknownPath(path);
};

export interface PrometheusMetrics {
  metricsMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  metricsRouter: Router;
}

export type OpenIDUserLookupResult = 'found' | 'not_found' | 'migration' | 'auth_failed' | 'error';
export type GenerationJobStore = 'memory' | 'redis';
export type GenerationJobResult = 'created' | 'completed' | 'error' | 'aborted' | 'abort_failed';
export type GenerationStreamSubscriptionType = 'initial' | 'resume' | 'resume_state';
export type GenerationStreamSubscriptionResult =
  | 'success'
  | 'not_found'
  | 'error'
  | 'found'
  | 'missing';
export type RumProxyEndpoint = 'traces' | 'logs' | 'unknown';
export type RumProxyResult =
  | 'success'
  | 'auth_drop'
  | 'auth_error'
  | 'bad_request'
  | 'not_configured'
  | 'collector_4xx'
  | 'collector_5xx'
  | 'collector_error'
  | 'collector_timeout';

type OpenIDUserLookupMetrics = {
  recordLookup: (result: OpenIDUserLookupResult, durationSeconds: number) => void;
};

let openIDUserLookupMetrics: OpenIDUserLookupMetrics = {
  recordLookup: () => undefined,
};

export function recordOpenIDUserLookup(
  result: OpenIDUserLookupResult,
  durationSeconds: number,
): void {
  openIDUserLookupMetrics.recordLookup(result, durationSeconds);
}

type MongooseQueryMetrics = {
  recordQuery: (model: string, operation: string, status: string, durationSeconds: number) => void;
};

let mongooseQueryMetrics: MongooseQueryMetrics = {
  recordQuery: () => undefined,
};

type GenerationJobMetrics = {
  recordJob: (store: GenerationJobStore, result: GenerationJobResult) => void;
  setJobsInFlight: (store: GenerationJobStore, count: number) => void;
  recordSubscription: (
    store: GenerationJobStore,
    type: GenerationStreamSubscriptionType,
    result: GenerationStreamSubscriptionResult,
  ) => void;
  recordResumePendingEvents: (store: GenerationJobStore, count: number) => void;
};

let generationJobMetrics: GenerationJobMetrics = {
  recordJob: () => undefined,
  setJobsInFlight: () => undefined,
  recordSubscription: () => undefined,
  recordResumePendingEvents: () => undefined,
};

type RumProxyMetrics = {
  recordRequest: (endpoint: RumProxyEndpoint, result: RumProxyResult) => void;
};

let rumProxyMetrics: RumProxyMetrics = {
  recordRequest: () => undefined,
};

// [knauf] KK20-270 — bounded Azure Foundry Model Router call telemetry.
export type FoundryModelCallResult =
  | 'success'
  | 'provider_error'
  | 'timeout'
  | 'stream_idle_timeout'
  | 'cancelled'
  | 'retry';
export type FoundryModelCallPhase = 'primary' | 'tool' | 'summarization' | 'subagent' | 'other';
export type FoundryModelCallAttempt = '1' | '2+' | 'unknown';

export type FoundryModelCallMetric = {
  result: FoundryModelCallResult;
  returnedModel: string;
  phase: FoundryModelCallPhase;
  attempt: FoundryModelCallAttempt;
  durationSeconds: number;
  ttftSeconds?: number;
};

type FoundryModelCallMetrics = {
  recordCall: (metric: FoundryModelCallMetric) => void;
};

let foundryModelCallMetrics: FoundryModelCallMetrics = {
  recordCall: () => undefined,
};
// End [knauf]

// [knauf] KK20-195 WP0 — File Search indexing baseline metrics. Measures the RAG
// embed call (duration/outcome/provider throttles) so async-indexing SLOs and
// concurrency caps are set from data. Bounded tags only — route, outcome, status
// class — never file ids, user ids, filenames, or content hashes.
export type FileIndexEmbedRoute = 'embed' | 'agent_embed';
export type FileIndexEmbedOutcome = 'success' | 'failure' | 'timeout' | 'unsupported_type';
export type FileIndexProviderStatusClass = '429' | '5xx';

// KK20-195 review R11 — worker observability: claim outcomes + queue health.
// Bounded tags only (outcome); gauges carry no labels.
export type WorkerClaimOutcome =
  | 'ready'
  | 'requeued'
  | 'failed'
  | 'delete_requested'
  | 'ownership_lost'
  | 'activation_miss';

type FileIndexMetrics = {
  recordEmbed: (
    route: FileIndexEmbedRoute,
    outcome: FileIndexEmbedOutcome,
    durationSeconds: number,
  ) => void;
  recordProviderError: (route: FileIndexEmbedRoute, status: FileIndexProviderStatusClass) => void;
  recordEmbedRetry: (route: FileIndexEmbedRoute) => void;
  recordWorkerClaim: (outcome: WorkerClaimOutcome) => void;
  recordWorkerQueue: (queued: number, oldestAgeSeconds: number) => void;
};

let fileIndexMetrics: FileIndexMetrics = {
  recordEmbed: () => undefined,
  recordProviderError: () => undefined,
  recordEmbedRetry: () => undefined,
  recordWorkerClaim: () => undefined,
  recordWorkerQueue: () => undefined,
};
// End [knauf]

const resetMetricRecorders = (): void => {
  openIDUserLookupMetrics = {
    recordLookup: () => undefined,
  };
  mongooseQueryMetrics = {
    recordQuery: () => undefined,
  };
  generationJobMetrics = {
    recordJob: () => undefined,
    setJobsInFlight: () => undefined,
    recordSubscription: () => undefined,
    recordResumePendingEvents: () => undefined,
  };
  rumProxyMetrics = {
    recordRequest: () => undefined,
  };
  // [knauf] KK20-270 — reset Model Router recorders to no-ops.
  foundryModelCallMetrics = {
    recordCall: () => undefined,
  };
  // End [knauf]
  // [knauf] KK20-195 WP0 — reset file-index recorders to no-ops.
  fileIndexMetrics = {
    recordEmbed: () => undefined,
    recordProviderError: () => undefined,
    recordEmbedRetry: () => undefined,
    recordWorkerClaim: () => undefined,
    recordWorkerQueue: () => undefined,
  };
  // End [knauf]
};

export function recordGenerationJob(store: GenerationJobStore, result: GenerationJobResult): void {
  generationJobMetrics.recordJob(store, result);
}

export function setGenerationJobsInFlight(store: GenerationJobStore, count: number): void {
  generationJobMetrics.setJobsInFlight(store, count);
}

export function recordGenerationStreamSubscription(
  store: GenerationJobStore,
  type: GenerationStreamSubscriptionType,
  result: GenerationStreamSubscriptionResult,
): void {
  generationJobMetrics.recordSubscription(store, type, result);
}

export function recordGenerationStreamResumePendingEvents(
  store: GenerationJobStore,
  count: number,
): void {
  generationJobMetrics.recordResumePendingEvents(store, count);
}

export function recordRumProxyRequest(endpoint: RumProxyEndpoint, result: RumProxyResult): void {
  rumProxyMetrics.recordRequest(endpoint, result);
}

// [knauf] KK20-270 — public wrapper keeps API callers independent of prom-client.
export function recordFoundryModelCall(metric: FoundryModelCallMetric): void {
  foundryModelCallMetrics.recordCall(metric);
}
// End [knauf]

// [knauf] KK20-195 WP0 — public wrappers for the file-index recorders (no-ops
// until createMetrics() wires them; callers never touch prom-client directly).
export function recordFileIndexEmbed(
  route: FileIndexEmbedRoute,
  outcome: FileIndexEmbedOutcome,
  durationSeconds: number,
): void {
  fileIndexMetrics.recordEmbed(route, outcome, durationSeconds);
}

export function recordFileIndexProviderError(
  route: FileIndexEmbedRoute,
  status: FileIndexProviderStatusClass,
): void {
  fileIndexMetrics.recordProviderError(route, status);
}

export function recordFileIndexEmbedRetry(route: FileIndexEmbedRoute): void {
  fileIndexMetrics.recordEmbedRetry(route);
}

// KK20-195 review R11 — worker claim outcomes + queue depth/oldest age
// (recorded by the indexing worker's claim loop and queue sampler).
export function recordFileIndexWorkerClaim(outcome: WorkerClaimOutcome): void {
  fileIndexMetrics.recordWorkerClaim(outcome);
}

export function recordFileIndexWorkerQueue(queued: number, oldestAgeSeconds: number): void {
  fileIndexMetrics.recordWorkerQueue(queued, oldestAgeSeconds);
}
// End [knauf]

const getElapsedSeconds = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

export const isMetricsConfigured = (): boolean => Boolean(process.env.METRICS_SECRET);

const createUnauthorizedMetricsRouter = (): Router => {
  const metricsRouter = Router();
  metricsRouter.get('/', (_req, res) => {
    res.status(401).end();
  });
  return metricsRouter;
};

const normalizeMongooseLabel = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'unknown';
  return value.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 64) || 'unknown';
};

const getHeader = (headers: Record<string, unknown>, name: string): unknown => {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
};

const headerIncludes = (value: unknown, expected: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => headerIncludes(entry, expected));
  }
  return typeof value === 'string' && value.toLowerCase().includes(expected);
};

const isEventStreamContentType = (value: unknown): boolean =>
  headerIncludes(value, 'text/event-stream');

const isMultipartContentType = (value: unknown): boolean =>
  headerIncludes(value, 'multipart/form-data');

const getRequestContentLength = (req: Request): number | null => {
  const contentLength = req.headers['content-length'];
  const rawContentLength = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  const bodyBytes = rawContentLength == null ? NaN : Number(rawContentLength);
  return Number.isFinite(bodyBytes) && bodyBytes >= 0 ? bodyBytes : null;
};

const isUploadRequest = (req: Request, normalizedPath: string): boolean => {
  if (!UPLOAD_METHODS.has(req.method)) return false;
  if (isMultipartContentType(req.headers['content-type'])) return true;
  return UPLOAD_PATHS.has(normalizedPath);
};

export function recordMongooseQuery(
  model: string,
  operation: string,
  status: string,
  durationSeconds: number,
): void {
  mongooseQueryMetrics.recordQuery(
    normalizeMongooseLabel(model),
    normalizeMongooseLabel(operation),
    normalizeMongooseLabel(status),
    durationSeconds,
  );
}

export function instrumentMongooseQueryMetrics(mongoose: Mongoose): void {
  if (!isMetricsConfigured()) return;

  const instrumented = Symbol.for('librechat.mongooseQueryMetrics.instrumented');
  const queryPrototype = mongoose.Query?.prototype as
    | (typeof mongoose.Query.prototype & { [instrumented]?: boolean })
    | undefined;

  if (!queryPrototype || queryPrototype[instrumented]) return;

  const originalExec = queryPrototype.exec;
  queryPrototype.exec = function instrumentedExec(
    this: typeof queryPrototype & {
      model?: { modelName?: string };
      op?: string;
    },
    ...args: Parameters<typeof originalExec>
  ) {
    const startedAt = process.hrtime.bigint();
    const model = normalizeMongooseLabel(this.model?.modelName);
    const operation = normalizeMongooseLabel(this.op);

    let result: ReturnType<typeof originalExec>;
    try {
      result = originalExec.apply(this, args);
    } catch (error) {
      recordMongooseQuery(model, operation, 'error', getElapsedSeconds(startedAt));
      throw error;
    }

    return Promise.resolve(result).then(
      (result) => {
        recordMongooseQuery(model, operation, 'success', getElapsedSeconds(startedAt));
        return result;
      },
      (error) => {
        recordMongooseQuery(model, operation, 'error', getElapsedSeconds(startedAt));
        throw error;
      },
    );
  } as typeof originalExec;
  queryPrototype[instrumented] = true;
}

export function createMetrics(): PrometheusMetrics {
  if (!isMetricsConfigured()) {
    resetMetricRecorders();
    return {
      metricsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
      metricsRouter: createUnauthorizedMetricsRouter(),
    };
  }

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const httpRequestsInFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'HTTP requests currently being handled',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const httpRequestBodyBytes = new Histogram({
    name: 'http_request_body_bytes',
    help: 'HTTP request body size in bytes from the Content-Length header',
    labelNames: ['method', 'path'] as const,
    buckets: [1_000, 10_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000],
    registers: [registry],
  });

  const sseStreams = new Counter({
    name: 'sse_streams_total',
    help: 'Total SSE streams opened',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const sseStreamsInFlight = new Gauge({
    name: 'sse_streams_in_flight',
    help: 'SSE streams currently open',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const sseStreamDuration = new Histogram({
    name: 'sse_stream_duration_seconds',
    help: 'SSE stream open duration in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1_200, 1_800],
    registers: [registry],
  });

  const uploadRequests = new Counter({
    name: 'upload_requests_total',
    help: 'Total upload requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const uploadRequestsInFlight = new Gauge({
    name: 'upload_requests_in_flight',
    help: 'Upload requests currently being handled',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const uploadRequestDuration = new Histogram({
    name: 'upload_request_duration_seconds',
    help: 'Upload request duration in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.1, 0.3, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const uploadBytes = new Counter({
    name: 'upload_bytes_total',
    help: 'Upload request bytes from the Content-Length header',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const openIDUserLookupTotal = new Counter({
    name: 'openid_user_lookup_total',
    help: 'OpenID user lookup attempts',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const openIDUserLookupDuration = new Histogram({
    name: 'openid_user_lookup_duration_seconds',
    help: 'OpenID user lookup latency in seconds',
    labelNames: ['result'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  openIDUserLookupMetrics = {
    recordLookup: (result, durationSeconds) => {
      openIDUserLookupTotal.inc({ result });
      openIDUserLookupDuration.observe({ result }, durationSeconds);
    },
  };

  const mongooseQueries = new Counter({
    name: 'mongoose_queries_total',
    help: 'Mongoose queries by model, operation, and status',
    labelNames: ['model', 'operation', 'status'] as const,
    registers: [registry],
  });

  const mongooseQueryDuration = new Histogram({
    name: 'mongoose_query_duration_seconds',
    help: 'Mongoose query duration in seconds by model, operation, and status',
    labelNames: ['model', 'operation', 'status'] as const,
    buckets: [0.001, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  mongooseQueryMetrics = {
    recordQuery: (model, operation, status, durationSeconds) => {
      const labels = { model, operation, status };
      mongooseQueries.inc(labels);
      mongooseQueryDuration.observe(labels, durationSeconds);
    },
  };

  const generationJobs = new Counter({
    name: 'generation_jobs_total',
    help: 'Generation jobs by backing store and result',
    labelNames: ['store', 'result'] as const,
    registers: [registry],
  });

  const generationJobsInFlight = new Gauge({
    name: 'generation_jobs_in_flight',
    help: 'Generation jobs currently running in this process',
    labelNames: ['store'] as const,
    registers: [registry],
  });

  const generationStreamSubscriptions = new Counter({
    name: 'generation_stream_subscriptions_total',
    help: 'Generation stream subscription attempts by backing store, type, and result',
    labelNames: ['store', 'type', 'result'] as const,
    registers: [registry],
  });

  const generationStreamResumePendingEvents = new Counter({
    name: 'generation_stream_resume_pending_events_total',
    help: 'Pending events delivered while resuming generation streams',
    labelNames: ['store'] as const,
    registers: [registry],
  });

  const rumProxyRequests = new Counter({
    name: 'rum_proxy_requests_total',
    help: 'RUM proxy requests by endpoint and result',
    labelNames: ['endpoint', 'result'] as const,
    registers: [registry],
  });

  generationJobMetrics = {
    recordJob: (store, result) => generationJobs.inc({ store, result }),
    setJobsInFlight: (store, count) => generationJobsInFlight.set({ store }, count),
    recordSubscription: (store, type, result) =>
      generationStreamSubscriptions.inc({ store, type, result }),
    recordResumePendingEvents: (store, count) =>
      generationStreamResumePendingEvents.inc({ store }, count),
  };

  rumProxyMetrics = {
    recordRequest: (endpoint, result) => rumProxyRequests.inc({ endpoint, result }),
  };

  // [knauf] KK20-270 — four low-cardinality Model Router instruments.
  const foundryModelCallDuration = new Histogram({
    name: 'knauf_foundry_model_call_duration_seconds',
    help: 'Azure Foundry Model Router call duration',
    labelNames: ['result', 'returned_model', 'phase', 'attempt'] as const,
    buckets: [0.5, 1, 2, 5, 10, 15, 30, 45, 60, 90, 120, 180, 300],
    registers: [registry],
  });

  const foundryModelCallTtft = new Histogram({
    name: 'knauf_foundry_model_call_ttft_seconds',
    help: 'Azure Foundry Model Router time to first streamed chunk',
    labelNames: ['result', 'returned_model', 'phase', 'attempt'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45, 60, 90, 120],
    registers: [registry],
  });

  const foundryModelCalls = new Counter({
    name: 'knauf_foundry_model_calls_total',
    help: 'Azure Foundry Model Router calls',
    labelNames: ['result', 'returned_model', 'phase', 'attempt'] as const,
    registers: [registry],
  });

  const foundryModelStreamIdleTimeouts = new Counter({
    name: 'knauf_foundry_model_stream_idle_timeouts_total',
    help: 'Azure Foundry Model Router stream idle timeouts',
    registers: [registry],
  });

  foundryModelCallMetrics = {
    recordCall: ({ result, returnedModel, phase, attempt, durationSeconds, ttftSeconds }) => {
      const labels = { result, returned_model: returnedModel, phase, attempt };
      foundryModelCalls.inc(labels);
      foundryModelCallDuration.observe(labels, durationSeconds);
      if (ttftSeconds != null) {
        foundryModelCallTtft.observe(labels, ttftSeconds);
      }
      if (result === 'stream_idle_timeout') {
        foundryModelStreamIdleTimeouts.inc();
      }
    },
  };
  // End [knauf]

  // [knauf] KK20-195 WP0 — File Search indexing baseline metrics. Buckets span
  // text embeds (seconds) through OCR-heavy PDFs (observed valid job: 21.4 min).
  const fileIndexEmbedDuration = new Histogram({
    name: 'knauf_file_index_embed_duration_seconds',
    help: 'RAG embed call duration by route and outcome (KK20-195 WP0 baseline)',
    labelNames: ['route', 'outcome'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800],
    registers: [registry],
  });

  const fileIndexProviderErrors = new Counter({
    name: 'knauf_file_index_provider_errors_total',
    help: 'RAG embed provider throttles (429) and server errors (5xx) by route',
    labelNames: ['route', 'status'] as const,
    registers: [registry],
  });

  const fileIndexEmbedRetries = new Counter({
    name: 'knauf_file_index_embed_retries_total',
    help: 'RAG embed retry attempts scheduled by route',
    labelNames: ['route'] as const,
    registers: [registry],
  });

  // KK20-195 review R11 — worker observability set.
  const fileIndexWorkerClaims = new Counter({
    name: 'knauf_file_index_worker_claims_total',
    help: 'Indexing-worker claim outcomes',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  const fileIndexQueueDepth = new Gauge({
    name: 'knauf_file_index_queue_depth',
    help: 'Queued FileAsset backlog size (sampled periodically by the indexing worker)',
    registers: [registry],
  });
  const fileIndexQueueOldestAge = new Gauge({
    name: 'knauf_file_index_queue_oldest_age_seconds',
    help: 'Age of the oldest queued FileAsset (sampled periodically by the indexing worker)',
    registers: [registry],
  });

  fileIndexMetrics = {
    recordEmbed: (route, outcome, durationSeconds) =>
      fileIndexEmbedDuration.observe({ route, outcome }, durationSeconds),
    recordProviderError: (route, status) => fileIndexProviderErrors.inc({ route, status }),
    recordEmbedRetry: (route) => fileIndexEmbedRetries.inc({ route }),
    recordWorkerClaim: (outcome) => fileIndexWorkerClaims.inc({ outcome }),
    recordWorkerQueue: (queued, oldestAgeSeconds) => {
      fileIndexQueueDepth.set(queued);
      fileIndexQueueOldestAge.set(oldestAgeSeconds);
    },
  };
  // End [knauf]

  const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // [knauf] Probe/scrape volume is platform overhead, not application load.
    if (isObservabilityPath(req.path)) {
      next();
      return;
    }
    // End [knauf]

    const end = httpDuration.startTimer();
    const labels = { method: req.method, path: normalizePath(req.path) };
    const uploadTracked = isUploadRequest(req, labels.path);
    const uploadStartedAt = uploadTracked ? process.hrtime.bigint() : null;
    let sseTracked = false;
    let sseStartedAt: bigint | null = null;
    let completed = false;

    const markSSEStream = () => {
      if (completed || res.writableEnded || res.destroyed) return;
      if (sseTracked) return;
      sseTracked = true;
      sseStartedAt = process.hrtime.bigint();
      sseStreamsInFlight.inc(labels);
    };

    const originalSetHeader = res.setHeader;
    res.setHeader = function setHeader(this: Response, ...args: Parameters<Response['setHeader']>) {
      const [name, value] = args;
      const result = originalSetHeader.apply(this, args);
      if (String(name).toLowerCase() === 'content-type' && isEventStreamContentType(value)) {
        markSSEStream();
      }
      return result;
    } as Response['setHeader'];

    const originalWriteHead = res.writeHead;
    res.writeHead = function writeHead(this: Response, ...args: [number, unknown?, unknown?]) {
      const [, reasonPhrase, headers] = args;
      const responseHeaders =
        typeof reasonPhrase === 'object' && reasonPhrase != null ? reasonPhrase : headers;
      if (
        isEventStreamContentType(
          getHeader((responseHeaders ?? {}) as Record<string, unknown>, 'content-type'),
        ) ||
        isEventStreamContentType(res.getHeader('content-type'))
      ) {
        markSSEStream();
      }
      return originalWriteHead.apply(this, args as Parameters<typeof originalWriteHead>);
    } as Response['writeHead'];

    httpRequestsInFlight.inc(labels);
    if (uploadTracked) {
      uploadRequestsInFlight.inc(labels);
    }

    const complete = (completedBy: 'finish' | 'close') => {
      if (completed) return;
      completed = true;

      const requestLabels = { ...labels, status: completedBy === 'close' ? 499 : res.statusCode };
      httpRequests.inc(requestLabels);
      end(requestLabels);
      httpRequestsInFlight.dec(labels);

      const bodyBytes = getRequestContentLength(req);
      if (bodyBytes != null) {
        httpRequestBodyBytes.observe(labels, bodyBytes);
      }

      if (sseTracked) {
        sseStreams.inc(requestLabels);
        sseStreamsInFlight.dec(labels);
        if (sseStartedAt) {
          sseStreamDuration.observe(requestLabels, getElapsedSeconds(sseStartedAt));
        }
      }

      if (uploadTracked) {
        uploadRequests.inc(requestLabels);
        uploadRequestsInFlight.dec(labels);
        if (uploadStartedAt) {
          uploadRequestDuration.observe(requestLabels, getElapsedSeconds(uploadStartedAt));
        }
        if (bodyBytes != null) {
          uploadBytes.inc(labels, bodyBytes);
        }
      }
    };

    res.once('finish', () => complete('finish'));
    res.once('close', () => complete('close'));
    next();
  };

  const metricsRouter = Router();
  const metricsHandler: RequestHandler = (req, res): void => {
    const secret = process.env.METRICS_SECRET;
    const auth = req.headers['authorization'];
    if (!secret || !auth) {
      res.status(401).end();
      return;
    }
    const bearerToken = auth.match(/^bearer\s+(.+)$/i);
    if (!bearerToken) {
      res.status(401).end();
      return;
    }

    const token = bearerToken[1];
    const encode = (s: string) => new TextEncoder().encode(s);
    const expected = encode(secret);
    const actual = encode(token);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
      res.status(401).end();
      return;
    }

    void registry
      .metrics()
      .then((metrics) => {
        res.set('Content-Type', registry.contentType);
        res.end(metrics);
      })
      .catch((err) => {
        logger.error('[metrics] Failed to collect metrics:', err);
        res.status(500).end();
      });
  };

  metricsRouter.get('/', metricsHandler);

  return { metricsMiddleware, metricsRouter };
}

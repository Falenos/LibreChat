import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

const SERVICE_NAME = 'agentic-karl-code-adapter';
const tracer = trace.getTracer(SERVICE_NAME, process.env.ADAPTER_VERSION ?? 'unknown');
const OBSERVABILITY_PATHS = new Set(['/healthz', '/readyz', '/metrics']);
const STATIC_HTTP_ROUTES = new Set([
  ...OBSERVABILITY_PATHS,
  '/v1/health',
  '/v1/exec',
  '/v1/internal/canary',
  '/v1/exec/programmatic',
  '/v1/upload',
  '/v1/upload/batch',
]);

const DYNAMIC_HTTP_ROUTES = [
  {
    pattern: /^\/v1\/sessions\/[^/]+\/objects\/[^/]+$/,
    route: '/v1/sessions/:sessionId/objects/:fileId',
  },
  {
    pattern: /^\/v1\/download\/[^/]+\/[^/]+$/,
    route: '/v1/download/:sessionId/:fileId',
  },
  {
    pattern: /^\/v1\/files\/[^/]+\/[^/]+$/,
    route: '/v1/files/:sessionId/:fileId',
  },
];

export function normalizeHttpRoute(rawUrl: string | undefined): string {
  const path = (rawUrl ?? '/').split('?', 1)[0] || '/';
  return (
    DYNAMIC_HTTP_ROUTES.find(({ pattern }) => pattern.test(path))?.route ??
    (STATIC_HTTP_ROUTES.has(path) ? path : 'unmatched')
  );
}

/**
 * Adds one bounded server span when an injected OpenTelemetry-compatible provider has not
 * already instrumented Node HTTP. The global propagator owns W3C/Datadog header extraction;
 * no identity headers, query values, filenames, request bodies, or dynamic paths become tags.
 */
export function traceHttpRequest(req: Request, res: Response, next: NextFunction): void {
  const route = normalizeHttpRoute(req.originalUrl ?? req.url);
  if (OBSERVABILITY_PATHS.has(route)) {
    next();
    return;
  }
  const active = trace.getActiveSpan();
  if (active?.isRecording()) {
    enrichHttpSpan(active, req.method, route);
    next();
    return;
  }

  const parent = propagation.extract(context.active(), req.headers);
  tracer.startActiveSpan(
    `${req.method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'service.name': SERVICE_NAME,
        'http.request.method': req.method,
        'http.route': route,
      },
    },
    parent,
    (span) => {
      finishHttpSpan(span, req.method, route, res);
      next();
    },
  );
}

function finishHttpSpan(span: Span, method: string, route: string, res: Response): void {
  enrichHttpSpan(span, method, route);
  let ended = false;
  const end = () => {
    if (ended) {
      return;
    }
    ended = true;
    span.setAttribute('http.response.status_code', res.statusCode);
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  };
  res.once('finish', end);
  res.once('close', end);
}

function enrichHttpSpan(span: Span, method: string, route: string): void {
  span.updateName(`${method} ${route}`);
  span.setAttribute('http.route', route);
}

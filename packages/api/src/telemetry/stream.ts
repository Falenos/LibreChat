import { performance } from 'node:perf_hooks';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { logger } from '@librechat/data-schemas';
import type { Attributes, Span } from '@opentelemetry/api';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

const STREAM_SPAN_NAME = 'librechat.sse.stream';
const STREAM_ROUTE = '/api/agents/chat/stream/:streamId';

// [knauf] KK20-324/KK20-338 — distinguish who/what ended the SSE connection so
// duplicate 'client_aborted' cancellation events stop being lumped together.
// 'user_abort' is only reachable via recordUserAbort(), and 'system_abort' only via
// recordSystemAbort() — both called by route code once it observes an explicit abort
// on the underlying generation job (Stop button vs. system lifecycle cleanup,
// respectively; see GenerationJobManager.abortJob()'s `initiatedBy` option, threaded
// onto the abort final event as `initiatedBy` so the route can pick the right one).
// 'sse_disconnect' means the transport closed with no final/error event ever
// delivered and no known abort — i.e. AGK cannot itself tell whether the browser,
// the network, or an ingress/Azure layer closed it; distinguishing that requires
// joining `librechat.stream.generation_id` (the immutable per-turn owner token,
// also attached to GenerationJobManager's and Model Router telemetry's logs) with
// ingress/Azure logs — out of scope for this repo. `librechat.stream.correlation_id`,
// when present, is only the inbound x-request-id/x-correlation-id header of this SSE
// GET/reconnect request, not an Azure provider request ID.
type StreamEndReason =
  | 'done'
  | 'user_abort'
  | 'system_abort'
  | 'sse_disconnect'
  | 'server_error'
  | 'subscribe_failed';
// End [knauf]

export interface SseStreamTelemetry {
  recordHeadersFlushed: () => void;
  recordWrite: (payload: string, options?: { final?: boolean }) => void;
  recordFinalEventEmitted: () => void;
  recordErrorEventEmitted: () => void;
  recordSubscribeFailed: () => void;
  // [knauf] KK20-338 — see StreamEndReason above.
  recordUserAbort: () => void;
  recordSystemAbort: () => void;
  // End [knauf]
}

interface SseStreamTelemetryOptions {
  isResume: boolean;
  req: ServerRequest;
  res: Response;
  streamId: string;
  // [knauf] KK20-338 — optional; not every subscribe path resolves a generationId.
  generationId?: string;
  // End [knauf]
}

// [knauf] KK20-338 — reuse the same bounded-identifier shape as providerError.js so
// only short, non-PII correlation identifiers ever reach telemetry/logs.
const CORRELATION_ID_HEADERS = ['x-request-id', 'x-correlation-id'] as const;

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function getCorrelationId(req: ServerRequest): string | undefined {
  for (const header of CORRELATION_ID_HEADERS) {
    const raw = req.headers?.[header];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const id = boundedIdentifier(value);
    if (id) {
      return id;
    }
  }
  return undefined;
}
// End [knauf]

class SseStreamSpanTelemetry implements SseStreamTelemetry {
  private readonly span: Span;
  private readonly startTimeMs = performance.now();
  private readonly streamId: string;
  // [knauf] KK20-338 — carried through to the end-of-stream log for correlation.
  private readonly generationId: string | undefined;
  private readonly correlationId: string | undefined;
  private abortSignaledReason: 'user_abort' | 'system_abort' | undefined;
  // End [knauf]
  private bytesSent = 0;
  private chunksCount = 0;
  private ended = false;
  private errorEventEmitted = false;
  private finalEventEmitted = false;
  private finalEventWritten = false;
  private firstChunkMs: number | undefined;
  private plannedEndReason: StreamEndReason | undefined;

  constructor({ isResume, req, res, streamId, generationId }: SseStreamTelemetryOptions) {
    this.streamId = streamId;
    this.generationId = generationId;
    this.correlationId = getCorrelationId(req);

    this.span = trace.getTracer('librechat.telemetry').startSpan(
      STREAM_SPAN_NAME,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'http.request.method': req.method,
          'http.route': STREAM_ROUTE,
          'librechat.stream.id': streamId,
          'librechat.stream.resume': isResume,
          'librechat.stream.route': STREAM_ROUTE,
          // [knauf] KK20-324/KK20-338 — generation_id is the immutable per-turn owner
          // token: the primary join key across GenerationJobManager, Model Router
          // telemetry, and this SSE stream's terminal-cause log. correlation_id is
          // only the x-request-id/x-correlation-id header of *this* SSE GET/reconnect
          // request (set by an ingress/proxy in front of AGK, if any) — it is NOT
          // Azure's provider request ID and is not guaranteed to match the original
          // generation POST's request ID; treat it as a best-effort ingress-layer hint,
          // not a definitive Azure join key.
          ...(this.generationId != null && { 'librechat.stream.generation_id': this.generationId }),
          ...(this.correlationId != null && {
            'librechat.stream.correlation_id': this.correlationId,
          }),
          // End [knauf]
        },
      },
      context.active(),
    );

    res.once('finish', () => {
      this.end(this.plannedEndReason ?? (this.errorEventEmitted ? 'server_error' : 'done'));
    });

    res.once('close', () => {
      if (res.writableEnded) {
        this.end(this.plannedEndReason ?? (this.errorEventEmitted ? 'server_error' : 'done'));
        return;
      }

      // [knauf] KK20-338 — only classify as an abort when route code told us (via
      // recordUserAbort/recordSystemAbort) this connection is closing because the
      // underlying generation job was aborted. Otherwise the transport closed with
      // no terminal event ever delivered: a genuine, unattributed SSE disconnect.
      const reason: StreamEndReason = this.abortSignaledReason ?? 'sse_disconnect';
      this.span.addEvent(reason);
      this.end(reason);
      // End [knauf]
    });
  }

  recordHeadersFlushed(): void {
    this.span.addEvent('headers_flushed');
    this.span.setAttribute('librechat.stream.headers_flushed', true);
  }

  recordWrite(payload: string, options?: { final?: boolean }): void {
    if (this.ended) {
      return;
    }

    this.chunksCount += 1;
    this.bytesSent += Buffer.byteLength(payload);

    if (this.firstChunkMs === undefined) {
      this.firstChunkMs = performance.now() - this.startTimeMs;
      this.span.addEvent('first_chunk');
      this.span.setAttribute('librechat.stream.time_to_first_chunk_ms', this.firstChunkMs);
    }

    if (options?.final) {
      this.finalEventWritten = true;
      this.span.addEvent('final_event_written');
    }
  }

  recordFinalEventEmitted(): void {
    this.finalEventEmitted = true;
    // [knauf] KK20-338 — do not clobber a reason already staged by recordUserAbort()/
    // recordSystemAbort(). The route always calls one of those (when event.aborted)
    // *before* this method, then res.end(); res.end() emits 'finish', which reads
    // plannedEndReason. An unconditional assignment here previously overwrote
    // 'user_abort' with 'done', so every explicit Stop/system-abort was misreported
    // as a normal completion.
    this.plannedEndReason ??= 'done';
    // End [knauf]
    this.span.addEvent('final_event_emitted');
  }

  recordErrorEventEmitted(): void {
    this.errorEventEmitted = true;
    this.plannedEndReason ??= 'server_error';
    this.span.addEvent('error_event_emitted');
  }

  recordSubscribeFailed(): void {
    this.plannedEndReason = 'subscribe_failed';
    this.span.addEvent('subscribe_failed');
  }

  // [knauf] KK20-338 — see StreamEndReason/constructor comments. Stage the reason
  // immediately so it wins over the 'done' default even if recordFinalEventEmitted()
  // runs afterward on the same terminal write (route always calls this first).
  recordUserAbort(): void {
    this.abortSignaledReason = 'user_abort';
    this.plannedEndReason = 'user_abort';
  }

  recordSystemAbort(): void {
    this.abortSignaledReason = 'system_abort';
    this.plannedEndReason = 'system_abort';
  }
  // End [knauf]

  private end(reason: StreamEndReason): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    const attributes: Attributes = {
      'http.response.body.size': this.bytesSent,
      'librechat.stream.bytes.sent': this.bytesSent,
      'librechat.stream.chunks.count': this.chunksCount,
      'librechat.stream.completed': reason === 'done',
      'librechat.stream.duration_ms': performance.now() - this.startTimeMs,
      'librechat.stream.end_reason': reason,
      'librechat.stream.error_event_emitted': this.errorEventEmitted,
      'librechat.stream.final_event_emitted': this.finalEventEmitted,
      'librechat.stream.final_event_written': this.finalEventWritten,
    };

    if (this.firstChunkMs !== undefined) {
      attributes['librechat.stream.time_to_first_chunk_ms'] = this.firstChunkMs;
    }

    this.span.setAttributes(attributes);

    if (reason !== 'done') {
      this.span.setStatus({ code: SpanStatusCode.ERROR });
      this.span.setAttribute('error.type', reason);
    }

    this.span.end();

    // [knauf] KK20-324/KK20-338 — mirror the terminal reason as a structured log
    // line (not just an OTel span) so it's queryable in log-based dashboards too,
    // and joinable to Azure/ingress logs via correlation_id. Emitted exactly once
    // per SSE connection, guarded by the `ended` flag above.
    logger.info('[SseStreamTelemetry] SSE stream ended', {
      streamId: this.streamId,
      generationId: this.generationId,
      correlationId: this.correlationId,
      reason,
      durationMs: attributes['librechat.stream.duration_ms'],
      bytesSent: this.bytesSent,
      chunksCount: this.chunksCount,
    });
    // End [knauf]
  }
}

export function createSseStreamTelemetry(options: SseStreamTelemetryOptions): SseStreamTelemetry {
  return new SseStreamSpanTelemetry(options);
}

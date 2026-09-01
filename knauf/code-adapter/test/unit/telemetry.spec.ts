import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extract, getActiveSpan, span, startActiveSpan } = vi.hoisted(() => {
  const hoistedSpan = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
  };
  return {
    extract: vi.fn(() => ({ parent: true })),
    getActiveSpan: vi.fn(() => undefined),
    span: hoistedSpan,
    startActiveSpan: vi.fn((_name, _options, _parent, callback) => callback(hoistedSpan)),
  };
});

vi.mock('@opentelemetry/api', () => ({
  context: {
    active: vi.fn(() => ({ active: true })),
    with: vi.fn((_context, callback) => callback()),
  },
  propagation: { extract },
  SpanKind: { SERVER: 1 },
  SpanStatusCode: { ERROR: 2 },
  trace: {
    getActiveSpan,
    getTracer: vi.fn(() => ({ startActiveSpan })),
  },
}));

import { normalizeHttpRoute, traceHttpRequest } from '../../src/middleware/telemetry.js';

describe('HTTP trace propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues incoming context with bounded service/route attributes', () => {
    const req = {
      method: 'GET',
      originalUrl:
        '/v1/sessions/raw-session/objects/raw-object?kind=user&id=raw-user&token=secret',
      headers: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 404 });
    const next = vi.fn();

    traceHttpRequest(req as never, res as never, next);
    res.emit('finish');

    expect(extract).toHaveBeenCalledWith(expect.anything(), req.headers);
    expect(startActiveSpan).toHaveBeenCalledWith(
      'GET /v1/sessions/:sessionId/objects/:fileId',
      expect.objectContaining({
        attributes: {
          'service.name': 'agentic-karl-code-adapter',
          'http.request.method': 'GET',
          'http.route': '/v1/sessions/:sessionId/objects/:fileId',
        },
      }),
      expect.anything(),
      expect.any(Function),
    );
    expect(next).toHaveBeenCalledOnce();
    expect(span.setAttribute).toHaveBeenCalledWith('http.response.status_code', 404);
    expect(span.updateName).toHaveBeenCalledWith(
      'GET /v1/sessions/:sessionId/objects/:fileId',
    );
    expect(span.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(startActiveSpan.mock.calls)).not.toContain('raw-session');
    expect(JSON.stringify(startActiveSpan.mock.calls)).not.toContain('raw-object');
    expect(JSON.stringify(startActiveSpan.mock.calls)).not.toContain('raw-user');
    expect(JSON.stringify(startActiveSpan.mock.calls)).not.toContain('secret');
  });

  it('normalizes download routes and strips query values', () => {
    expect(normalizeHttpRoute('/v1/download/raw-session/raw-file?kind=user&id=raw-user')).toBe(
      '/v1/download/:sessionId/:fileId',
    );
    expect(normalizeHttpRoute('/v1/files/raw-session/raw-file?token=secret')).toBe(
      '/v1/files/:sessionId/:fileId',
    );
    expect(normalizeHttpRoute('/unknown/raw-session?token=secret')).toBe('unmatched');
  });

  it('enriches an existing native server span without creating a duplicate', () => {
    const existing = { ...span, isRecording: vi.fn(() => true) };
    getActiveSpan.mockReturnValueOnce(existing);
    const req = { method: 'POST', originalUrl: '/v1/exec', headers: {} };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = vi.fn();

    traceHttpRequest(req as never, res as never, next);
    res.emit('finish');

    expect(startActiveSpan).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(existing.updateName).toHaveBeenCalledWith('POST /v1/exec');
    expect(existing.end).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

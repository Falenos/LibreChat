// [knauf] Probe and scrape traffic exclusion regressions.
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { createMetrics, isObservabilityPath } from '../../app/metrics';
import { shouldIgnoreIncomingRequest } from '../../telemetry/sdk';

describe('observability traffic exclusions', () => {
  afterEach(() => delete process.env.METRICS_SECRET);

  it.each(['/health', '/livez', '/readyz', '/metrics'])(
    'excludes %s from metrics and traces',
    (path) => {
      expect(isObservabilityPath(`${path}?probe=1`)).toBe(true);
      expect(
        shouldIgnoreIncomingRequest({ url: `${path}?probe=1` } as IncomingMessage, '/health'),
      ).toBe(true);
    },
  );

  it('keeps real API traffic visible', () => {
    expect(isObservabilityPath('/api/files')).toBe(false);
    expect(shouldIgnoreIncomingRequest({ url: '/api/files' } as IncomingMessage, '/health')).toBe(
      false,
    );
  });

  it('does not attach metric completion handlers to platform traffic', () => {
    process.env.METRICS_SECRET = 'test-secret';
    const { metricsMiddleware } = createMetrics();
    const response = new EventEmitter();
    const next = jest.fn();

    metricsMiddleware(
      { method: 'GET', path: '/readyz' } as Request,
      response as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('finish')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });
});
// End [knauf]

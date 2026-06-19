import { rumBeforeSend, logsBeforeSend } from './beforeSend';
import type { RumEvent } from '@datadog/browser-rum';
import type { LogsEvent } from '@datadog/browser-logs';

function makeRumEvent(overrides: Partial<RumEvent> = {}): RumEvent {
  return {
    type: 'error',
    date: Date.now(),
    error: { message: '', source: 'source', type: 'Error', handling: 'unhandled' },
    view: { url: '', referrer: '' },
    ...overrides,
  } as unknown as RumEvent;
}

function makeLogEvent(message: string): LogsEvent {
  return { message } as unknown as LogsEvent;
}

describe('rumBeforeSend', () => {
  it('keeps normal error events', () => {
    const event = makeRumEvent({
      error: {
        message: 'Unexpected token',
        source: 'source',
        type: 'SyntaxError',
        handling: 'unhandled',
      },
    } as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(true);
  });

  it('drops aborted resource requests (status 0)', () => {
    const event = makeRumEvent({
      type: 'resource',
      resource: { status_code: 0, type: 'xhr', url: '/api/foo' },
    } as unknown as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(false);
  });

  it('keeps successful resource requests', () => {
    const event = makeRumEvent({
      type: 'resource',
      resource: { status_code: 200, type: 'xhr', url: '/api/foo' },
    } as unknown as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(true);
  });

  it('drops browser-extension "Object Not Found" errors', () => {
    const event = makeRumEvent({
      error: {
        message: 'Object Not Found Matching Id:2, MethodName:foo',
        source: 'source',
        type: 'Error',
        handling: 'unhandled',
      },
    } as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(false);
  });

  it('drops ResizeObserver errors', () => {
    const event = makeRumEvent({
      error: {
        message: 'ResizeObserver loop completed with undelivered notifications',
        source: 'source',
        type: 'Error',
        handling: 'unhandled',
      },
    } as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(false);
  });

  it('drops CSP report-type errors', () => {
    const event = makeRumEvent({
      error: { message: 'CSP violation', source: 'report', type: 'Error', handling: 'unhandled' },
    } as Partial<RumEvent>);
    expect(rumBeforeSend(event)).toBe(false);
  });
});

describe('logsBeforeSend', () => {
  it('keeps actionable error logs', () => {
    expect(logsBeforeSend(makeLogEvent('NetworkError: Failed to fetch'))).toBe(true);
    expect(logsBeforeSend(makeLogEvent('401 Unauthorized'))).toBe(true);
    expect(
      logsBeforeSend(makeLogEvent('Uncaught TypeError: Cannot read properties of undefined')),
    ).toBe(true);
  });

  it('drops Mermaid rendering noise', () => {
    expect(logsBeforeSend(makeLogEvent('Error rendering Mermaid diagram'))).toBe(false);
    expect(logsBeforeSend(makeLogEvent('mermaid parse error'))).toBe(false);
  });

  it('drops localStorage noise', () => {
    expect(logsBeforeSend(makeLogEvent('Failed to read localStorage'))).toBe(false);
    expect(logsBeforeSend(makeLogEvent('QuotaExceededError: localStorage full'))).toBe(false);
  });

  it('drops error boundary noise', () => {
    expect(logsBeforeSend(makeLogEvent('Error boundary caught rendering error'))).toBe(false);
  });

  it('drops BadgeRowContext noise', () => {
    expect(logsBeforeSend(makeLogEvent('BadgeRowContext: missing provider'))).toBe(false);
  });

  it('drops HEIC conversion noise', () => {
    expect(logsBeforeSend(makeLogEvent('Failed to convert HEIC image'))).toBe(false);
  });

  it('drops cleanupPreset noise', () => {
    expect(logsBeforeSend(makeLogEvent('cleanupPreset failed for preset xyz'))).toBe(false);
  });
});

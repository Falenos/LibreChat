const mockPost = jest.fn();

jest.mock('librechat-data-provider', () => ({
  request: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

import {
  getAnalyticsDiagnosticPagePath,
  getAnalyticsScriptDiagnostics,
  reportAnalyticsDiagnostic,
  sanitizeAnalyticsDiagnosticPayload,
} from './diagnostics';

describe('Knauf analytics diagnostics', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue(undefined);
  });

  it('redacts dynamic route ids before reporting diagnostics', () => {
    expect(getAnalyticsDiagnosticPagePath('/c/private-conversation-id')).toBe('/c/:conversationId');
    expect(getAnalyticsDiagnosticPagePath('/prompts/private-prompt-id')).toBe('/prompts/:promptId');
    expect(getAnalyticsDiagnosticPagePath('/agents/internal-category')).toBe('/agents/:category');
  });

  it('extracts low-cardinality script context without query strings', () => {
    expect(
      getAnalyticsScriptDiagnostics('https://assets.adobedtm.com/a/b/launch.js?token=x'),
    ).toEqual({
      scriptHost: 'assets.adobedtm.com',
      scriptPath: '/a/b/launch.js',
    });
  });

  it('sends sanitized diagnostic payloads through the authenticated request helper', async () => {
    reportAnalyticsDiagnostic({
      event: 'adobe_data_layer_push_failed',
      appName: 'knauf_agentic_karl',
      action: 'send_chat_message',
      component: 'chat_input',
      eventSpecification: 'send_chat_message',
      scriptHost: 'assets.adobedtm.com',
      scriptPath: '/a/b/launch.js?token=x',
      pagePath: '/c/private-conversation-id?prompt=secret',
      reason: 'x'.repeat(220),
    });
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledWith('/api/knauf/analytics/diagnostics', {
      event: 'adobe_data_layer_push_failed',
      appName: 'knauf_agentic_karl',
      action: 'send_chat_message',
      component: 'chat_input',
      eventSpecification: 'send_chat_message',
      scriptHost: 'assets.adobedtm.com',
      scriptPath: '/a/b/launch.js',
      pagePath: '/c/:conversationId',
      reason: 'x'.repeat(160),
    });
  });

  it('does not throw if reporting fails', () => {
    mockPost.mockRejectedValue(new Error('network unavailable'));

    expect(() => {
      reportAnalyticsDiagnostic({
        event: 'adobe_data_layer_push_failed',
        pagePath: '/c/new',
      });
    }).not.toThrow();
  });

  it('does not throw if the request helper fails synchronously', () => {
    mockPost.mockImplementation(() => {
      throw new Error('request setup failed');
    });

    expect(() => {
      reportAnalyticsDiagnostic({
        event: 'adobe_data_layer_push_failed',
        pagePath: '/c/new',
      });
    }).not.toThrow();
  });

  it('drops unknown optional fields during payload sanitization', () => {
    expect(
      sanitizeAnalyticsDiagnosticPayload({
        event: 'onetrust_script_load_failed',
        scriptId: 'knauf-onetrust-sdk',
        scriptUrl: 'https://example.test/should-not-be-sent.js',
      } as unknown as Parameters<typeof sanitizeAnalyticsDiagnosticPayload>[0]),
    ).toEqual({
      event: 'onetrust_script_load_failed',
      scriptId: 'knauf-onetrust-sdk',
    });
  });
});

// [knauf] KK20-194 — PR #98 security-review hardening for open_url.
//
// These tests mock the fetcher so the OpenUrl wrapper's decision layer can be
// exercised deterministically (the real fetcher behaviour is covered in
// OpenUrl.spec.js). They are the behavioural anchor for:
//   - R2a: an HTTP-success fetch with no readable content is surfaced as
//          { code: 'blocked_or_js_required' }, never an empty envelope.
//   - R3 :  an oversized page is surfaced with its informative notice, NOT as
//          blocked_or_js_required.
//   - R1 + Residual A: host-provenance + query-anomaly are LOGGED (never block)
//          when the fetched URL diverges from what the user pasted.

const mockFetchAndExtract = jest.fn();
class MockFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
jest.mock('../openUrl/fetcher', () => ({
  fetchAndExtract: (...args) => mockFetchAndExtract(...args),
  FetchError: MockFetchError,
}));

const { logger } = require('@librechat/data-schemas');
const OpenUrl = require('../OpenUrl');

function okResult(overrides = {}) {
  return {
    url: 'https://knauf.com/page',
    finalUrl: 'https://knauf.com/page',
    status: 200,
    contentType: 'text/html',
    title: 'Page',
    content: '<UNTRUSTED_WEB_CONTENT url="https://knauf.com/page">real readable content</UNTRUSTED_WEB_CONTENT>',
    truncated: false,
    outcome: 'ok',
    ...overrides,
  };
}

describe('[knauf] OpenUrl outcome mapping (R2a / R3)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('outcome="low" → blocked_or_js_required (no empty envelope to the model)', async () => {
    mockFetchAndExtract.mockResolvedValue(okResult({ outcome: 'low', content: 'wrapped-but-empty' }));
    const parsed = JSON.parse(await new OpenUrl()._call({ url: 'https://knauf.com/spa' }));
    expect(parsed.code).toBe('blocked_or_js_required');
    expect(parsed.url).toBe('https://knauf.com/spa');
    expect(parsed.content).toBeUndefined();
  });

  test('outcome="too_large" → notice is returned, NOT treated as blocked', async () => {
    mockFetchAndExtract.mockResolvedValue(
      okResult({
        outcome: 'too_large',
        content: '<UNTRUSTED_WEB_CONTENT url="x">[page too large to parse]</UNTRUSTED_WEB_CONTENT>',
      }),
    );
    const parsed = JSON.parse(await new OpenUrl()._call({ url: 'https://knauf.com/huge' }));
    expect(parsed.code).toBeUndefined();
    expect(parsed.content).toMatch(/\[page too large to parse\]/);
  });

  test('outcome="ok" → content passes through unchanged', async () => {
    mockFetchAndExtract.mockResolvedValue(okResult());
    const parsed = JSON.parse(await new OpenUrl()._call({ url: 'https://knauf.com/page' }));
    expect(parsed.content).toMatch(/real readable content/);
    expect(parsed.error).toBeUndefined();
  });
});

describe('[knauf] R1 + Residual A — host/query provenance logging (log-only)', () => {
  let warnSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAndExtract.mockResolvedValue(okResult());
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  function provenanceWarnings() {
    return warnSpy.mock.calls
      .map(([msg]) => msg)
      .filter((m) => /url_not_user_provided|query_param_not_user_provided/.test(m));
  }

  test('host the user never pasted → url_not_user_provided warning, but still fetches', async () => {
    const tool = new OpenUrl({ userProvidedUrls: ['https://knauf.com/legit'] });
    const parsed = JSON.parse(await tool._call({ url: 'https://evil.example/exfil' }));
    expect(provenanceWarnings().some((m) => m.includes('url_not_user_provided'))).toBe(true);
    expect(mockFetchAndExtract).toHaveBeenCalled(); // log-only, never blocks
    expect(parsed.content).toBeDefined();
  });

  test('query param absent from pasted URLs → query_param_not_user_provided warning', async () => {
    const tool = new OpenUrl({ userProvidedUrls: ['https://knauf.com/page'] });
    await tool._call({ url: 'https://knauf.com/page?secret=leaked' });
    const w = provenanceWarnings();
    expect(w.some((m) => m.includes('query_param_not_user_provided') && m.includes('secret'))).toBe(true);
  });

  test('exact pasted URL → no provenance warning', async () => {
    const tool = new OpenUrl({ userProvidedUrls: ['https://knauf.com/page?q=1'] });
    await tool._call({ url: 'https://knauf.com/page?q=1' });
    expect(provenanceWarnings()).toHaveLength(0);
  });

  test('no request context (no pasted URLs) → provenance check skipped', async () => {
    const tool = new OpenUrl();
    await tool._call({ url: 'https://anything.example/x' });
    expect(provenanceWarnings()).toHaveLength(0);
  });
});
// End [knauf]

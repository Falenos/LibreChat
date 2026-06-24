// [knauf] KK20-194 — unit tests for the open_url tool wrapper +
// fetchAndExtract + AGK SSRF deny-list. Pins the security-critical denials
// (spoke CIDRs, RFC1918, metadata, loopback, IPv6 LL/ULA) and the tool's
// JSON error-handling contract. fetch is mocked; no real network IO.

const OpenUrl = require('../OpenUrl');
const {
  fetchAndExtract,
  FetchError,
} = require('@knauf/knauf/server/openUrl');
const { isUrlAllowed, __test__: ssrfTest } = require('@knauf/knauf/server/ssrf');

describe('[knauf] open_url — SSRF deny-list', () => {
  test('spoke CIDR (dev 10.160.x) blocked at IPv4 literal', () => {
    expect(ssrfTest.isDeniedV4('10.160.0.7')).toBe(true);
    expect(ssrfTest.isDeniedV4('10.160.255.255')).toBe(true);
  });
  test('spoke CIDR (prod 10.161.x) blocked at IPv4 literal', () => {
    expect(ssrfTest.isDeniedV4('10.161.0.1')).toBe(true);
  });
  test('rfc1918 blocked', () => {
    expect(ssrfTest.isDeniedV4('192.168.1.1')).toBe(true);
    expect(ssrfTest.isDeniedV4('172.16.5.5')).toBe(true);
    expect(ssrfTest.isDeniedV4('10.0.0.1')).toBe(true);
  });
  test('loopback + AKS metadata blocked', () => {
    expect(ssrfTest.isDeniedV4('127.0.0.1')).toBe(true);
    expect(ssrfTest.isDeniedV4('169.254.169.254')).toBe(true);
  });
  test('public IPv4 allowed', () => {
    expect(ssrfTest.isDeniedV4('8.8.8.8')).toBe(false);
    expect(ssrfTest.isDeniedV4('1.1.1.1')).toBe(false);
  });
  test('IPv6 link-local + ULA + loopback blocked', () => {
    expect(ssrfTest.isDeniedV6('::1')).toBe(true);
    expect(ssrfTest.isDeniedV6('fe80::1')).toBe(true);
    expect(ssrfTest.isDeniedV6('fc00::1')).toBe(true);
    expect(ssrfTest.isDeniedV6('fd12::1')).toBe(true);
  });
  test('isUrlAllowed rejects non-http(s) schemes', async () => {
    expect((await isUrlAllowed('file:///etc/passwd')).reason).toBe('unsupported_scheme');
    expect((await isUrlAllowed('ftp://example.com/')).reason).toBe('unsupported_scheme');
    expect((await isUrlAllowed('javascript:alert(1)')).reason).toBe('unsupported_scheme');
  });
  test('isUrlAllowed rejects invalid URLs', async () => {
    expect((await isUrlAllowed('not a url')).reason).toBe('invalid_url');
  });
  test('isUrlAllowed rejects spoke + metadata IP literals without DNS', async () => {
    expect((await isUrlAllowed('http://10.160.0.7:10260/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://169.254.169.254/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://127.0.0.1/')).allowed).toBe(false);
  });
});

describe('[knauf] open_url — fetchAndExtract behaviour', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockHtmlResponse({
    body = '<html><head><title>Hello</title></head><body><article><h1>H</h1><p>Paragraph text body.</p></article></body></html>',
    contentType = 'text/html; charset=utf-8',
    status = 200,
    url = 'https://example.com/page',
  } = {}) {
    const encoded = new TextEncoder().encode(body);
    const headers = new Headers({ 'content-type': contentType });
    global.fetch = jest.fn(async () => new Response(encoded, { status, headers }));
    Object.defineProperty(global.fetch.mock.results, '_url', { value: url });
  }

  test('refuses http:// by default (https-only)', async () => {
    // Use a public IPv4 literal so SSRF allows it; the http: check fires after.
    await expect(fetchAndExtract('http://8.8.8.8/')).rejects.toMatchObject({
      code: 'http_not_allowed',
    });
  });

  test('blocks denied URL with ssrf_blocked code', async () => {
    await expect(fetchAndExtract('http://10.160.0.7:10260/')).rejects.toMatchObject({
      code: 'ssrf_blocked',
    });
  });

  test('extracts article body from HTML response', async () => {
    mockHtmlResponse();
    const out = await fetchAndExtract('https://8.8.8.8/page');
    expect(out.status).toBe(200);
    expect(out.contentType).toContain('text/html');
    expect(out.content).toMatch(/Paragraph text body/);
    expect(out.truncated).toBe(false);
  });

  test('respects maxLength + start_index for paging', async () => {
    const longBody =
      '<html><body><article>' + 'abcdefghij'.repeat(100) + '</article></body></html>';
    mockHtmlResponse({ body: longBody });
    const out = await fetchAndExtract('https://8.8.8.8/page', { maxLength: 50, startIndex: 10 });
    expect(out.content.length).toBe(50);
    expect(out.truncated).toBe(true);
  });

  test('returns non-text notice for binary content-types', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/pdf' }),
        }),
    );
    const out = await fetchAndExtract('https://8.8.8.8/file.pdf');
    expect(out.contentType).toContain('application/pdf');
    expect(out.content).toMatch(/non-text content/);
    expect(out.title).toBeNull();
  });

  test('aborts on 4xx with FetchError code', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response('not found', {
          status: 404,
          headers: new Headers({ 'content-type': 'text/plain' }),
        }),
    );
    await expect(fetchAndExtract('https://8.8.8.8/missing')).rejects.toMatchObject({
      code: 'http_404',
    });
  });

  test('enforces redirect cap', async () => {
    let count = 0;
    global.fetch = jest.fn(async () => {
      count += 1;
      return new Response('', {
        status: 302,
        headers: new Headers({ location: `https://8.8.8.8/step${count}` }),
      });
    });
    await expect(
      fetchAndExtract('https://8.8.8.8/start', { overrides: { maxRedirects: 2 } }),
    ).rejects.toMatchObject({ code: 'too_many_redirects' });
  });
});

describe('[knauf] OpenUrl — tool wrapper contract', () => {
  test('exposes schema with required url field', () => {
    const inst = new OpenUrl();
    expect(inst.name).toBe('open_url');
    expect(inst.schema.required).toEqual(['url']);
    expect(inst.schema.properties.url).toBeDefined();
    expect(inst.schema.properties.max_length).toBeDefined();
    expect(inst.schema.properties.start_index).toBeDefined();
  });

  test('returns JSON error when url argument is missing', async () => {
    const inst = new OpenUrl();
    const out = await inst._call({});
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/missing required "url"/);
  });

  test('serialises FetchError into JSON {error,code,url}', async () => {
    const inst = new OpenUrl();
    const out = await inst._call({ url: 'http://10.160.0.7:10260/' });
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('ssrf_blocked');
    expect(parsed.url).toBe('http://10.160.0.7:10260/');
  });

  test('rejects unsupported scheme', async () => {
    const inst = new OpenUrl();
    const parsed = JSON.parse(await inst._call({ url: 'file:///etc/passwd' }));
    expect(parsed.code).toBe('ssrf_blocked');
  });

  test('accepts a plain string input shape (LangChain Tool)', async () => {
    const inst = new OpenUrl();
    const parsed = JSON.parse(await inst._call('http://10.160.0.7/'));
    expect(parsed.code).toBe('ssrf_blocked');
  });
});

describe('[knauf] open_url — module surface', () => {
  test('exports FetchError class', () => {
    expect(FetchError).toBeDefined();
    expect(new FetchError('x', 'y')).toBeInstanceOf(Error);
  });
});
// End [knauf]

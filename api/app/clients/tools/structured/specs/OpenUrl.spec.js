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
  test('IPv4 broadcast + reserved ranges blocked', () => {
    expect(ssrfTest.isDeniedV4('255.255.255.255')).toBe(true);
    expect(ssrfTest.isDeniedV4('100.64.0.1')).toBe(true);
    expect(ssrfTest.isDeniedV4('0.0.0.0')).toBe(true);
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
  test('IPv4-mapped IPv6 (dotted) decoded + denied', () => {
    expect(ssrfTest.isDeniedV6('::ffff:127.0.0.1')).toBe(true);
    expect(ssrfTest.isDeniedV6('::ffff:10.160.0.7')).toBe(true);
    expect(ssrfTest.isDeniedV6('::ffff:169.254.169.254')).toBe(true);
  });
  test('IPv4-mapped IPv6 (compressed hex) decoded + denied (review fix)', () => {
    // WHATWG URL normalises ::ffff:127.0.0.1 to ::ffff:7f00:1 — the
    // original deny-list missed this form. These cases pin the fix.
    expect(ssrfTest.isDeniedV6('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(ssrfTest.isDeniedV6('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 (IMDS)
    expect(ssrfTest.isDeniedV6('::ffff:0aa0:7')).toBe(true); // 10.160.0.7 (dev spoke)
    expect(ssrfTest.isDeniedV6('::ffff:0aa1:1')).toBe(true); // 10.161.0.1 (prod spoke)
    expect(ssrfTest.isDeniedV6('0:0:0:0:0:ffff:7f00:1')).toBe(true);
  });
  test('NAT64 prefix 64:ff9b::/96 decodes + denied', () => {
    expect(ssrfTest.isDeniedV6('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(ssrfTest.isDeniedV6('64:ff9b::0aa0:7')).toBe(true);
  });
  test('IPv6 unspecified + multicast blocked', () => {
    expect(ssrfTest.isDeniedV6('::')).toBe(true);
    expect(ssrfTest.isDeniedV6('ff02::1')).toBe(true);
  });
  test('public IPv6 allowed', () => {
    expect(ssrfTest.isDeniedV6('2606:4700:4700::1111')).toBe(false);
    expect(ssrfTest.isDeniedV6('2001:4860:4860::8888')).toBe(false);
  });
  test('malformed IPv6 fails closed (treated as denied)', () => {
    expect(ssrfTest.isDeniedV6('not::an::ipv6')).toBe(true);
    expect(ssrfTest.isDeniedV6('::g')).toBe(true);
  });
  test('isUrlAllowed rejects non-http(s) schemes', async () => {
    expect((await isUrlAllowed('file:///etc/passwd')).reason).toBe('unsupported_scheme');
    expect((await isUrlAllowed('ftp://example.com/')).reason).toBe('unsupported_scheme');
    expect((await isUrlAllowed('javascript:alert(1)')).reason).toBe('unsupported_scheme');
  });
  test('isUrlAllowed rejects invalid URLs', async () => {
    expect((await isUrlAllowed('not a url')).reason).toBe('invalid_url');
  });
  test('isUrlAllowed rejects spoke + metadata IP literals (incl. mapped IPv6 hex)', async () => {
    expect((await isUrlAllowed('http://10.160.0.7:10260/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://169.254.169.254/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://127.0.0.1/')).allowed).toBe(false);
    // The original deny-list silently allowed these:
    expect((await isUrlAllowed('http://[::ffff:7f00:1]/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://[::ffff:a9fe:a9fe]/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://[::ffff:0aa0:7]/')).allowed).toBe(false);
  });
  test('isUrlAllowed strips userinfo before host check', async () => {
    expect((await isUrlAllowed('http://user:pass@10.160.0.7/')).allowed).toBe(false);
  });
  test('isUrlAllowed normalises IPv4 alternate literals via WHATWG URL', async () => {
    // 2130706433 == 127.0.0.1 ; 0x7f000001 == 127.0.0.1 ; 127.1 == 127.0.0.1
    expect((await isUrlAllowed('http://2130706433/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://0x7f000001/')).allowed).toBe(false);
    expect((await isUrlAllowed('http://127.1/')).allowed).toBe(false);
  });
  test('isUrlAllowed returns address+family+host on allow (for pinning)', async () => {
    const allowed = await isUrlAllowed('http://8.8.8.8/');
    expect(allowed.allowed).toBe(true);
    expect(allowed.address).toBe('8.8.8.8');
    expect(allowed.family).toBe(4);
    expect(allowed.host).toBe('8.8.8.8');
  });
});

describe('[knauf] open_url — fetchAndExtract behaviour', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetchImpl({
    body = '<html><head><title>Hello</title></head><body><article><h1>H</h1><p>Paragraph text body.</p></article></body></html>',
    contentType = 'text/html; charset=utf-8',
    status = 200,
    extraHeaders = {},
  } = {}) {
    const encoded = new TextEncoder().encode(body);
    const headers = new Headers({ 'content-type': contentType, ...extraHeaders });
    return jest.fn(async () => new Response(encoded, { status, headers }));
  }

  test('refuses http:// by default (https-only)', async () => {
    // Use a public IPv4 literal so SSRF allows it; the http: check fires after.
    await expect(
      fetchAndExtract('http://8.8.8.8/', { fetchImpl: mockFetchImpl() }),
    ).rejects.toMatchObject({ code: 'http_not_allowed' });
  });

  test('blocks denied URL with ssrf_blocked code', async () => {
    await expect(
      fetchAndExtract('http://10.160.0.7:10260/', { fetchImpl: mockFetchImpl() }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  test('blocks IPv4-mapped-IPv6 (compressed hex) spoke address', async () => {
    await expect(
      fetchAndExtract('http://[::ffff:0aa0:7]/', { fetchImpl: mockFetchImpl() }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  test('blocks IPv4-mapped-IPv6 (compressed hex) AKS metadata address', async () => {
    await expect(
      fetchAndExtract('http://[::ffff:a9fe:a9fe]/', { fetchImpl: mockFetchImpl() }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  test('extracts article body from HTML response', async () => {
    const out = await fetchAndExtract('https://8.8.8.8/page', { fetchImpl: mockFetchImpl() });
    expect(out.status).toBe(200);
    expect(out.contentType).toContain('text/html');
    expect(out.content).toMatch(/Paragraph text body/);
    expect(out.truncated).toBe(false);
  });

  test('passes a dispatcher to fetch (closes DNS rebinding window)', async () => {
    const impl = mockFetchImpl();
    await fetchAndExtract('https://8.8.8.8/page', { fetchImpl: impl });
    expect(impl).toHaveBeenCalled();
    const [, init] = impl.mock.calls[0];
    expect(init.dispatcher).toBeDefined();
    expect(typeof init.dispatcher.close).toBe('function');
  });

  test('respects maxLength + start_index for paging', async () => {
    const longBody =
      '<html><body><article>' + 'abcdefghij'.repeat(100) + '</article></body></html>';
    const out = await fetchAndExtract('https://8.8.8.8/page', {
      maxLength: 50,
      startIndex: 10,
      fetchImpl: mockFetchImpl({ body: longBody }),
    });
    expect(out.content.length).toBe(50);
    expect(out.truncated).toBe(true);
  });

  test('returns non-text notice for binary content-types', async () => {
    const impl = jest.fn(
      async () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/pdf' }),
        }),
    );
    const out = await fetchAndExtract('https://8.8.8.8/file.pdf', { fetchImpl: impl });
    expect(out.contentType).toContain('application/pdf');
    expect(out.content).toMatch(/non-text content/);
    expect(out.title).toBeNull();
  });

  test('aborts on 4xx with FetchError code', async () => {
    const impl = jest.fn(
      async () =>
        new Response('not found', {
          status: 404,
          headers: new Headers({ 'content-type': 'text/plain' }),
        }),
    );
    await expect(
      fetchAndExtract('https://8.8.8.8/missing', { fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'http_404' });
  });

  test('enforces redirect cap', async () => {
    let count = 0;
    const impl = jest.fn(async () => {
      count += 1;
      return new Response('', {
        status: 302,
        headers: new Headers({ location: `https://8.8.8.8/step${count}` }),
      });
    });
    await expect(
      fetchAndExtract('https://8.8.8.8/start', {
        overrides: { maxRedirects: 2 },
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  test('re-checks SSRF on every redirect (blocks redirect to private IP)', async () => {
    let hop = 0;
    const impl = jest.fn(async () => {
      hop += 1;
      if (hop === 1) {
        // First hop: 302 to a denied address.
        return new Response('', {
          status: 302,
          headers: new Headers({ location: 'http://10.160.0.7/' }),
        });
      }
      throw new Error('should not have been called after SSRF block');
    });
    await expect(
      fetchAndExtract('https://8.8.8.8/start', { fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(hop).toBe(1);
  });

  test('error message does NOT leak resolved IP or upstream detail', async () => {
    try {
      await fetchAndExtract('http://10.160.0.7:10260/', { fetchImpl: mockFetchImpl() });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err.code).toBe('ssrf_blocked');
      expect(err.message).toBe('URL blocked by SSRF policy');
      expect(err.message).not.toMatch(/10\.160\./);
    }
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

  test('serialises FetchError into JSON {error,code,url} without leaking detail', async () => {
    const inst = new OpenUrl();
    const out = await inst._call({ url: 'http://10.160.0.7:10260/' });
    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('ssrf_blocked');
    expect(parsed.url).toBe('http://10.160.0.7:10260/');
    expect(parsed).not.toHaveProperty('detail');
    // Never echo the resolved IP/internal host back into the model context.
    expect(parsed.error).not.toMatch(/10\.160\./);
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

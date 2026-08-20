import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcaClient } from '../../src/azure/acaClient.js';
import { ACA_FILE_MANIFEST_NAME, ACA_FILE_MANIFEST_TRUNCATED_NAME } from '../../src/types/aca.js';
import { testConfig, testLogger, testMetrics } from '../helpers/fakes.js';
import type { TokenProvider } from '../../src/azure/credential.js';

/**
 * Exercises the real ACA HTTP layer (via undici's MockAgent, not FakeAcaClient)
 * to pin the `code_adapter_aca_request_duration_seconds{op}` instrumentation
 * added for KK20-257. `fetchFileStream` is singled out because it is the one
 * op whose promise resolves at response headers while the actual transfer
 * — and any transfer-time error — happens later, as the caller (capture.ts)
 * drains the returned stream. Timing only the header round-trip would make
 * slow/stalled downloads and stream errors invisible to the histogram; these
 * tests assert the observation is deferred to the stream's terminal event.
 */
describe('acaClient aca_request_duration instrumentation', () => {
  let mockAgent: MockAgent;
  const config = testConfig();
  const tokens: TokenProvider = {
    getToken: async () => 'test-token',
    invalidate: () => undefined,
  };

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(() => {
    mockAgent.assertNoPendingInterceptors();
    setGlobalDispatcher(getGlobalDispatcher());
  });

  it('records a non-streaming op (listFiles) as soon as the call resolves', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(200, { value: [] });

    const metrics = testMetrics();
    const observeSpy = vi.spyOn(metrics.acaRequestDuration, 'observe');
    const client = createAcaClient(config, testLogger(), tokens, metrics);

    await client.listFiles('session-1');

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith({ op: 'listFiles' }, expect.any(Number));
  });

  it('defers fetchFileStream observation until the stream ends, not headers', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool
      .intercept({ method: 'GET', path: () => true })
      .reply(200, Buffer.from('hello from the sandbox'), {
        headers: { 'content-length': '23' },
      });

    const metrics = testMetrics();
    const observeSpy = vi.spyOn(metrics.acaRequestDuration, 'observe');
    const client = createAcaClient(config, testLogger(), tokens, metrics);

    const { stream } = await client.fetchFileStream('session-1', 'out.bin');

    // Headers have arrived (the promise resolved) but nothing has consumed the
    // body yet — the pre-fix behavior observed the metric right here, which is
    // exactly the "times headers, not the transfer" bug being pinned.
    expect(observeSpy).not.toHaveBeenCalled();

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello from the sandbox');

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith({ op: 'fetchFileStream' }, expect.any(Number));
  });

  it('still records fetchFileStream once when the stream is destroyed mid-transfer', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(200, Buffer.from('a'.repeat(1024)), {
      headers: { 'content-length': '1024' },
    });

    const metrics = testMetrics();
    const observeSpy = vi.spyOn(metrics.acaRequestDuration, 'observe');
    const client = createAcaClient(config, testLogger(), tokens, metrics);

    const { stream } = await client.fetchFileStream('session-1', 'big.bin');
    expect(observeSpy).not.toHaveBeenCalled();

    // Mirrors capture.ts's overflow/timeout paths: the consumer destroys the
    // stream without draining it, rather than the body ending naturally.
    // Swallowing 'error' here mirrors capture.ts's own `source.stream.once('error', ...)`
    // guard — an unhandled 'error' event on a destroyed stream crashes the process.
    stream.on('error', () => undefined);
    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith({ op: 'fetchFileStream' }, expect.any(Number));
  });

  it('records fetchFileStream immediately when the header round-trip itself fails', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(500, 'boom');

    const metrics = testMetrics();
    const observeSpy = vi.spyOn(metrics.acaRequestDuration, 'observe');
    const client = createAcaClient(config, testLogger(), tokens, metrics);

    await expect(client.fetchFileStream('session-1', 'missing.bin')).rejects.toThrow();

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith({ op: 'fetchFileStream' }, expect.any(Number));
  });

  it('uses the wrapper manifest to expose nested files instead of top-level directories', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(200, {
      value: [
        { properties: { filename: ACA_FILE_MANIFEST_NAME, size: 120 } },
        { properties: { filename: 'reports', size: 4096 } },
      ],
    });
    pool.intercept({ method: 'GET', path: () => true }).reply(
      200,
      JSON.stringify({
        version: 1,
        truncated: false,
        files: [
          {
            name: 'reports/out.csv',
            type: 'File',
            sizeInBytes: 8,
            lastModifiedAt: '1787070000000000000',
          },
        ],
      }),
    );

    const client = createAcaClient(config, testLogger(), tokens, testMetrics());

    await expect(client.listFiles('session-1')).resolves.toEqual([
      {
        name: 'reports/out.csv',
        type: 'File',
        contentType: null,
        sizeInBytes: 8,
        lastModifiedAt: '1787070000000000000',
      },
    ]);
  });

  it('returns bounded manifest files plus a truncation marker', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(200, {
      value: [{ properties: { filename: ACA_FILE_MANIFEST_NAME, size: 80 } }],
    });
    pool.intercept({ method: 'GET', path: () => true }).reply(
      200,
      JSON.stringify({
        version: 1,
        truncated: true,
        files: [
          {
            name: 'partial.csv',
            type: 'File',
            sizeInBytes: 3,
            lastModifiedAt: '1787070000000000000',
          },
        ],
      }),
    );

    const client = createAcaClient(config, testLogger(), tokens, testMetrics());

    await expect(client.listFiles('session-1')).resolves.toEqual([
      {
        name: 'partial.csv',
        type: 'File',
        contentType: null,
        sizeInBytes: 3,
        lastModifiedAt: '1787070000000000000',
      },
      {
        name: ACA_FILE_MANIFEST_TRUNCATED_NAME,
        type: 'File',
        contentType: null,
        sizeInBytes: 0,
        lastModifiedAt: '',
      },
    ]);
  });

  it('rejects malformed manifest entries from the sandbox', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool.intercept({ method: 'GET', path: () => true }).reply(200, {
      value: [{ properties: { filename: ACA_FILE_MANIFEST_NAME, size: 80 } }],
    });
    pool
      .intercept({ method: 'GET', path: () => true })
      .reply(200, JSON.stringify({ version: 1, truncated: false, files: [42] }));

    const client = createAcaClient(config, testLogger(), tokens, testMetrics());

    await expect(client.listFiles('session-1')).rejects.toThrow(/invalid file manifest entry/);
  });

  it('deletes stateless sessions with the lifecycle API and treats 404 as idempotent success', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool
      .intercept({
        method: 'DELETE',
        path: (path) =>
          path.includes('/session?') &&
          path.includes(`api-version=${config.aca.sessionApiVersion}`) &&
          path.includes('identifier=session-1'),
      })
      .reply(404, '');

    const metrics = testMetrics();
    const observeSpy = vi.spyOn(metrics.acaRequestDuration, 'observe');
    const client = createAcaClient(config, testLogger(), tokens, metrics);

    await expect(client.deleteSession('session-1')).resolves.toBeUndefined();
    expect(observeSpy).toHaveBeenCalledWith({ op: 'deleteSession' }, expect.any(Number));
  });

  it('checks readiness through a non-allocating reserved-session lookup', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool
      .intercept({
        method: 'GET',
        path: (path) =>
          path.includes('/session?') &&
          path.includes(`api-version=${config.aca.sessionApiVersion}`) &&
          path.includes('identifier=karl-readiness-probe'),
      })
      .reply(404, '');
    const client = createAcaClient(config, testLogger(), tokens, testMetrics());

    await expect(client.checkReadiness()).resolves.toBeUndefined();
  });

  it('preserves a real undici abort as a request deadline instead of wrapping it as 502', async () => {
    const pool = mockAgent.get(config.aca.poolEndpoint);
    pool
      .intercept({ method: 'POST', path: (path) => path.includes('/code/execute?') })
      .reply(200, { properties: { status: 'Success', stdout: '', stderr: '' } })
      .delay(100);
    const client = createAcaClient(config, testLogger(), tokens, testMetrics());
    const controller = new AbortController();
    const pending = client.execute('session-1', 'print(1)', controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

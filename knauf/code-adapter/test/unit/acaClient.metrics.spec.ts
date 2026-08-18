import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcaClient } from '../../src/azure/acaClient.js';
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
});

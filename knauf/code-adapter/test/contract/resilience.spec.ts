import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { importCodeApiKey } from '../../src/auth/verifyJwt.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import type { Express } from 'express';
import type { BlobStore } from '../../src/azure/blobStore.js';

/**
 * [knauf] KK20-257 review — the three ways this process could be killed, or lie about
 * being healthy, by something outside its control.
 *
 * All three were live before this suite: a Blob read that fails mid-transfer, a Mongo
 * hiccup during the TTL bump, and a verification key that only gets parsed on the first
 * request. None of them is a caller error, and none of them may take the pod down or
 * turn it into a healthy-looking 401 machine.
 */

/**
 * Capture process-level faults instead of letting them terminate the run.
 *
 * Installing these listeners is also what makes the assertion meaningful: Node's default
 * for both is to throw, so without a listener the buggy version of the code kills the
 * test process rather than failing an expectation. With one, the fault is observable —
 * empty means the request path handled it, non-empty means it escaped.
 */
function watchProcessFaults() {
  const escaped: unknown[] = [];
  const onFault = (err: unknown) => {
    escaped.push(err);
  };
  process.on('uncaughtException', onFault);
  process.on('unhandledRejection', onFault);
  return {
    escaped,
    stop: () => {
      process.off('uncaughtException', onFault);
      process.off('unhandledRejection', onFault);
    },
  };
}

/** A blob whose stream delivers some bytes and then fails, as a reset connection does. */
function blobStoreThatFailsMidStream(base: FakeBlobStore, failAfter: Buffer): BlobStore {
  return {
    ...base,
    put: base.put.bind(base),
    getBuffer: base.getBuffer.bind(base),
    delete: base.delete.bind(base),
    async getStream() {
      const stream = new Readable({
        read() {
          this.push(failAfter);
          this.destroy(new Error('socket hang up'));
        },
      });
      return { stream, contentLength: undefined };
    },
  };
}

describe('[knauf] a failing dependency must not kill the process', () => {
  let faults: ReturnType<typeof watchProcessFaults>;

  beforeEach(() => {
    faults = watchProcessFaults();
  });

  afterEach(() => {
    faults.stop();
  });

  const build = (overrides: { blob?: BlobStore; repo?: FakeFilesRepo }) => {
    const repo = overrides.repo ?? new FakeFilesRepo();
    const blob = overrides.blob ?? new FakeBlobStore();
    const app = createApp({
      config: testConfig(),
      logger: testLogger(),
      aca: new FakeAcaClient(),
      blob,
      repo: repo.asRepo(),
      mongo: { db: { command: async () => ({ ok: 1 }) } } as never,
      metrics: testMetrics(),
    });
    return { app, repo, blob };
  };

  const stageOne = async (app: Express) =>
    request(app)
      .post('/v1/upload')
      .field('kind', 'user')
      .field('id', 'user-1')
      .attach('file', Buffer.from('a,b\n1,2\n'), 'data.csv');

  it('survives a blob stream that fails mid-download', async () => {
    // Stage through the real store so the Mongo row and blob exist, then swap in a store
    // whose stream dies partway — `stream.pipe(res)` forwards no source error, so the
    // unhandled `error` event used to be an uncaught exception and a pod restart.
    const backing = new FakeBlobStore();
    const { app: stagingApp, repo } = build({ blob: backing });
    const upload = await stageOne(stagingApp);
    expect(upload.status).toBe(200);

    const { app } = build({
      repo,
      blob: blobStoreThatFailsMidStream(backing, Buffer.from('a,b\n')),
    });

    // The transfer itself must fail — headers are already out, so there is no clean
    // status left to send and the socket is torn down deliberately.
    await expect(
      request(app)
        .get(`/v1/download/${upload.body.storage_session_id}/${upload.body.files[0].fileId}`)
        .query({ kind: 'user', id: 'user-1' }),
    ).rejects.toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    expect(faults.escaped, 'a mid-stream blob failure escaped the request handler').toEqual([]);
  });

  it('serves the download even when the TTL bump fails', async () => {
    const { app, repo } = build({});
    const upload = await stageOne(app);
    expect(upload.status).toBe(200);

    // The TTL bump is best-effort bookkeeping that runs after the bytes are delivered.
    // Left floating (`void repo.touch(...)`) its rejection is an unhandled rejection,
    // which terminates the process on Node >= 15.
    repo.touch = async () => {
      throw new Error('Mongo topology closed');
    };

    const response = await request(app)
      .get(`/v1/download/${upload.body.storage_session_id}/${upload.body.files[0].fileId}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(response.status).toBe(200);
    // The whole body still arrives — the failure is confined to the bookkeeping after it.
    expect(response.text).toBe('a,b\n1,2\n');

    await new Promise((resolve) => setImmediate(resolve));
    expect(faults.escaped, 'a failed TTL bump escaped the request handler').toEqual([]);
  });
});

describe('[knauf] the verification key is parsed at boot, not on first request', () => {
  const PLACEHOLDER = [
    '-----BEGIN PUBLIC KEY-----',
    'REPLACE_WITH_lc-codeapi-dev.pub',
    '-----END PUBLIC KEY-----',
  ].join('\n');

  it('rejects the GitOps placeholder rather than deferring it to request time', async () => {
    // This exact string ships in agk-deployment-configs as a fill-me-in marker. Reaching
    // production with it unsubstituted must fail the startup probe, not produce a pod
    // that reports healthy and answers `unauthorized` to every request.
    const config = testConfig({
      CODE_ADAPTER_LOCAL_MODE: 'false',
      CODEAPI_JWT_PUBLIC_KEY: PLACEHOLDER,
    });
    await expect(importCodeApiKey(config)).rejects.toThrow();
  });

  it('rejects a PEM whose body was mangled (YAML block-scalar re-indentation)', async () => {
    const config = testConfig({
      CODE_ADAPTER_LOCAL_MODE: 'false',
      CODEAPI_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nnot base64 at all\n',
    });
    await expect(importCodeApiKey(config)).rejects.toThrow();
  });

  it('names the missing variable when no key is configured at all', async () => {
    const config = testConfig({ CODE_ADAPTER_LOCAL_MODE: 'true' });
    await expect(importCodeApiKey(config)).rejects.toThrow(/CODEAPI_JWT_PUBLIC_KEY/);
  });
});

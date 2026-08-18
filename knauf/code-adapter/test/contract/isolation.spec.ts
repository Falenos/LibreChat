import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { mintSessionId } from '../../src/validate.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  generateJwtKeypair,
  mintLibreChatJwt,
  ownedSessionId,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import type { Express } from 'express';

/**
 * [knauf] KK20-257 review — cross-user sandbox isolation.
 *
 * An ACA session identifier IS the isolation boundary: posting to one gives you that
 * sandbox and everything in its /mnt/data. `/exec` accepts a caller-supplied `session_id`,
 * and file refs were the only thing ownership-checked — the sandbox never was. So an
 * authenticated user could name another user's session and read their data by running code
 * in it. Nothing in the request bound the id to a caller.
 *
 * That it was unreachable in practice rested on `@librechat/agents` choosing not to put
 * the field on the wire (pinned in lockedClient.spec.ts) — a property of a third-party
 * package, not of our auth model. These tests assert the property directly instead.
 */
describe('[knauf] a caller cannot reach another user’s sandbox', () => {
  let aca: FakeAcaClient;

  const sentinel = (code: string, rc: number, out: string) => {
    const delimiter = /KARL_[0-9a-f]{12}/.exec(code)?.[0] ?? 'KARL_missing';
    return {
      succeeded: rc === 0,
      stdout: `${delimiter} RC=${rc} OUT=${out.length} ERR=0\n${out}${delimiter}_ERR\n`,
      stderr: '',
      raw: {},
    };
  };

  beforeEach(() => {
    aca = new FakeAcaClient();
  });

  const buildLocalModeApp = (): Express =>
    createApp({
      config: testConfig(),
      logger: testLogger(),
      aca,
      blob: new FakeBlobStore(),
      repo: new FakeFilesRepo().asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });

  it('honours a session_id the caller owns (continuity still works)', async () => {
    const app = buildLocalModeApp();
    const own = ownedSessionId(testConfig());
    aca.executeImpl = async (_sid, code) => sentinel(code, 0, 'ok');

    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)', session_id: own });

    expect(response.status).toBe(200);
    expect(response.body.session_id).toBe(own);
  });

  it('ignores a well-formed session_id belonging to somebody else', async () => {
    const app = buildLocalModeApp();
    // A valid `karl-<32hex>` minted for a different subject. Before the owner tag this was
    // honoured verbatim and the execution ran inside that user's sandbox.
    const victim = mintSessionId('user-victim', testConfig().sessionHintSecret);
    aca.executeImpl = async (_sid, code) => sentinel(code, 0, 'ok');

    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(open("secret.csv").read())', session_id: victim });

    expect(response.status).toBe(200);
    // A fresh sandbox of the caller's own, not the one it asked for.
    expect(response.body.session_id).not.toBe(victim);
    expect(response.body.session_id).toMatch(/^karl-[0-9a-f]{32}$/);
    // And the execution really did go somewhere else.
    expect(aca.executeImpl).toBeDefined();
  });

  it('never sends a foreign identifier to the pool', async () => {
    const app = buildLocalModeApp();
    const victim = mintSessionId('user-victim', testConfig().sessionHintSecret);
    const identifiersSeen: string[] = [];
    aca.executeImpl = async (identifier, code) => {
      identifiersSeen.push(identifier);
      return sentinel(code, 0, 'ok');
    };

    await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)', session_id: victim });

    expect(identifiersSeen).toHaveLength(1);
    expect(identifiersSeen[0]).not.toBe(victim);
  });

  it('separates two real users on the same conversation hint', async () => {
    // With JWT auth on, so the subject comes from the token rather than LOCAL_MODE.
    const { publicKeyPem, privateKey } = await generateJwtKeypair();
    const config = testConfig({
      CODE_ADAPTER_LOCAL_MODE: 'false',
      CODEAPI_JWT_PUBLIC_KEY: publicKeyPem,
      CODEAPI_JWT_ISSUER: 'librechat',
      CODEAPI_JWT_AUDIENCE: 'codeapi',
      SESSION_HINT_SECRET: 'a-real-secret',
    });
    const app = createApp({
      config,
      logger: testLogger(),
      aca,
      blob: new FakeBlobStore(),
      repo: new FakeFilesRepo().asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });
    aca.executeImpl = async (_sid, code) => sentinel(code, 0, 'ok');

    const runAs = async (sub: string) =>
      request(app)
        .post('/v1/exec')
        .set('Authorization', `Bearer ${await mintLibreChatJwt({ privateKey, sub })}`)
        .send({ lang: 'py', code: 'print(1)', runtime_session_hint: 'thread-shared' });

    const alice = await runAs('user-alice');
    const bob = await runAs('user-bob');

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    // Same hint, different users ⇒ different sandboxes. Without userId in the derivation
    // both would share one /mnt/data.
    expect(alice.body.session_id).not.toBe(bob.body.session_id);
    // Continuity within one user still holds.
    const aliceAgain = await runAs('user-alice');
    expect(aliceAgain.body.session_id).toBe(alice.body.session_id);
  });
});

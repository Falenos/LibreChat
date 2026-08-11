import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  generateJwtKeypair,
  mintLibreChatJwt,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import type { Express } from 'express';
import type { KeyLike } from 'jose';

/**
 * JWT verification against tokens shaped exactly like the ones
 * packages/api/src/auth/codeapi.ts mints (EdDSA, iss librechat,
 * aud codeapi, tenant_id claim, kid header).
 */
describe('JWT auth (codeapi.ts mirror)', () => {
  let app: Express;
  let privateKey: KeyLike;

  beforeEach(async () => {
    const keys = await generateJwtKeypair();
    privateKey = keys.privateKey;
    app = createApp({
      config: testConfig({
        CODE_ADAPTER_LOCAL_MODE: 'false',
        CODEAPI_JWT_PUBLIC_KEY: keys.publicKeyPem,
        CODEAPI_JWT_KID: 'lc-codeapi-test',
      }),
      logger: testLogger(),
      aca: new FakeAcaClient(),
      blob: new FakeBlobStore(),
      repo: new FakeFilesRepo().asRepo(),
      mongo: { db: { command: async () => ({ ok: 1 }) } } as never,
      metrics: testMetrics(),
    });
  });

  const exec = (token?: string) => {
    const req = request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });
    return token != null ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('rejects a missing token', async () => {
    const response = await exec();
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('rejects a garbage token', async () => {
    expect((await exec('not-a-jwt')).status).toBe(401);
  });

  it('accepts a codeapi-shaped token and reads sub/tenant_id', async () => {
    const token = await mintLibreChatJwt({ privateKey, sub: 'u-42', tenantId: 'knauf' });
    const response = await exec(token);
    expect(response.status).toBe(200);
  });

  it('rejects a wrong issuer', async () => {
    const token = await mintLibreChatJwt({ privateKey, issuer: 'someone-else' });
    expect((await exec(token)).status).toBe(401);
  });

  it('rejects a wrong audience', async () => {
    const token = await mintLibreChatJwt({ privateKey, audience: 'other-api' });
    expect((await exec(token)).status).toBe(401);
  });

  it('rejects a wrong kid when pinned', async () => {
    const token = await mintLibreChatJwt({ privateKey, kid: 'rotated-away' });
    expect((await exec(token)).status).toBe(401);
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateJwtKeypair();
    const token = await mintLibreChatJwt({ privateKey: other.privateKey });
    expect((await exec(token)).status).toBe(401);
  });

  it('rejects a token missing tenant_id', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ role: 'USER' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'lc-codeapi-test' })
      .setSubject('u-1')
      .setIssuer('librechat')
      .setAudience('codeapi')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey);
    expect((await exec(token)).status).toBe(401);
  });

  it('leaves health endpoints unauthenticated', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
  });
});

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  testConfig,
  testMetrics,
} from '../helpers/fakes.js';

describe('HTTP request logging', () => {
  it('keeps bounded request facts while removing identity and dynamic URL values', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger('info', destination);
    const app = createApp({
      config: testConfig(),
      logger,
      aca: new FakeAcaClient(),
      blob: new FakeBlobStore(),
      repo: new FakeFilesRepo().asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });
    const sessionId = `karl-${'a'.repeat(32)}`;
    const fileId = '11111111-1111-4111-8111-111111111111';

    await request(app)
      .get(`/v1/sessions/${sessionId}/objects/${fileId}?kind=user&id=raw-user-id`)
      .set('x-user-id', 'raw-user-header');

    const log = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1);
    expect(log).toMatchObject({
      req: { method: 'GET', route: '/v1/sessions/:sessionId/objects/:fileId' },
      res: { statusCode: 404 },
    });
    expect(log).toHaveProperty('responseTime');
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain(fileId);
    expect(serialized).not.toContain('raw-user-id');
    expect(serialized).not.toContain('raw-user-header');
    expect(serialized).not.toContain('?kind=');
  });

  it('redacts direct identity/path fields and bounds error details', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger('info', destination);

    logger.warn(
      {
        sessionId: 'raw-session',
        fileId: 'raw-object',
        userId: 'raw-user',
        filename: 'private-name.csv',
        url: '/code/execute?identifier=raw-session&api-version=secret',
        err: Object.assign(new Error('provider payload with secret-token'), {
          code: 'ECONNRESET',
        }),
      },
      'bounded failure',
    );

    const log = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(log).toMatchObject({
      sessionId: '[redacted]',
      fileId: '[redacted]',
      userId: '[redacted]',
      filename: '[redacted]',
      url: '[redacted]',
      err: { reason: 'ECONNRESET' },
    });
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('raw-session');
    expect(serialized).not.toContain('raw-object');
    expect(serialized).not.toContain('raw-user');
    expect(serialized).not.toContain('private-name.csv');
    expect(serialized).not.toContain('secret-token');
  });
});

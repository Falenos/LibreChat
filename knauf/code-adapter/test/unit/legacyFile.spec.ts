import { describe, expect, it } from 'vitest';
import { parseLegacyFileDoc } from '../../src/migration/legacyFile.js';

const source = () => ({
  _id: 'ignored-mongo-id',
  sessionId: `karl-${'a'.repeat(32)}`,
  fileId: '11111111-1111-4111-8111-111111111111',
  filename: 'reports/result.csv',
  size: 42,
  contentType: 'text/csv',
  state: 'captured',
  origin: 'exec-output',
  readOnly: false,
  identity: { kind: 'skill', id: 'xlsx', version: 3 },
  userId: 'user-1',
  tenantId: 'knauf',
  blobPath: `karl-${'a'.repeat(32)}/22222222-2222-4222-8222-222222222222`,
  lastModified: new Date('2026-08-18T12:00:00.000Z'),
  expiresAt: new Date('2026-08-19T12:00:00.000Z'),
});

describe('legacy Mongo file validation', () => {
  it('maps the legacy document without carrying Mongo-specific fields', () => {
    const parsed = parseLegacyFileDoc(source());

    expect(parsed).not.toHaveProperty('_id');
    expect(parsed).toMatchObject({
      filename: 'reports/result.csv',
      identity: { kind: 'skill', id: 'xlsx', version: 3 },
    });
  });

  it('rejects malformed dates, identities, and state combinations', () => {
    expect(() => parseLegacyFileDoc({ ...source(), expiresAt: 'tomorrow' })).toThrow(
      /expiresAt/,
    );
    expect(() =>
      parseLegacyFileDoc({ ...source(), identity: { kind: 'skill', id: 'xlsx' } }),
    ).toThrow(/skill identity.*version/);
    expect(() => parseLegacyFileDoc({ ...source(), state: 'staged' })).toThrow(
      /malformed file entity/,
    );
  });
});

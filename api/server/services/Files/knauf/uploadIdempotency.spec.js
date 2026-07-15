// [knauf] KK20-195 WP3a — seam test for the upload-idempotency decisions:
// client-id adoption rules and the replay/conflict classification (plan §6.1
// steps 3+5; §14 row "Lost upload response → same file_id returns same file").
const { isValidClientFileId, classifyUploadReplay } = require('./uploadIdempotency');

describe('isValidClientFileId (KK20-195 WP3a)', () => {
  test('accepts well-formed UUIDs (any case)', () => {
    expect(isValidClientFileId('3f2b8a1e-9c4d-4e5f-8a6b-7c8d9e0f1a2b')).toBe(true);
    expect(isValidClientFileId('3F2B8A1E-9C4D-4E5F-8A6B-7C8D9E0F1A2B')).toBe(true);
  });

  test('rejects everything else — those fall back to the server-minted id', () => {
    expect(isValidClientFileId(undefined)).toBe(false);
    expect(isValidClientFileId(null)).toBe(false);
    expect(isValidClientFileId('')).toBe(false);
    expect(isValidClientFileId('not-a-uuid')).toBe(false);
    expect(isValidClientFileId('3f2b8a1e9c4d4e5f8a6b7c8d9e0f1a2b')).toBe(false);
    expect(isValidClientFileId({ file_id: 'x' })).toBe(false);
  });
});

describe('classifyUploadReplay (KK20-195 WP3a)', () => {
  const userId = '64a000000000000000000001';

  test('no existing row → proceed', () => {
    expect(classifyUploadReplay({ existing: undefined, userId, incomingBytes: 10 })).toEqual({
      outcome: 'proceed',
    });
  });

  test('same owner + same bytes → replay (exact retry returns the original)', () => {
    expect(
      classifyUploadReplay({ existing: { user: userId, bytes: 10 }, userId, incomingBytes: 10 }),
    ).toEqual({ outcome: 'replay' });
  });

  test('same owner + different bytes → conflict: different_content', () => {
    expect(
      classifyUploadReplay({ existing: { user: userId, bytes: 10 }, userId, incomingBytes: 99 }),
    ).toEqual({ outcome: 'conflict', reason: 'different_content' });
  });

  test('a different owner NEVER overwrites → conflict: file_id_taken', () => {
    expect(
      classifyUploadReplay({
        existing: { user: '64a000000000000000000002', bytes: 10 },
        userId,
        incomingBytes: 10,
      }),
    ).toEqual({ outcome: 'conflict', reason: 'file_id_taken' });
  });

  test('missing byte counts degrade to replay, never to a false conflict', () => {
    expect(classifyUploadReplay({ existing: { user: userId }, userId, incomingBytes: 10 })).toEqual(
      { outcome: 'replay' },
    );
    expect(
      classifyUploadReplay({
        existing: { user: userId, bytes: 10 },
        userId,
        incomingBytes: undefined,
      }),
    ).toEqual({ outcome: 'replay' });
  });
});
// End [knauf]

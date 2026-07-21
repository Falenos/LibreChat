// [knauf] KK20-195 WP0 — seam test for the blob-compensation wrapper: a failed
// embed deletes the blob this request just uploaded (best-effort) and rethrows
// the original error; success passes through untouched.

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { logger } = require('@librechat/data-schemas');
const { embedWithBlobCompensation } = require('./embedCompensation');

describe('embedWithBlobCompensation (KK20-195 WP0)', () => {
  const req = { user: { id: 'u1' } };
  const storageResult = { filepath: 'https://blob.test/container/f1.pdf' };

  beforeEach(() => jest.clearAllMocks());

  test('success passes the embed result through and never touches the blob', async () => {
    const deleteFile = jest.fn();
    const result = await embedWithBlobCompensation({
      embed: async () => ({ embedded: true }),
      req,
      file_id: 'f1',
      source: 'azure',
      storageResult,
      getStrategyFunctions: () => ({ deleteFile }),
    });

    expect(result).toEqual({ embedded: true });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  test('failure deletes the just-uploaded blob, then rethrows the ORIGINAL error', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const embedError = new Error('embed exploded');

    await expect(
      embedWithBlobCompensation({
        embed: async () => {
          throw embedError;
        },
        req,
        file_id: 'f1',
        source: 'azure',
        storageResult,
        getStrategyFunctions: () => ({ deleteFile }),
      }),
    ).rejects.toBe(embedError);

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(req, {
      file_id: 'f1',
      filepath: storageResult.filepath,
      source: 'azure',
    });
  });

  test('blob-cleanup failure is swallowed (warned) and the original error still surfaces', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('storage down'));
    const embedError = new Error('embed exploded');

    await expect(
      embedWithBlobCompensation({
        embed: async () => {
          throw embedError;
        },
        req,
        file_id: 'f1',
        source: 'azure',
        storageResult,
        getStrategyFunctions: () => ({ deleteFile }),
      }),
    ).rejects.toBe(embedError);

    expect(logger.warn).toHaveBeenCalled();
  });

  test('skips cleanup when the strategy has no deleteFile or no filepath exists', async () => {
    const embedError = new Error('embed exploded');

    await expect(
      embedWithBlobCompensation({
        embed: async () => {
          throw embedError;
        },
        req,
        file_id: 'f1',
        source: 'local',
        storageResult: {},
        getStrategyFunctions: () => ({}),
      }),
    ).rejects.toBe(embedError);
  });
});
// End [knauf]

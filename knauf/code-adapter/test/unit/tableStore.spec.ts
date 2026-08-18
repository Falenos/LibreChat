import { describe, expect, it, vi } from 'vitest';
import {
  checkTableReadiness,
  isEntityNotFound,
} from '../../src/store/tableStore.js';
import { testMetrics } from '../helpers/fakes.js';
import type { RepositoryTableClient } from '../../src/store/tableStore.js';

function clientWith(
  overrides: Partial<RepositoryTableClient> = {},
): RepositoryTableClient {
  return {
    get: vi.fn(),
    submitTransaction: vi.fn(),
    listPage: vi.fn().mockResolvedValue({ entities: [], continuationToken: null }),
    ...overrides,
  };
}

describe('Table readiness', () => {
  it('classifies only the documented entity-missing error as not found', () => {
    expect(isEntityNotFound({ statusCode: 404, code: 'EntityNotFound' })).toBe(true);
    expect(
      isEntityNotFound({
        statusCode: 404,
        details: { odataError: { code: 'ResourceNotFound' } },
      }),
    ).toBe(true);
    expect(isEntityNotFound({ statusCode: 404, code: 'TableNotFound' })).toBe(false);
    expect(isEntityNotFound({ statusCode: 404 })).toBe(false);
    expect(isEntityNotFound({ statusCode: 403, code: 'AuthorizationPermissionMismatch' })).toBe(
      false,
    );
    expect(isEntityNotFound(new Error('network reset'))).toBe(false);
  });

  it('accepts an exact reserved-entity query only when the table returns an empty page', async () => {
    const listPage = vi.fn().mockResolvedValue({ entities: [], continuationToken: null });

    await expect(
      checkTableReadiness(clientWith({ listPage }), testMetrics()),
    ).resolves.toBeUndefined();

    expect(listPage).toHaveBeenCalledWith({
      partitionKey: '__system__',
      rowKey: '__readiness__',
      maxPageSize: 1,
    });
  });

  it('fails readiness when conditional transaction support is unavailable', async () => {
    const client = {
      ...clientWith(),
      checkTransactionSupport: vi.fn().mockRejectedValue(new Error('unsupported SDK shape')),
    };

    await expect(checkTableReadiness(client, testMetrics())).rejects.toThrow(
      'unsupported SDK shape',
    );
    expect(client.listPage).not.toHaveBeenCalled();
  });

  it('surfaces missing-table, auth, network, and unexpected-entity failures', async () => {
    await expect(
      checkTableReadiness(
        clientWith({
          listPage: vi.fn().mockRejectedValue({ statusCode: 404, code: 'TableNotFound' }),
        }),
        testMetrics(),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'TableNotFound' });
    await expect(
      checkTableReadiness(
        clientWith({ listPage: vi.fn().mockRejectedValue({ statusCode: 403 }) }),
        testMetrics(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      checkTableReadiness(
        clientWith({ listPage: vi.fn().mockRejectedValue(new Error('network reset')) }),
        testMetrics(),
      ),
    ).rejects.toThrow('network reset');
    await expect(
      checkTableReadiness(
        clientWith({
          listPage: vi.fn().mockResolvedValue({
            entities: [
              {
                partitionKey: '__system__',
                rowKey: '__readiness__',
                etag: '"unexpected"',
              },
            ],
            continuationToken: null,
          }),
        }),
        testMetrics(),
      ),
    ).rejects.toThrow(/reserved Table readiness entity exists/);
  });
});

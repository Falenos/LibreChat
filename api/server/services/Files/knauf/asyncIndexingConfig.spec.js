// [knauf] KK20-195 WP3b — seam test for the async-indexing flags: acceptance
// and worker execution are INDEPENDENT switches, and the tenant allow-list
// only gates acceptance (plan §12: rollback stops new async uploads while
// queued work drains).
const {
  isAsyncAcceptEnabled,
  isIndexingWorkerEnabled,
  isAsyncAcceptedForUser,
  getIndexProfile,
} = require('./asyncIndexingConfig');

const ENV_KEYS = [
  'KNAUF_ASYNC_FILE_INDEXING_ACCEPT',
  'KNAUF_INDEXING_WORKER_ENABLED',
  'KNAUF_ASYNC_INDEXING_TENANTS',
  'KNAUF_INDEX_PROFILE',
];
const saved = {};

beforeAll(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

describe('async-indexing flags (KK20-195 WP3b)', () => {
  test('both flags default OFF and are independent', () => {
    delete process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT;
    delete process.env.KNAUF_INDEXING_WORKER_ENABLED;
    expect(isAsyncAcceptEnabled()).toBe(false);
    expect(isIndexingWorkerEnabled()).toBe(false);

    process.env.KNAUF_INDEXING_WORKER_ENABLED = 'true';
    expect(isIndexingWorkerEnabled()).toBe(true);
    expect(isAsyncAcceptEnabled()).toBe(false); // worker on ≠ acceptance on
  });

  test('acceptance for a user honors the tenant allow-list', () => {
    process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT = 'true';

    delete process.env.KNAUF_ASYNC_INDEXING_TENANTS;
    expect(isAsyncAcceptedForUser({ tenantId: 't1' })).toBe(true); // empty list = all

    process.env.KNAUF_ASYNC_INDEXING_TENANTS = 't1, t2';
    expect(isAsyncAcceptedForUser({ tenantId: 't1' })).toBe(true);
    expect(isAsyncAcceptedForUser({ tenantId: 't3' })).toBe(false);
    expect(isAsyncAcceptedForUser(undefined)).toBe(false);
  });

  test('acceptance is hard-off regardless of allow-list when the flag is off', () => {
    delete process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT;
    process.env.KNAUF_ASYNC_INDEXING_TENANTS = 't1';
    expect(isAsyncAcceptedForUser({ tenantId: 't1' })).toBe(false);
  });

  test('index profile defaults to legacy-v0 and follows the env knob', () => {
    delete process.env.KNAUF_INDEX_PROFILE;
    expect(getIndexProfile()).toBe('legacy-v0');
    process.env.KNAUF_INDEX_PROFILE = 'di-routed-v1';
    expect(getIndexProfile()).toBe('di-routed-v1');
  });
});
// End [knauf]

import { describe, expect, it, vi } from 'vitest';
import { createDependencyReadiness } from '../../src/readiness.js';
import { testConfig, testMetrics } from '../helpers/fakes.js';
import type { DependencyCheck } from '../../src/readiness.js';

describe('createDependencyReadiness', () => {
  it('runs all dependency checks once within the cache window', async () => {
    const run = vi.fn(async () => undefined);
    const checks: DependencyCheck[] = [
      { name: 'table', run },
      { name: 'blob', run },
      { name: 'identity', run },
      { name: 'aca', run },
    ];
    const readiness = createDependencyReadiness(
      testConfig({ READINESS_CACHE_MS: '60000' }),
      testMetrics(),
      checks,
    );

    await readiness();
    await readiness();

    expect(run).toHaveBeenCalledTimes(4);
  });

  it('fails readiness when any dependency check fails', async () => {
    const readiness = createDependencyReadiness(testConfig(), testMetrics(), [
      { name: 'table', run: async () => undefined },
      {
        name: 'blob',
        run: async () => {
          throw new Error('container denied');
        },
      },
      { name: 'identity', run: async () => undefined },
      { name: 'aca', run: async () => undefined },
    ]);

    await expect(readiness()).rejects.toThrow(/blob: container denied/);
  });
});

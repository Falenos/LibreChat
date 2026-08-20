import type { Config } from './config.js';
import type { Metrics } from './middleware/metrics.js';

export interface DependencyCheck {
  name: 'table' | 'blob' | 'identity' | 'aca';
  run: (signal: AbortSignal) => Promise<void>;
}

interface CachedResult {
  checkedAt: number;
  error: Error | null;
}

export function createDependencyReadiness(
  config: Config,
  metrics: Metrics,
  checks: DependencyCheck[],
): () => Promise<void> {
  let cache: CachedResult | null = null;
  let inFlight: Promise<CachedResult> | null = null;

  const refresh = async (): Promise<CachedResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.readinessTimeoutMs);
    timeout.unref();
    try {
      const results = await Promise.allSettled(
        checks.map(async (check) => {
          try {
            await check.run(controller.signal);
            metrics.dependencyReadiness.set({ dependency: check.name }, 1);
            metrics.dependencyReadinessChecks.inc({
              dependency: check.name,
              outcome: 'ready',
            });
          } catch (error) {
            metrics.dependencyReadiness.set({ dependency: check.name }, 0);
            metrics.dependencyReadinessChecks.inc({
              dependency: check.name,
              outcome: 'error',
            });
            throw new Error(`${check.name}: ${(error as Error).message}`);
          }
        }),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason as Error).message);
      return {
        checkedAt: Date.now(),
        error:
          failures.length === 0
            ? null
            : new Error(`dependency readiness failed: ${failures.join('; ')}`),
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  return async () => {
    if (cache != null && Date.now() - cache.checkedAt < config.readinessCacheMs) {
      if (cache.error != null) {
        throw cache.error;
      }
      return;
    }
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    cache = await inFlight;
    if (cache.error != null) {
      throw cache.error;
    }
  };
}

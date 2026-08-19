import { DefaultAzureCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/identity';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Entra token acquisition for the dynamic-sessions data plane.
 * One process-wide DefaultAzureCredential (workload identity
 * in-cluster via the webhook-injected AZURE_* vars; az CLI locally).
 *
 * Cache policy: reuse until refresh-skew before expiry; refresh is
 * single-flight so concurrent execs share one token request. Reactive
 * path: invalidate() on a pool 401/403, then the caller retries once.
 */
export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

interface CachedToken {
  token: string;
  expiresOnMs: number;
}

interface InflightToken {
  controller: AbortController;
  promise: Promise<CachedToken>;
  waiters: number;
  settled: boolean;
}

function waitForToken(promise: Promise<CachedToken>, signal?: AbortSignal): Promise<CachedToken> {
  signal?.throwIfAborted();
  if (signal == null) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createTokenProvider(
  config: Config,
  logger: Logger,
  credential: TokenCredential = new DefaultAzureCredential(),
): TokenProvider {
  let cached: CachedToken | null = null;
  let inflight: InflightToken | null = null;

  const refresh = async (signal: AbortSignal): Promise<CachedToken> => {
    const result = await credential.getToken(config.aca.tokenScope, { abortSignal: signal });
    if (result == null) {
      throw new Error('Failed to acquire Entra token for dynamic sessions');
    }
    logger.info(
      { expiresOn: new Date(result.expiresOnTimestamp).toISOString() },
      'Entra token acquired',
    );
    return { token: result.token, expiresOnMs: result.expiresOnTimestamp };
  };

  return {
    async getToken(signal) {
      signal?.throwIfAborted();
      const now = Date.now();
      const skewMs = config.aca.tokenRefreshSkewS * 1000;
      if (cached != null && now < cached.expiresOnMs - skewMs) {
        return cached.token;
      }
      if (inflight == null) {
        const entry: InflightToken = {
          controller: new AbortController(),
          promise: Promise.resolve({ token: '', expiresOnMs: 0 }),
          waiters: 0,
          settled: false,
        };
        entry.promise = refresh(entry.controller.signal)
          .then((token) => {
            cached = token;
            return token;
          })
          .finally(() => {
            entry.settled = true;
            if (inflight === entry) {
              inflight = null;
            }
          });
        inflight = entry;
      }
      const entry = inflight;
      entry.waiters += 1;
      try {
        return (await waitForToken(entry.promise, signal)).token;
      } finally {
        entry.waiters -= 1;
        if (!entry.settled && entry.waiters === 0) {
          entry.controller.abort();
        }
      }
    },

    invalidate() {
      cached = null;
    },
  };
}

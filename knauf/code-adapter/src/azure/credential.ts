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
  getToken(): Promise<string>;
  invalidate(): void;
}

interface CachedToken {
  token: string;
  expiresOnMs: number;
}

export function createTokenProvider(
  config: Config,
  logger: Logger,
  credential: TokenCredential = new DefaultAzureCredential(),
): TokenProvider {
  let cached: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;

  const refresh = async (): Promise<CachedToken> => {
    const result = await credential.getToken(config.aca.tokenScope);
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
    async getToken() {
      const now = Date.now();
      const skewMs = config.aca.tokenRefreshSkewS * 1000;
      if (cached != null && now < cached.expiresOnMs - skewMs) {
        return cached.token;
      }
      if (inflight == null) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      cached = await inflight;
      return cached.token;
    },

    invalidate() {
      cached = null;
    },
  };
}

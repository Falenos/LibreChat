import { describe, expect, it } from 'vitest';
import { createTokenProvider } from '../../src/azure/credential.js';
import { testConfig, testLogger } from '../helpers/fakes.js';
import type { AccessToken, TokenCredential } from '@azure/identity';

function fakeCredential(lifetimeMs: number): { credential: TokenCredential; calls: () => number } {
  let calls = 0;
  return {
    credential: {
      async getToken(): Promise<AccessToken> {
        calls += 1;
        return { token: `token-${calls}`, expiresOnTimestamp: Date.now() + lifetimeMs };
      },
    },
    calls: () => calls,
  };
}

describe('token provider', () => {
  it('caches the token until the refresh skew window', async () => {
    const { credential, calls } = fakeCredential(3_600_000);
    const provider = createTokenProvider(testConfig(), testLogger(), credential);
    expect(await provider.getToken()).toBe('token-1');
    expect(await provider.getToken()).toBe('token-1');
    expect(calls()).toBe(1);
  });

  it('refreshes when inside the skew window', async () => {
    // lifetime shorter than the 300s skew ⇒ every call refreshes
    const { credential, calls } = fakeCredential(100_000);
    const provider = createTokenProvider(testConfig(), testLogger(), credential);
    await provider.getToken();
    await provider.getToken();
    expect(calls()).toBe(2);
  });

  it('single-flights concurrent refreshes', async () => {
    const { credential, calls } = fakeCredential(3_600_000);
    const provider = createTokenProvider(testConfig(), testLogger(), credential);
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(calls()).toBe(1);
  });

  it('invalidate forces a fresh token', async () => {
    const { credential, calls } = fakeCredential(3_600_000);
    const provider = createTokenProvider(testConfig(), testLogger(), credential);
    await provider.getToken();
    provider.invalidate();
    expect(await provider.getToken()).toBe('token-2');
    expect(calls()).toBe(2);
  });
});

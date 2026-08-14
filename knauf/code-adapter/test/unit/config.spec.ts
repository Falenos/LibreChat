import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { TEST_ENV_BASE } from '../helpers/fakes.js';

describe('loadConfig', () => {
  it('fail-fasts with one line per missing var', () => {
    try {
      loadConfig({ CODE_ADAPTER_LOCAL_MODE: 'true' });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('ACA_POOL_ENDPOINT is required');
      expect(message).toContain('MONGO_URI is required');
      // Blob auth is one-of (workload identity or the account key), so the line names both
      // routes rather than a single variable. Review finding B2.
      expect(message).toContain('AZURE_STORAGE_ACCOUNT_NAME');
      expect(message).toContain('AZURE_STORAGE_CONNECTION_STRING');
    }
  });

  /**
   * Review finding B2 — the account key is not a scoped credential. The value in
   * `agentic-karl-BLOB-STORAGE-CONNECTION-STRING` is the storage account's *primary key*, so
   * it grants this pod every container on the account including the app's own. Workload
   * identity narrows that to whatever role assignments the pod holds.
   */
  describe('blob auth selection (B2)', () => {
    const base = { ...TEST_ENV_BASE, AZURE_STORAGE_CONNECTION_STRING: undefined } as Record<
      string,
      string | undefined
    >;

    it('accepts an account name instead of a connection string', () => {
      const config = loadConfig({ ...base, AZURE_STORAGE_ACCOUNT_NAME: 'agkstorage' });
      expect(config.blob.accountUrl).toBe('https://agkstorage.blob.core.windows.net');
      expect(config.blob.connectionString).toBeNull();
    });

    it('accepts an explicit account URL and strips trailing slashes', () => {
      const config = loadConfig({
        ...base,
        AZURE_STORAGE_ACCOUNT_URL: 'https://agkstorage.blob.core.windows.net//',
      });
      expect(config.blob.accountUrl).toBe('https://agkstorage.blob.core.windows.net');
    });

    it('prefers the explicit URL over the derived one', () => {
      const config = loadConfig({
        ...base,
        AZURE_STORAGE_ACCOUNT_NAME: 'ignored',
        AZURE_STORAGE_ACCOUNT_URL: 'https://explicit.blob.core.windows.net',
      });
      expect(config.blob.accountUrl).toBe('https://explicit.blob.core.windows.net');
    });

    it('keeps the connection string working on its own (no forced migration)', () => {
      const config = loadConfig(TEST_ENV_BASE);
      expect(config.blob.connectionString).not.toBeNull();
      expect(config.blob.accountUrl).toBeNull();
    });

    it('lets workload identity win when both are set, so migration order does not matter', () => {
      // Whichever value is added or removed first, the key stops being used as soon as the
      // account name is present — there is no window where both are configured and the key
      // is still the one in effect.
      const config = loadConfig({ ...TEST_ENV_BASE, AZURE_STORAGE_ACCOUNT_NAME: 'agkstorage' });
      expect(config.blob.accountUrl).toBe('https://agkstorage.blob.core.windows.net');
      expect(config.blob.connectionString).not.toBeNull();
    });

    it('fails at boot when neither is configured', () => {
      expect(() => loadConfig(base)).toThrow(/AZURE_STORAGE_ACCOUNT_NAME/);
    });
  });

  it('requires the JWT public key outside LOCAL_MODE', () => {
    expect(() => loadConfig({ ...TEST_ENV_BASE, CODE_ADAPTER_LOCAL_MODE: 'false' })).toThrow(
      /CODEAPI_JWT_PUBLIC_KEY/,
    );
  });

  it('refuses LOCAL_MODE in production', () => {
    expect(() => loadConfig({ ...TEST_ENV_BASE, NODE_ENV: 'production' })).toThrow(
      /LOCAL_MODE.*not allowed/,
    );
  });

  it('applies defaults and pins', () => {
    const config = loadConfig({ ...TEST_ENV_BASE });
    // One code-interpreter pool; api-version verified by the KK20-108 spike.
    expect(config.aca.apiVersion).toBe('2024-02-02-preview');
    expect(config.aca.execTimeoutMs).toBe(230_000);
    expect(config.exec.wrapper).toBe('full');
    expect(config.exec.captureMaxTotalBytes).toBe(268_435_456);
    expect(config.uploadMaxBytes).toBe(134_217_728);
    expect(config.fileTtlHours).toBe(24);
    expect(config.fileMaxLifetimeHours).toBe(168);
    expect(config.blob.container).toBe('code-adapter-staging');
    expect(config.jwt.issuer).toBe('librechat');
    expect(config.jwt.audience).toBe('codeapi');
  });

  it('strips trailing slashes from the pool endpoint', () => {
    const config = loadConfig({
      ...TEST_ENV_BASE,
      ACA_POOL_ENDPOINT: 'https://code-pool.example.test///',
    });
    expect(config.aca.poolEndpoint).toBe('https://code-pool.example.test');
  });

  it('rejects an absolute file lifetime shorter than the sliding TTL', () => {
    expect(() =>
      loadConfig({
        ...TEST_ENV_BASE,
        FILE_TTL_HOURS: '24',
        FILE_MAX_LIFETIME_HOURS: '12',
      }),
    ).toThrow(/FILE_MAX_LIFETIME_HOURS.*FILE_TTL_HOURS/);
  });
});

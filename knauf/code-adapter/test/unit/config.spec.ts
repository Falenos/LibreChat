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
      expect(message).toContain('AZURE_TABLE_CONNECTION_STRING');
      // Blob auth is one-of (workload identity or the account key), so the line names both
      // routes rather than a single variable. Review finding B2.
      expect(message).toContain('AZURE_STORAGE_ACCOUNT_NAME');
      expect(message).toContain('AZURE_STORAGE_CONNECTION_STRING');
    }
  });

  describe('Table auth selection', () => {
    it('accepts a Table connection string only in explicit local mode', () => {
      const config = loadConfig(TEST_ENV_BASE);
      expect(config.table.localConnectionString).toBe('UseDevelopmentStorage=true');
      expect(config.table.accountUrl).toBeNull();
    });

    it('rejects a Table connection string outside local mode', () => {
      expect(() =>
        loadConfig({
          ...TEST_ENV_BASE,
          CODE_ADAPTER_LOCAL_MODE: 'false',
          CODEAPI_JWT_PUBLIC_KEY: 'public-key-placeholder',
          AZURE_STORAGE_ACCOUNT_NAME: 'sharedaccount',
        }),
      ).toThrow(/AZURE_TABLE_CONNECTION_STRING.*only/);
    });

    it('prefers the explicit Table URL, then Table account name, then storage account name', () => {
      const common = {
        ...TEST_ENV_BASE,
        AZURE_TABLE_CONNECTION_STRING: undefined,
        AZURE_STORAGE_ACCOUNT_NAME: 'sharedaccount',
      } as Record<string, string | undefined>;
      expect(
        loadConfig({
          ...common,
          AZURE_TABLE_ACCOUNT_NAME: 'tableaccount',
          AZURE_TABLE_ACCOUNT_URL: 'https://explicit.table.core.windows.net///',
        }).table.accountUrl,
      ).toBe('https://explicit.table.core.windows.net');
      expect(
        loadConfig({ ...common, AZURE_TABLE_ACCOUNT_NAME: 'tableaccount' }).table.accountUrl,
      ).toBe('https://tableaccount.table.core.windows.net');
      expect(loadConfig(common).table.accountUrl).toBe(
        'https://sharedaccount.table.core.windows.net',
      );
    });

    it('requires a workload-identity Table endpoint outside local mode', () => {
      expect(() =>
        loadConfig({
          ACA_POOL_ENDPOINT: 'https://pool.example.test',
          CODEAPI_JWT_PUBLIC_KEY: 'public-key-placeholder',
          AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        }),
      ).toThrow(/workload-identity Table auth/);
    });
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
    expect(() =>
      loadConfig({
        ...TEST_ENV_BASE,
        CODE_ADAPTER_LOCAL_MODE: 'false',
        AZURE_TABLE_CONNECTION_STRING: undefined,
        AZURE_TABLE_ACCOUNT_NAME: 'table-test-account',
      }),
    ).toThrow(/CODEAPI_JWT_PUBLIC_KEY/);
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
    expect(config.table.tableName).toBe('codeAdapterFiles');
    expect(config.blob.container).toBe('code-adapter-staging');
    expect(config.cleanupEnabled).toBe(true);
    expect(config.jwt.issuer).toBe('librechat');
    expect(config.jwt.audience).toBe('codeapi');
    // KK20-397 input selection and upload hardening.
    expect(config.exec.inputSelection).toBe('ranked');
    expect(config.exec.inputMaxFiles).toBe(32);
    expect(config.exec.inputMaxRefs).toBe(256);
    expect(config.exec.inputOptionalMaxBytes).toBe(67_108_864);
    expect(config.exec.inputPushBudgetMs).toBe(30_000);
    expect(config.exec.inputSiblingMaxFiles).toBe(16);
    expect(config.exec.inputSiblingMaxBytes).toBe(33_554_432);
    expect(config.exec.captureIgnoreHidden).toBe(true);
    expect(config.exec.manifestMaxEntries).toBe(500);
    expect(config.upload).toEqual({
      preservePaths: true,
      batchMaxFiles: 32,
      batchMaxTotalBytes: 268_435_456,
    });
  });

  it('keeps the pre-0.4 behaviours reachable as rollback levers', () => {
    const config = loadConfig({
      ...TEST_ENV_BASE,
      EXEC_INPUT_SELECTION: 'strict',
      UPLOAD_PRESERVE_PATHS: 'false',
      CAPTURE_IGNORE_HIDDEN: 'false',
    });
    expect(config.exec.inputSelection).toBe('strict');
    expect(config.upload.preservePaths).toBe(false);
    expect(config.exec.captureIgnoreHidden).toBe(false);
  });

  it('allows cleanup to be disabled explicitly for a dark validation deployment', () => {
    expect(loadConfig({ ...TEST_ENV_BASE, CLEANUP_ENABLED: 'false' }).cleanupEnabled).toBe(false);
  });

  it('strips trailing slashes from the pool endpoint', () => {
    const config = loadConfig({
      ...TEST_ENV_BASE,
      ACA_POOL_ENDPOINT: 'https://code-pool.example.test///',
    });
    expect(config.aca.poolEndpoint).toBe('https://code-pool.example.test');
  });
});

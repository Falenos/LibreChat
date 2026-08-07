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
      expect(message).toContain('AZURE_STORAGE_CONNECTION_STRING is required');
    }
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
    expect(config.uploadMaxBytes).toBe(134_217_728);
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
});

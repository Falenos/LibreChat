import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/middleware/metrics.js';

describe('unified telemetry tags', () => {
  const originalVersion = process.env.ADAPTER_VERSION;
  const originalEnv = process.env.DD_ENV;

  afterEach(() => {
    if (originalVersion == null) {
      delete process.env.ADAPTER_VERSION;
    } else {
      process.env.ADAPTER_VERSION = originalVersion;
    }
    if (originalEnv == null) {
      delete process.env.DD_ENV;
    } else {
      process.env.DD_ENV = originalEnv;
    }
  });

  it('adds service, environment, and immutable adapter version to logs and metrics', async () => {
    process.env.ADAPTER_VERSION = '0.3.2';
    process.env.DD_ENV = 'production';

    const logger = createLogger('silent');
    expect(logger.bindings()).toMatchObject({
      service: 'agentic-karl-code-adapter',
      env: 'production',
      version: '0.3.2',
    });

    const metrics = createMetrics();
    metrics.admissionActive.set(1);
    const exposition = await metrics.registry.metrics();

    expect(exposition).toContain(
      'code_adapter_admission_active_requests{service="agentic-karl-code-adapter",env="production",version="0.3.2"} 1',
    );
  });
});

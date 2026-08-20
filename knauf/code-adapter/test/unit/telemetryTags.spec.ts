import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/middleware/metrics.js';

describe('unified telemetry tags', () => {
  const originalVersion = process.env.ADAPTER_VERSION;

  afterEach(() => {
    if (originalVersion == null) {
      delete process.env.ADAPTER_VERSION;
    } else {
      process.env.ADAPTER_VERSION = originalVersion;
    }
  });

  it('adds the immutable adapter version and canonical service to logs and metrics', async () => {
    process.env.ADAPTER_VERSION = '0.3.2';

    const logger = createLogger('silent');
    expect(logger.bindings()).toMatchObject({
      service: 'agentic-karl-code-adapter',
      version: '0.3.2',
    });

    const metrics = createMetrics();
    metrics.admissionActive.set(1);
    const exposition = await metrics.registry.metrics();

    expect(exposition).toContain(
      'code_adapter_admission_active_requests{service="agentic-karl-code-adapter",version="0.3.2"} 1',
    );
  });
});

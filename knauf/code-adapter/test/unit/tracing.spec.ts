import { describe, expect, it, vi } from 'vitest';

const { init, register } = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
}));

vi.mock('dd-trace', () => ({
  default: {
    init,
    TracerProvider: class {
      register = register;
    },
  },
}));

describe('Datadog tracing bootstrap', () => {
  it('registers the OTel bridge with automatic high-cardinality plugins disabled', async () => {
    await import('../../src/tracing.js');

    expect(init).toHaveBeenCalledWith({ plugins: false });
    expect(register).toHaveBeenCalledOnce();
  });
});

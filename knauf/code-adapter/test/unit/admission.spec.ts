import { describe, expect, it } from 'vitest';
import { AdmissionController } from '../../src/exec/admission.js';
import { testConfig, testMetrics } from '../helpers/fakes.js';

describe('AdmissionController', () => {
  it('bounds active requests before dependency work and releases idempotently', () => {
    const admission = new AdmissionController(
      testConfig({ EXEC_MAX_ACTIVE_REQUESTS: '1' }).exec,
      testMetrics(),
    );
    const first = admission.tryAcquireRequest();
    expect('rejected' in first).toBe(false);
    expect(admission.tryAcquireRequest()).toEqual({ rejected: 'active_requests' });

    if ('rejected' in first) {
      throw new Error('expected the first request to be admitted');
    }
    first.release();
    first.release();
    expect('rejected' in admission.tryAcquireRequest()).toBe(false);
  });

  it('reserves aggregate input bytes only after metadata resolution', () => {
    const admission = new AdmissionController(
      testConfig({ EXEC_MAX_ACTIVE_REQUESTS: '2', EXEC_MAX_INFLIGHT_INPUT_BYTES: '10' }).exec,
      testMetrics(),
    );
    const first = admission.tryAcquireRequest();
    const second = admission.tryAcquireRequest();
    if ('rejected' in first || 'rejected' in second) {
      throw new Error('expected both requests to be admitted');
    }

    expect(first.reserveInputBytes(6)).toBeNull();
    expect(second.reserveInputBytes(5)).toEqual({ rejected: 'input_bytes' });
    first.release();
    expect(second.reserveInputBytes(5)).toBeNull();
  });
});

import { render, act } from '@testing-library/react';
import { datadogRum } from '@datadog/browser-rum';
import { datadogLogs } from '@datadog/browser-logs';
import KnaufDatadogRum from './KnaufDatadogRum';

jest.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: jest.fn(),
    setTrackingConsent: jest.fn(),
  },
}));

jest.mock('@datadog/browser-logs', () => ({
  datadogLogs: {
    init: jest.fn(),
    setTrackingConsent: jest.fn(),
  },
}));

jest.mock('./config', () => ({
  getRumConfig: jest.fn(() => ({ applicationId: 'test', clientToken: 'pub-test' })),
  getLogsConfig: jest.fn(() => ({ clientToken: 'pub-test' })),
}));

const mockIsRumEnabled = jest.fn(() => true);
const mockIsLogsEnabled = jest.fn(() => true);
const mockIsDatadogEnabled = jest.fn(() => true);

jest.mock('./isEnabled', () => ({
  isRumEnabled: (...args: unknown[]) => mockIsRumEnabled(...args),
  isLogsEnabled: (...args: unknown[]) => mockIsLogsEnabled(...args),
  isDatadogEnabled: (...args: unknown[]) => mockIsDatadogEnabled(...args),
}));

describe('KnaufDatadogRum', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRumEnabled.mockReturnValue(true);
    mockIsLogsEnabled.mockReturnValue(true);
    mockIsDatadogEnabled.mockReturnValue(true);
  });

  // Note: The component uses an initializedRef to prevent double-init.
  // Because we can't reset a ref without resetModules (which breaks React hooks),
  // the first test that renders will "consume" the init. Subsequent tests in
  // this suite will see the ref as already initialized. We test init behavior
  // first, then consent behavior (which doesn't depend on init).

  it('initializes RUM and Logs when enabled', () => {
    render(<KnaufDatadogRum />);

    expect(datadogRum.init).toHaveBeenCalledTimes(1);
    expect(datadogLogs.init).toHaveBeenCalledTimes(1);
  });

  it('renders nothing (returns null)', () => {
    const { container } = render(<KnaufDatadogRum />);
    expect(container.innerHTML).toBe('');
  });

  it('syncs consent to granted on OneTrustGroupsUpdated with C0002', () => {
    (globalThis as Record<string, unknown>).OnetrustActiveGroups = ',C0001,C0002,';

    render(<KnaufDatadogRum />);

    act(() => {
      globalThis.dispatchEvent(new Event('OneTrustGroupsUpdated'));
    });

    expect(datadogRum.setTrackingConsent).toHaveBeenCalledWith('granted');
    expect(datadogLogs.setTrackingConsent).toHaveBeenCalledWith('granted');

    delete (globalThis as Record<string, unknown>).OnetrustActiveGroups;
  });

  it('syncs consent to not-granted when C0002 is absent', () => {
    (globalThis as Record<string, unknown>).OnetrustActiveGroups = ',C0001,';

    render(<KnaufDatadogRum />);

    act(() => {
      globalThis.dispatchEvent(new Event('OneTrustGroupsUpdated'));
    });

    expect(datadogRum.setTrackingConsent).toHaveBeenCalledWith('not-granted');

    delete (globalThis as Record<string, unknown>).OnetrustActiveGroups;
  });
});

describe('KnaufDatadogRum (disabled)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRumEnabled.mockReturnValue(false);
    mockIsLogsEnabled.mockReturnValue(false);
    mockIsDatadogEnabled.mockReturnValue(false);
  });

  it('does not initialize when disabled', () => {
    render(<KnaufDatadogRum />);

    expect(datadogRum.init).not.toHaveBeenCalled();
    expect(datadogLogs.init).not.toHaveBeenCalled();
  });
});

import { render, act } from '@testing-library/react';
import { datadogRum } from '@datadog/browser-rum';
import { datadogLogs } from '@datadog/browser-logs';
import KnaufDatadogRum from './KnaufDatadogRum';
import type { DatadogConfig } from '../types';

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

const enabledConfig: DatadogConfig = {
  clientToken: 'pub-test',
  site: 'datadoghq.eu',
  service: 'agentic-karl',
  env: 'prod',
  rumEnabled: true,
  browserLogsEnabled: true,
  rumApplicationId: 'test-app-id',
};

const disabledConfig: DatadogConfig = {
  ...enabledConfig,
  rumEnabled: false,
  browserLogsEnabled: false,
};

let mockStartupConfig: Record<string, unknown> = {};

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

describe('KnaufDatadogRum', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartupConfig = { knauf: { datadog: enabledConfig } };
  });

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
    mockStartupConfig = { knauf: { datadog: disabledConfig } };
  });

  it('does not initialize when disabled', () => {
    render(<KnaufDatadogRum />);

    expect(datadogRum.init).not.toHaveBeenCalled();
    expect(datadogLogs.init).not.toHaveBeenCalled();
  });
});

describe('KnaufDatadogRum (no config)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartupConfig = {};
  });

  it('does not initialize when datadog config is absent', () => {
    render(<KnaufDatadogRum />);

    expect(datadogRum.init).not.toHaveBeenCalled();
    expect(datadogLogs.init).not.toHaveBeenCalled();
  });
});

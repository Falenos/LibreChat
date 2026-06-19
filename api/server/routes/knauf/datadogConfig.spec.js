const mockWarn = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: (...args) => mockWarn(...args),
  },
}));

const { getKnaufDatadogConfig } = require('./datadogConfig');

const DATADOG_ENV_KEYS = [
  'DATADOG_RUM_ENABLED',
  'DATADOG_BROWSER_LOGS_ENABLED',
  'DATADOG_CLIENT_TOKEN',
  'DATADOG_SITE',
  'DATADOG_SERVICE',
  'DATADOG_ENV',
  'DATADOG_RUM_APPLICATION_ID',
  'DATADOG_RUM_SESSION_SAMPLE_RATE',
];

afterEach(() => {
  jest.clearAllMocks();
  for (const key of DATADOG_ENV_KEYS) {
    delete process.env[key];
  }
});

describe('getKnaufDatadogConfig', () => {
  it('returns full config when all vars are set and RUM is enabled', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_SERVICE = 'agentic-karl';
    process.env.DATADOG_ENV = 'prod';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';

    expect(getKnaufDatadogConfig()).toEqual({
      clientToken: 'pub-test-token',
      site: 'datadoghq.eu',
      service: 'agentic-karl',
      env: 'prod',
      rumEnabled: true,
      browserLogsEnabled: true,
      rumApplicationId: 'test-app-id',
    });
  });

  it('returns config without rumApplicationId when only browser logs enabled', () => {
    process.env.DATADOG_RUM_ENABLED = 'false';
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_SERVICE = 'agentic-karl';
    process.env.DATADOG_ENV = 'dev';

    const config = getKnaufDatadogConfig();
    expect(config).toEqual({
      clientToken: 'pub-test-token',
      site: 'datadoghq.eu',
      service: 'agentic-karl',
      env: 'dev',
      rumEnabled: false,
      browserLogsEnabled: true,
    });
    expect(config.rumApplicationId).toBeUndefined();
  });

  it('returns undefined when both RUM and browser logs are disabled', () => {
    process.env.DATADOG_RUM_ENABLED = 'false';
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'false';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';

    expect(getKnaufDatadogConfig()).toBeUndefined();
  });

  it('returns undefined when no env vars are set', () => {
    expect(getKnaufDatadogConfig()).toBeUndefined();
  });

  it('returns undefined and warns when client token is missing', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';

    expect(getKnaufDatadogConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('DATADOG_CLIENT_TOKEN and DATADOG_SITE are required'),
    );
  });

  it('returns undefined and warns when site is missing', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';

    expect(getKnaufDatadogConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('DATADOG_CLIENT_TOKEN and DATADOG_SITE are required'),
    );
  });

  it('returns undefined and warns when RUM is enabled but application ID is missing', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';

    expect(getKnaufDatadogConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('DATADOG_RUM_APPLICATION_ID is required when RUM is enabled'),
    );
  });

  it('uses default service name when DATADOG_SERVICE is unset', () => {
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_ENV = 'dev';

    expect(getKnaufDatadogConfig()).toEqual(
      expect.objectContaining({ service: 'agentic-karl' }),
    );
  });

  it('uses "unknown" env when DATADOG_ENV is unset', () => {
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';

    expect(getKnaufDatadogConfig()).toEqual(
      expect.objectContaining({ env: 'unknown' }),
    );
  });

  it('passes sessionSampleRate when DATADOG_RUM_SESSION_SAMPLE_RATE is set', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';
    process.env.DATADOG_RUM_SESSION_SAMPLE_RATE = '25';

    const config = getKnaufDatadogConfig();
    expect(config.sessionSampleRate).toBe(25);
  });

  it('omits sessionSampleRate when env var is not set', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';

    const config = getKnaufDatadogConfig();
    expect(config.sessionSampleRate).toBeUndefined();
  });

  it('ignores invalid sessionSampleRate values', () => {
    process.env.DATADOG_RUM_ENABLED = 'true';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';
    process.env.DATADOG_RUM_SESSION_SAMPLE_RATE = 'abc';

    const config = getKnaufDatadogConfig();
    expect(config.sessionSampleRate).toBeUndefined();
  });

  it('treats case-insensitive toggle values', () => {
    process.env.DATADOG_RUM_ENABLED = 'TRUE';
    process.env.DATADOG_BROWSER_LOGS_ENABLED = 'Yes';
    process.env.DATADOG_CLIENT_TOKEN = 'pub-test-token';
    process.env.DATADOG_SITE = 'datadoghq.eu';
    process.env.DATADOG_RUM_APPLICATION_ID = 'test-app-id';

    const config = getKnaufDatadogConfig();
    expect(config.rumEnabled).toBe(true);
    expect(config.browserLogsEnabled).toBe(true);
  });
});

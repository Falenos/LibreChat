const mockWarn = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: (...args) => mockWarn(...args),
  },
}));

const { getKnaufAnalyticsConfig } = require('./analyticsConfig');

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.KNAUF_ANALYTICS_ENABLED;
  delete process.env.KNAUF_ANALYTICS_ENV;
  delete process.env.KNAUF_ONETRUST_SCRIPT_SRC;
  delete process.env.KNAUF_ONETRUST_DOMAIN_SCRIPT_ID;
  delete process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID;
  delete process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL;
  delete process.env.KNAUF_ADOBE_APP_NAME;
});

describe('getKnaufAnalyticsConfig', () => {
  it('returns non-prod OneTrust defaults with the configured Adobe Launch URL', () => {
    process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL =
      'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-5440eaedcac0-development.min.js';

    expect(getKnaufAnalyticsConfig()).toEqual({
      enabled: true,
      oneTrustScriptSrc: 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js',
      oneTrustDomainScriptId: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test',
      consentCategoryId: 'C0002',
      adobeLaunchScriptUrl:
        'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-5440eaedcac0-development.min.js',
      adobeAppName: 'knauf_agentic_karl',
    });
  });

  it('returns the production OneTrust ID while keeping the configured Adobe Launch URL', () => {
    process.env.KNAUF_ANALYTICS_ENV = 'production';
    process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL =
      'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-6532ab2ce849.min.js';

    expect(getKnaufAnalyticsConfig()).toEqual(
      expect.objectContaining({
        oneTrustDomainScriptId: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc',
        adobeLaunchScriptUrl:
          'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-6532ab2ce849.min.js',
      }),
    );
  });

  it('supports explicit deployment overrides', () => {
    process.env.KNAUF_ONETRUST_SCRIPT_SRC = 'https://example.test/onetrust.js';
    process.env.KNAUF_ONETRUST_DOMAIN_SCRIPT_ID = 'domain-script';
    process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID = 'C9999';
    process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL = 'https://example.test/adobe.js';
    process.env.KNAUF_ADOBE_APP_NAME = 'custom_app';

    expect(getKnaufAnalyticsConfig()).toEqual({
      enabled: true,
      oneTrustScriptSrc: 'https://example.test/onetrust.js',
      oneTrustDomainScriptId: 'domain-script',
      consentCategoryId: 'C9999',
      adobeLaunchScriptUrl: 'https://example.test/adobe.js',
      adobeAppName: 'custom_app',
    });
  });

  it('can be disabled for local or emergency rollback', () => {
    process.env.KNAUF_ANALYTICS_ENABLED = 'false';

    expect(getKnaufAnalyticsConfig()).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not expose analytics config when the Adobe Launch URL is missing', () => {
    expect(getKnaufAnalyticsConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('KNAUF_ADOBE_ANALYTICS_SCRIPT_URL is required'),
    );
  });
});

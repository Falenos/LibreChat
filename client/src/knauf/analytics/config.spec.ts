import { getKnaufAnalyticsConfig } from './config';

const completeConfig = {
  knauf: {
    analytics: {
      enabled: true,
      oneTrustScriptSrc: 'https://example.test/onetrust.js',
      oneTrustDomainScriptId: 'domain-script',
      consentCategoryId: 'C0002',
      adobeLaunchScriptUrl: 'https://example.test/adobe.js',
      adobeAppName: 'knauf_agentic_karl',
    },
  },
};

describe('getKnaufAnalyticsConfig', () => {
  it('returns a complete enabled analytics config', () => {
    expect(getKnaufAnalyticsConfig(completeConfig as any)).toEqual(completeConfig.knauf.analytics);
  });

  it('returns null when the analytics config is missing', () => {
    expect(getKnaufAnalyticsConfig({} as any)).toBeNull();
  });

  it('returns null when the analytics config is disabled', () => {
    expect(
      getKnaufAnalyticsConfig({
        knauf: { analytics: { ...completeConfig.knauf.analytics, enabled: false } },
      } as any),
    ).toBeNull();
  });

  it('returns null when a required script field is blank', () => {
    expect(
      getKnaufAnalyticsConfig({
        knauf: { analytics: { ...completeConfig.knauf.analytics, adobeLaunchScriptUrl: ' ' } },
      } as any),
    ).toBeNull();
  });
});

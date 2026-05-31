import type { TStartupConfig } from 'librechat-data-provider';
import type { KnaufAnalyticsConfig, KnaufStartupConfig } from './types';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getKnaufAnalyticsConfig(
  startupConfig?: TStartupConfig | null,
): KnaufAnalyticsConfig | null {
  const analyticsConfig = (startupConfig as KnaufStartupConfig | null | undefined)?.knauf
    ?.analytics;

  if (analyticsConfig?.enabled !== true) {
    return null;
  }

  if (
    !isNonEmptyString(analyticsConfig.oneTrustScriptSrc) ||
    !isNonEmptyString(analyticsConfig.oneTrustDomainScriptId) ||
    !isNonEmptyString(analyticsConfig.consentCategoryId) ||
    !isNonEmptyString(analyticsConfig.adobeLaunchScriptUrl) ||
    !isNonEmptyString(analyticsConfig.adobeAppName)
  ) {
    return null;
  }

  return {
    enabled: true,
    oneTrustScriptSrc: analyticsConfig.oneTrustScriptSrc,
    oneTrustDomainScriptId: analyticsConfig.oneTrustDomainScriptId,
    consentCategoryId: analyticsConfig.consentCategoryId,
    adobeLaunchScriptUrl: analyticsConfig.adobeLaunchScriptUrl,
    adobeAppName: analyticsConfig.adobeAppName,
  };
}

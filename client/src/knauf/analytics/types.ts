import type { TStartupConfig } from 'librechat-data-provider';

export type KnaufAnalyticsConfig = {
  enabled: boolean;
  oneTrustScriptSrc: string;
  oneTrustDomainScriptId: string;
  consentCategoryId: string;
  adobeLaunchScriptUrl: string;
  adobeAppName: string;
};

export type KnaufStartupConfig = TStartupConfig & {
  knauf?: {
    analytics?: Partial<KnaufAnalyticsConfig>;
  };
};

export type OneTrustWindow = Window &
  typeof globalThis & {
    OptanonWrapper?: () => void;
    OptanonActiveGroups?: string;
    OnetrustActiveGroups?: string;
    OneTrust?: {
      changeLanguage?: (language: string) => void;
    };
  };

export type AdobeAnalyticsWindow = Window &
  typeof globalThis & {
    adobeDataLayer?: unknown[];
    _satellite?: {
      track?: (eventName: string, payload?: Record<string, unknown>) => void;
    };
  };

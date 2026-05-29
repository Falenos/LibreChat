import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useGetStartupConfig } from '~/data-provider';
import { emitAdobePageView } from './adobe';
import { getKnaufAnalyticsConfig } from './config';
import { getOneTrustGroupsFromEvent, hasAnalyticsConsent } from './consent';
import { loadExternalScript } from './scriptLoader';
import type { OneTrustWindow } from './types';

const ONE_TRUST_SCRIPT_ID = 'knauf-onetrust-sdk';
const ADOBE_ANALYTICS_SCRIPT_ID = 'knauf-adobe-analytics';
const DEFAULT_ONE_TRUST_LANGUAGE = 'en-US';

export default function KnaufConsentAnalytics() {
  const location = useLocation();
  const { data: startupConfig } = useGetStartupConfig();
  const analyticsConfig = useMemo(() => getKnaufAnalyticsConfig(startupConfig), [startupConfig]);
  const [analyticsConsented, setAnalyticsConsented] = useState(false);
  const [adobeReady, setAdobeReady] = useState(false);
  const lastTrackedPathRef = useRef('');

  const syncConsentState = useCallback(
    (event?: Event) => {
      if (!analyticsConfig) {
        setAnalyticsConsented(false);
        return;
      }

      const oneTrustWindow = window as OneTrustWindow;
      const activeGroups = getOneTrustGroupsFromEvent(event, oneTrustWindow);
      setAnalyticsConsented(hasAnalyticsConsent(activeGroups, analyticsConfig.consentCategoryId));
    },
    [analyticsConfig],
  );

  useEffect(() => {
    if (!analyticsConfig) {
      return;
    }

    const oneTrustWindow = window as OneTrustWindow;
    const previousWrapper = oneTrustWindow.OptanonWrapper;
    const optanonWrapper = () => {
      previousWrapper?.();
      const language = document.documentElement.lang || DEFAULT_ONE_TRUST_LANGUAGE;
      oneTrustWindow.OneTrust?.changeLanguage?.(language);
      syncConsentState();
    };

    oneTrustWindow.OptanonWrapper = optanonWrapper;
    window.addEventListener('OneTrustGroupsUpdated', syncConsentState);
    window.addEventListener('OTConsentApplied', syncConsentState);
    syncConsentState();

    void loadExternalScript({
      id: ONE_TRUST_SCRIPT_ID,
      src: analyticsConfig.oneTrustScriptSrc,
      async: true,
      attributes: {
        charset: 'UTF-8',
        'data-document-language': 'true',
        'data-domain-script': analyticsConfig.oneTrustDomainScriptId,
      },
    });

    return () => {
      window.removeEventListener('OneTrustGroupsUpdated', syncConsentState);
      window.removeEventListener('OTConsentApplied', syncConsentState);
      if (oneTrustWindow.OptanonWrapper === optanonWrapper) {
        oneTrustWindow.OptanonWrapper = previousWrapper;
      }
    };
  }, [analyticsConfig, syncConsentState]);

  useEffect(() => {
    if (!analyticsConfig || !analyticsConsented) {
      setAdobeReady(false);
      lastTrackedPathRef.current = '';
      return;
    }

    let cancelled = false;
    setAdobeReady(false);

    void loadExternalScript({
      id: ADOBE_ANALYTICS_SCRIPT_ID,
      src: analyticsConfig.adobeLaunchScriptUrl,
      async: true,
    })
      .then(() => {
        if (!cancelled) {
          setAdobeReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAdobeReady(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analyticsConfig, analyticsConsented]);

  useEffect(() => {
    if (!analyticsConfig || !analyticsConsented || !adobeReady) {
      return;
    }

    const trackedPath = `${location.pathname}${location.search}${location.hash}`;
    if (lastTrackedPathRef.current === trackedPath) {
      return;
    }

    lastTrackedPathRef.current = trackedPath;
    emitAdobePageView(analyticsConfig, {
      hash: location.hash,
      href: `${window.location.origin}${trackedPath}`,
      pathname: location.pathname,
      search: location.search,
    });
  }, [
    adobeReady,
    analyticsConfig,
    analyticsConsented,
    location.hash,
    location.pathname,
    location.search,
  ]);

  return null;
}

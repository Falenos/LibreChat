import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useGetStartupConfig } from '~/data-provider';
import {
  KNAUF_ADOBE_APP_INTERACTION_EVENT,
  clearAdobeSessionId,
  emitAdobeAppInteraction,
  emitAdobePageView,
  ensureAdobeDataLayer,
  isAdobeAppInteraction,
} from './adobe';
import { getKnaufAnalyticsConfig } from './config';
import {
  formatOneTrustConsentState,
  getOneTrustGroupsFromEvent,
  hasAnalyticsConsent,
} from './consent';
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
  const [consentState, setConsentState] = useState('');
  const [adobeReady, setAdobeReady] = useState(false);
  const lastTrackedPathRef = useRef('');
  const trackedPath = `${location.pathname}${location.search}${location.hash}`;
  const adobeLocation = useMemo(
    () => ({
      hash: location.hash,
      href: `${globalThis.location.origin}${trackedPath}`,
      pathname: location.pathname,
      search: location.search,
    }),
    [location.hash, location.pathname, location.search, trackedPath],
  );

  const syncConsentState = useCallback(
    (event?: Event) => {
      if (!analyticsConfig) {
        setAnalyticsConsented(false);
        setConsentState('');
        return;
      }

      const oneTrustWindow = window as OneTrustWindow;
      const activeGroups = getOneTrustGroupsFromEvent(event, oneTrustWindow);
      setConsentState(formatOneTrustConsentState(activeGroups));
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
      clearAdobeSessionId();
      return;
    }

    let cancelled = false;
    setAdobeReady(false);
    ensureAdobeDataLayer();

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

    if (lastTrackedPathRef.current === trackedPath) {
      return;
    }

    lastTrackedPathRef.current = trackedPath;
    emitAdobePageView(
      analyticsConfig,
      adobeLocation,
      {
        consentState,
      },
    );
  }, [
    adobeReady,
    analyticsConfig,
    analyticsConsented,
    consentState,
    adobeLocation,
    trackedPath,
  ]);

  useEffect(() => {
    if (!analyticsConfig || !analyticsConsented || !adobeReady) {
      return;
    }

    const handleAppInteraction = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isAdobeAppInteraction(detail)) {
        return;
      }

      emitAdobeAppInteraction(analyticsConfig, adobeLocation, detail, {
        consentState,
      });
    };

    globalThis.addEventListener(KNAUF_ADOBE_APP_INTERACTION_EVENT, handleAppInteraction);
    return () => {
      globalThis.removeEventListener(KNAUF_ADOBE_APP_INTERACTION_EVENT, handleAppInteraction);
    };
  }, [adobeLocation, adobeReady, analyticsConfig, analyticsConsented, consentState]);

  return null;
}

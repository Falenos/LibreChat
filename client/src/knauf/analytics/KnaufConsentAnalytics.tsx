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
import {
  getAnalyticsDiagnosticPagePath,
  getAnalyticsScriptDiagnostics,
  reportAnalyticsDiagnostic,
} from './diagnostics';
import { loadExternalScript } from './scriptLoader';
import type { KnaufStartupConfig, OneTrustWindow } from './types';

const ONE_TRUST_SCRIPT_ID = 'knauf-onetrust-sdk';
const ADOBE_ANALYTICS_SCRIPT_ID = 'knauf-adobe-analytics';
const DEFAULT_ONE_TRUST_LANGUAGE = 'en-US';

export default function KnaufConsentAnalytics() {
  const location = useLocation();
  const { data: startupConfig } = useGetStartupConfig();
  const analyticsConfig = useMemo(() => getKnaufAnalyticsConfig(startupConfig), [startupConfig]);
  const rawAnalyticsConfig = (startupConfig as KnaufStartupConfig | undefined)?.knauf?.analytics;
  const rawAnalyticsEnabled = rawAnalyticsConfig?.enabled === true;
  const [analyticsConsented, setAnalyticsConsented] = useState(false);
  const [consentState, setConsentState] = useState('');
  const [adobeReady, setAdobeReady] = useState(false);
  const lastTrackedPathRef = useRef('');
  const reportedInvalidConfigRef = useRef(false);
  const trackedPath = `${location.pathname}${location.search}${location.hash}`;
  const diagnosticPagePath = useMemo(
    () => getAnalyticsDiagnosticPagePath(location.pathname),
    [location.pathname],
  );
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

      const oneTrustWindow = globalThis as OneTrustWindow;
      const activeGroups = getOneTrustGroupsFromEvent(event, oneTrustWindow);
      setConsentState(formatOneTrustConsentState(activeGroups));
      setAnalyticsConsented(hasAnalyticsConsent(activeGroups, analyticsConfig.consentCategoryId));
    },
    [analyticsConfig],
  );

  useEffect(() => {
    if (rawAnalyticsEnabled && !analyticsConfig && !reportedInvalidConfigRef.current) {
      reportedInvalidConfigRef.current = true;
      reportAnalyticsDiagnostic({
        event: 'config_invalid',
        analyticsEnabled: true,
        pagePath: diagnosticPagePath,
        reason: 'startup_config_invalid',
      });
    }

    if (analyticsConfig) {
      reportedInvalidConfigRef.current = false;
    }
  }, [analyticsConfig, diagnosticPagePath, rawAnalyticsEnabled]);

  useEffect(() => {
    if (!analyticsConfig) {
      return;
    }

    const oneTrustWindow = globalThis as OneTrustWindow;
    const previousWrapper = oneTrustWindow.OptanonWrapper;
    const optanonWrapper = () => {
      previousWrapper?.();
      const language = globalThis.document.documentElement.lang || DEFAULT_ONE_TRUST_LANGUAGE;
      oneTrustWindow.OneTrust?.changeLanguage?.(language);
      syncConsentState();
    };

    oneTrustWindow.OptanonWrapper = optanonWrapper;
    globalThis.addEventListener('OneTrustGroupsUpdated', syncConsentState);
    globalThis.addEventListener('OTConsentApplied', syncConsentState);
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
    }).catch(() => {
      reportAnalyticsDiagnostic({
        event: 'onetrust_script_load_failed',
        appName: analyticsConfig.adobeAppName,
        scriptId: ONE_TRUST_SCRIPT_ID,
        ...getAnalyticsScriptDiagnostics(analyticsConfig.oneTrustScriptSrc),
        analyticsEnabled: true,
        reason: 'script_load_error',
      });
    });

    return () => {
      globalThis.removeEventListener('OneTrustGroupsUpdated', syncConsentState);
      globalThis.removeEventListener('OTConsentApplied', syncConsentState);
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
          reportAnalyticsDiagnostic({
            event: 'adobe_launch_script_load_failed',
            appName: analyticsConfig.adobeAppName,
            scriptId: ADOBE_ANALYTICS_SCRIPT_ID,
            ...getAnalyticsScriptDiagnostics(analyticsConfig.adobeLaunchScriptUrl),
            analyticsEnabled: true,
            adobeReady: false,
            reason: 'script_load_error',
          });
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

    try {
      emitAdobePageView(analyticsConfig, adobeLocation, {
        consentState,
      });
      lastTrackedPathRef.current = trackedPath;
    } catch {
      reportAnalyticsDiagnostic({
        event: 'adobe_data_layer_push_failed',
        appName: analyticsConfig.adobeAppName,
        pagePath: diagnosticPagePath,
        analyticsEnabled: true,
        adobeReady: true,
        reason: 'pageview_push_failed',
      });
    }
  }, [
    adobeReady,
    analyticsConfig,
    analyticsConsented,
    consentState,
    adobeLocation,
    diagnosticPagePath,
    trackedPath,
  ]);

  useEffect(() => {
    if (!analyticsConfig || !analyticsConsented || !adobeReady) {
      return;
    }

    const handleAppInteraction = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isAdobeAppInteraction(detail)) {
        reportAnalyticsDiagnostic({
          event: 'adobe_app_interaction_rejected',
          appName: analyticsConfig.adobeAppName,
          pagePath: diagnosticPagePath,
          analyticsEnabled: true,
          adobeReady: true,
          reason: 'invalid_payload',
        });
        return;
      }

      try {
        emitAdobeAppInteraction(analyticsConfig, adobeLocation, detail, {
          consentState,
        });
      } catch {
        reportAnalyticsDiagnostic({
          event: 'adobe_data_layer_push_failed',
          appName: analyticsConfig.adobeAppName,
          pagePath: diagnosticPagePath,
          pageSection: detail.pageSection,
          action: detail.action,
          component: detail.component,
          eventSpecification: detail.eventSpecification,
          analyticsEnabled: true,
          adobeReady: true,
          reason: 'app_interaction_push_failed',
        });
      }
    };

    globalThis.addEventListener(KNAUF_ADOBE_APP_INTERACTION_EVENT, handleAppInteraction);
    return () => {
      globalThis.removeEventListener(KNAUF_ADOBE_APP_INTERACTION_EVENT, handleAppInteraction);
    };
  }, [
    adobeLocation,
    adobeReady,
    analyticsConfig,
    analyticsConsented,
    consentState,
    diagnosticPagePath,
  ]);

  return null;
}

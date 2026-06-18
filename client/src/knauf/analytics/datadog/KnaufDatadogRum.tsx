/**
 * KnaufDatadogRum — initializes Datadog Browser RUM + Logs with OneTrust consent.
 *
 * Mounts once in Root.tsx. Config comes from the startup config API
 * (DATADOG_* env vars → backend → payload.knauf.datadog → this component).
 *
 * Both SDKs start with trackingConsent: 'not-granted' and switch to
 * 'granted' when the user accepts performance cookies (C0002).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { datadogRum } from '@datadog/browser-rum';
import { datadogLogs } from '@datadog/browser-logs';
import { useGetStartupConfig } from '~/data-provider';
import { getRumConfig, getLogsConfig } from './config';
import { isRumEnabled, isLogsEnabled, isDatadogEnabled } from './isEnabled';
import { getOneTrustGroupsFromEvent, hasAnalyticsConsent } from '../consent';
import type { DatadogConfig, KnaufStartupConfig, OneTrustWindow } from '../types';

/** OneTrust performance cookies consent group */
const PERFORMANCE_CONSENT_GROUP = 'C0002';

export default function KnaufDatadogRum() {
  const { data: startupConfig } = useGetStartupConfig();
  const ddConfig = useMemo(
    () => (startupConfig as KnaufStartupConfig | undefined)?.knauf?.datadog as DatadogConfig | undefined,
    [startupConfig],
  );

  const initializedRef = useRef(false);
  const ddConfigRef = useRef(ddConfig);
  ddConfigRef.current = ddConfig;

  const syncConsent = useCallback((event?: Event) => {
    const config = ddConfigRef.current;
    const oneTrustWindow = globalThis as OneTrustWindow;
    const activeGroups = getOneTrustGroupsFromEvent(event, oneTrustWindow);
    const hasConsent = hasAnalyticsConsent(activeGroups, PERFORMANCE_CONSENT_GROUP);
    const consent = hasConsent ? 'granted' : 'not-granted';

    if (isRumEnabled(config)) {
      datadogRum.setTrackingConsent(consent);
    }
    if (isLogsEnabled(config)) {
      datadogLogs.setTrackingConsent(consent);
    }
  }, []);

  useEffect(() => {
    if (!ddConfig || !isDatadogEnabled(ddConfig) || initializedRef.current) {
      return;
    }

    initializedRef.current = true;

    if (isRumEnabled(ddConfig)) {
      datadogRum.init(getRumConfig(ddConfig));
    }

    if (isLogsEnabled(ddConfig)) {
      datadogLogs.init(getLogsConfig(ddConfig));
    }

    // Sync initial consent state (OneTrust may have loaded before us)
    syncConsent();

    // Listen for consent changes
    globalThis.addEventListener('OneTrustGroupsUpdated', syncConsent);
    globalThis.addEventListener('OTConsentApplied', syncConsent);

    return () => {
      globalThis.removeEventListener('OneTrustGroupsUpdated', syncConsent);
      globalThis.removeEventListener('OTConsentApplied', syncConsent);
    };
  }, [ddConfig, syncConsent]);

  return null;
}

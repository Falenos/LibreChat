/**
 * KnaufDatadogRum — initializes Datadog Browser RUM + Logs with OneTrust consent.
 *
 * Mounts once in Root.tsx. Both SDKs start with trackingConsent: 'not-granted'
 * and switch to 'granted' when the user accepts performance cookies (C0002).
 *
 * Enabled on known Knauf hostnames (prod + dev); disabled on localhost and
 * unknown origins. See isEnabled.ts for the hostname gate.
 */
import { useCallback, useEffect, useRef } from 'react';
import { datadogRum } from '@datadog/browser-rum';
import { datadogLogs } from '@datadog/browser-logs';
import { getRumConfig, getLogsConfig } from './config';
import { isRumEnabled, isLogsEnabled, isDatadogEnabled } from './isEnabled';
import { getOneTrustGroupsFromEvent, hasAnalyticsConsent } from '../consent';
import type { OneTrustWindow } from '../types';

/** OneTrust performance cookies consent group */
const PERFORMANCE_CONSENT_GROUP = 'C0002';

export default function KnaufDatadogRum() {
  const initializedRef = useRef(false);

  const syncConsent = useCallback((event?: Event) => {
    const oneTrustWindow = globalThis as OneTrustWindow;
    const activeGroups = getOneTrustGroupsFromEvent(event, oneTrustWindow);
    const hasConsent = hasAnalyticsConsent(activeGroups, PERFORMANCE_CONSENT_GROUP);
    const consent = hasConsent ? 'granted' : 'not-granted';

    if (isRumEnabled()) {
      datadogRum.setTrackingConsent(consent);
    }
    if (isLogsEnabled()) {
      datadogLogs.setTrackingConsent(consent);
    }
  }, []);

  useEffect(() => {
    if (!isDatadogEnabled() || initializedRef.current) {
      return;
    }

    initializedRef.current = true;

    if (isRumEnabled()) {
      datadogRum.init(getRumConfig());
    }

    if (isLogsEnabled()) {
      datadogLogs.init(getLogsConfig());
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
  }, [syncConsent]);

  return null;
}

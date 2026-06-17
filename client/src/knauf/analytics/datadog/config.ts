/**
 * Datadog Browser RUM + Logs configuration with Knauf defaults.
 *
 * Replicates the withDefaultRumConfig / withDefaultLogsConfig patterns
 * from @knauf-group/datadog, adapted for a Vite SPA.
 *
 * All Datadog client credentials are public by design — the client token
 * can only *send* telemetry and has no read/admin capability.  This is the
 * same posture other Knauf apps use with NEXT_PUBLIC_DATADOG_CLIENT_TOKEN.
 *
 * The `env` tag is derived at runtime from the hostname so a single Docker
 * image works across dev / prod without build-arg plumbing.
 */
import type { RumInitConfiguration } from '@datadog/browser-rum';
import type { LogsInitConfiguration } from '@datadog/browser-logs';
import { rumBeforeSend, logsBeforeSend } from './beforeSend';

// ── Public Datadog credentials (same RUM app for all envs) ─────────────
const APPLICATION_ID = '1268732f-53c3-48d0-ac2b-fd564cfefe36';
const CLIENT_TOKEN = 'pubbc77d2e967e9fa2f4a24de29ab0e61c6';
const SITE = 'datadoghq.eu';
const SERVICE = 'agentic-karl';

// ── Known production hostnames ─────────────────────────────────────────
const PROD_HOSTNAMES = ['agentic-karl.knauf.com', 'agentic-karl.agk.prod.knauf.digital'];

/** Derive `env` tag from the current hostname at runtime. */
export function resolveEnv(hostname = globalThis.location?.hostname ?? ''): string {
  if (PROD_HOSTNAMES.includes(hostname)) return 'prod';
  if (hostname.includes('.dev.') || hostname.includes('.nonprod.')) return 'dev';
  return 'local';
}

export function getRumConfig(): RumInitConfiguration {
  return {
    applicationId: APPLICATION_ID,
    clientToken: CLIENT_TOKEN,
    site: SITE,
    service: SERVICE,
    env: resolveEnv(),

    // Knauf defaults (matching @knauf-group/datadog)
    sessionSampleRate: 100,
    sessionReplaySampleRate: 0,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: 'mask-user-input',
    trackingConsent: 'not-granted',
    silentMultipleInit: true,

    beforeSend: rumBeforeSend,
  };
}

export function getLogsConfig(): LogsInitConfiguration {
  return {
    clientToken: CLIENT_TOKEN,
    site: SITE,
    service: SERVICE,
    env: resolveEnv(),

    // Forward only console.error to Datadog Logs
    forwardConsoleLogs: ['error'],
    forwardErrorsToLogs: true,
    trackingConsent: 'not-granted',
    silentMultipleInit: true,

    beforeSend: logsBeforeSend,
  };
}

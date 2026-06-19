/**
 * Datadog Browser RUM + Logs configuration with Knauf defaults.
 *
 * Replicates the withDefaultRumConfig / withDefaultLogsConfig patterns
 * from @knauf-group/datadog, adapted for a Vite SPA.
 *
 * Config is received from the startup config API (DATADOG_* env vars
 * flow through the backend getKnaufDatadogConfig() helper). No hardcoded
 * credentials or hostname-based logic — all values are infra-driven.
 */
import type { RumInitConfiguration } from '@datadog/browser-rum';
import type { LogsInitConfiguration } from '@datadog/browser-logs';
import type { DatadogConfig } from '../types';
import { rumBeforeSend, logsBeforeSend } from './beforeSend';

export function getRumConfig(config: DatadogConfig): RumInitConfiguration {
  return {
    applicationId: config.rumApplicationId ?? '',
    clientToken: config.clientToken,
    site: config.site,
    service: config.service,
    env: config.env,

    // Knauf defaults (matching @knauf-group/datadog)
    sessionSampleRate: config.sessionSampleRate ?? 100,
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

export function getLogsConfig(config: DatadogConfig): LogsInitConfiguration {
  return {
    clientToken: config.clientToken,
    site: config.site,
    service: config.service,
    env: config.env,

    // Forward only console.error to Datadog Logs
    forwardConsoleLogs: ['error'],
    forwardErrorsToLogs: true,
    trackingConsent: 'not-granted',
    silentMultipleInit: true,

    beforeSend: logsBeforeSend,
  };
}

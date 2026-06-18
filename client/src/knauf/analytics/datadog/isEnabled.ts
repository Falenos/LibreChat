/**
 * Feature gates for Datadog Browser RUM and Logs.
 *
 * Enabled/disabled by config flags from the startup config API
 * (DATADOG_RUM_ENABLED / DATADOG_BROWSER_LOGS_ENABLED env vars).
 */
import type { DatadogConfig } from '../types';

export function isRumEnabled(config?: Partial<DatadogConfig> | null): boolean {
  return config?.rumEnabled === true;
}

export function isLogsEnabled(config?: Partial<DatadogConfig> | null): boolean {
  return config?.browserLogsEnabled === true;
}

/** True when at least one of RUM or Logs is enabled */
export function isDatadogEnabled(config?: Partial<DatadogConfig> | null): boolean {
  return isRumEnabled(config) || isLogsEnabled(config);
}

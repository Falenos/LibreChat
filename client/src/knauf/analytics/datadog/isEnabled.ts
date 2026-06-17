/**
 * Feature gates for Datadog Browser RUM and Logs.
 *
 * Enabled automatically on known Knauf hostnames (prod + dev).
 * Disabled on localhost / unknown origins so local dev stays quiet.
 */

const KNOWN_HOSTNAMES = [
  'agentic-karl.knauf.com',
  'agentic-karl.agk.prod.knauf.digital',
  'agentic-karl.agk.dev.knauf.digital',
  'agentic-karl.dev.knauf.digital',
];

export function isKnownHost(hostname = globalThis.location?.hostname ?? ''): boolean {
  return KNOWN_HOSTNAMES.includes(hostname);
}

export function isRumEnabled(hostname?: string): boolean {
  return isKnownHost(hostname);
}

export function isLogsEnabled(hostname?: string): boolean {
  return isKnownHost(hostname);
}

/** True when at least one of RUM or Logs is enabled */
export function isDatadogEnabled(hostname?: string): boolean {
  return isRumEnabled(hostname) || isLogsEnabled(hostname);
}

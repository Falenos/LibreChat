/**
 * Datadog beforeSend filters for RUM events and browser logs.
 *
 * RUM: drops aborted/cancelled network requests and browser-extension noise.
 * Logs: drops non-actionable upstream LibreChat console.error noise, forwarding
 * only errors that are genuinely useful for debugging (network, auth, uncaught).
 */
import type { RumEvent } from '@datadog/browser-rum';
import type { LogsEvent } from '@datadog/browser-logs';

/**
 * Upstream console.error patterns that are non-actionable noise.
 * These fire during normal operation and don't indicate real problems.
 */
const NOISY_LOG_PATTERNS: RegExp[] = [
  // Mermaid diagram rendering failures (expected for malformed user input)
  /mermaid/i,
  // localStorage quota or access errors (expected in private browsing)
  /localStorage/i,
  /QuotaExceeded/i,
  // React error boundaries catching render errors (already handled)
  /error boundary/i,
  // BadgeRowContext provider warnings (non-critical UI)
  /BadgeRowContext/i,
  // HEIC image conversion failures (graceful degradation)
  /heic/i,
  // Preset/conversation cleanup (non-critical housekeeping)
  /cleanupPreset/i,
];

/**
 * RUM beforeSend — drop events that add noise without diagnostic value.
 * Returns false to discard, the (possibly modified) event to keep.
 */
export function rumBeforeSend(event: RumEvent): boolean | RumEvent {
  // Drop aborted/cancelled network requests (status 0 or isAborted flag)
  if (event.type === 'resource') {
    const status = (event.resource as { status_code?: number }).status_code;
    if (status === 0) {
      return false;
    }
  }

  if (event.type === 'error') {
    const message = event.error?.message ?? '';

    // Drop browser-extension "Object Not Found Matching Id" errors
    if (message.includes('Object Not Found Matching Id')) {
      return false;
    }

    // Drop ResizeObserver errors (benign, browser-level)
    if (message.includes('ResizeObserver')) {
      return false;
    }

    // Drop report-type errors (CSP / deprecation reports)
    if ((event.error as { source?: string }).source === 'report') {
      return false;
    }
  }

  return true;
}

/**
 * Logs beforeSend — filter forwarded console.error entries.
 * Only forward actionable errors; drop known upstream noise.
 */
export function logsBeforeSend(log: LogsEvent): boolean | LogsEvent {
  const message = log.message ?? '';

  // Drop known noisy patterns from upstream LibreChat
  for (const pattern of NOISY_LOG_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }

  return true;
}

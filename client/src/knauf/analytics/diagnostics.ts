import { request } from 'librechat-data-provider';

const KNAUF_ANALYTICS_DIAGNOSTICS_ENDPOINT = '/api/knauf/analytics/diagnostics';
const MAX_STRING_LENGTH = 160;
const DIAGNOSTIC_EVENTS = [
  'config_invalid',
  'onetrust_script_load_failed',
  'adobe_launch_script_load_failed',
  'adobe_app_interaction_rejected',
  'adobe_data_layer_push_failed',
] as const;

export type KnaufAnalyticsDiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number];
type StringDiagnosticField =
  | 'appName'
  | 'scriptId'
  | 'scriptHost'
  | 'scriptPath'
  | 'pagePath'
  | 'pageSection'
  | 'action'
  | 'component'
  | 'eventSpecification'
  | 'reason';

export type KnaufAnalyticsDiagnosticPayload = Readonly<{
  event: KnaufAnalyticsDiagnosticEvent;
  appName?: string;
  scriptId?: string;
  scriptHost?: string;
  scriptPath?: string;
  pagePath?: string;
  pageSection?: string;
  action?: string;
  component?: string;
  eventSpecification?: string;
  reason?: string;
  analyticsEnabled?: boolean;
  adobeReady?: boolean;
}>;

const VALID_EVENTS = new Set<string>(DIAGNOSTIC_EVENTS);
const STRING_FIELDS: readonly StringDiagnosticField[] = [
  'appName',
  'scriptId',
  'scriptHost',
  'scriptPath',
  'pagePath',
  'pageSection',
  'action',
  'component',
  'eventSpecification',
  'reason',
];

function normalizeString(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

export function getAnalyticsDiagnosticPagePath(pathname: string): string {
  if (pathname === '/' || pathname === '/c/new' || pathname === '/prompts/new') {
    return pathname;
  }

  if (/^\/c\/[^/]+/.test(pathname)) {
    return '/c/:conversationId';
  }

  if (/^\/prompts\/[^/]+/.test(pathname)) {
    return '/prompts/:promptId';
  }

  if (pathname === '/agents') {
    return pathname;
  }

  if (/^\/agents\/[^/]+/.test(pathname)) {
    return '/agents/:category';
  }

  return pathname.split('?')[0].split('#')[0] || '/';
}

export function getAnalyticsScriptDiagnostics(
  src: string,
): Pick<KnaufAnalyticsDiagnosticPayload, 'scriptHost' | 'scriptPath'> {
  try {
    const url = new URL(src);
    return {
      scriptHost: url.hostname,
      scriptPath: url.pathname,
    };
  } catch {
    return {};
  }
}

function sanitizeStringField(field: StringDiagnosticField, value: unknown): string | undefined {
  if (field === 'pagePath' && typeof value === 'string') {
    return normalizeString(getAnalyticsDiagnosticPagePath(value));
  }

  if (field === 'scriptPath' && typeof value === 'string') {
    return normalizeString(value.split('?')[0].split('#')[0]);
  }

  return normalizeString(value);
}

export function sanitizeAnalyticsDiagnosticPayload(
  payload: KnaufAnalyticsDiagnosticPayload,
): Record<string, string | boolean> | undefined {
  if (!VALID_EVENTS.has(payload.event)) {
    return undefined;
  }

  const sanitizedPayload: Record<string, string | boolean> = {
    event: payload.event,
  };

  for (const field of STRING_FIELDS) {
    const value = sanitizeStringField(field, payload[field]);
    if (value) {
      sanitizedPayload[field] = value;
    }
  }

  if (typeof payload.analyticsEnabled === 'boolean') {
    sanitizedPayload.analyticsEnabled = payload.analyticsEnabled;
  }

  if (typeof payload.adobeReady === 'boolean') {
    sanitizedPayload.adobeReady = payload.adobeReady;
  }

  return sanitizedPayload;
}

export function reportAnalyticsDiagnostic(payload: KnaufAnalyticsDiagnosticPayload): void {
  const pagePath = payload.pagePath ?? getAnalyticsDiagnosticPagePath(globalThis.location.pathname);
  const sanitizedPayload = sanitizeAnalyticsDiagnosticPayload({
    ...payload,
    pagePath,
  });
  if (!sanitizedPayload) {
    return;
  }

  void Promise.resolve()
    .then(() => request.post(KNAUF_ANALYTICS_DIAGNOSTICS_ENDPOINT, sanitizedPayload))
    .catch(() => undefined);
}

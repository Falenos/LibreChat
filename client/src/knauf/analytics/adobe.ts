import type { AdobeAnalyticsWindow, KnaufAnalyticsConfig } from './types';

const ADOBE_PAGE_VIEW_EVENT = 'pageview';
const ADOBE_APP_INTERACTION_EVENT = 'app_interaction';
const ADOBE_PAGE_CATEGORY = 'agentic_karl_page';
const ADOBE_SESSION_STORAGE_KEY = 'knauf_adobe_session_id';
export const KNAUF_ADOBE_APP_INTERACTION_EVENT = 'knauf:adobe-app-interaction';
type AdobePageLocation = Pick<Location, 'hash' | 'href' | 'pathname' | 'search'>;
type EmitAdobeEventOptions = {
  adobeWindow?: AdobeAnalyticsWindow;
  consentState?: string;
};
export type AdobeAppInteraction = Readonly<{
  action: string;
  component: string;
  eventSpecification: string;
  pageSection?: string;
}>;

function getPageDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }

  return parts.slice(-2).join('.');
}

function getPageName(pathname: string): string {
  if (pathname === '/' || pathname === '/c/new') {
    return 'New Chat';
  }

  if (/^\/c\/[^/]+/.test(pathname)) {
    return 'Chat';
  }

  if (pathname.startsWith('/agents')) {
    return 'Agent Marketplace';
  }

  if (pathname.startsWith('/search')) {
    return 'Search';
  }

  if (pathname === '/prompts/new') {
    return 'New Prompt';
  }

  if (pathname.startsWith('/prompts')) {
    return 'Prompt';
  }

  return pathname || 'KARL';
}

function getSafePagePath(pathname: string): string {
  if (pathname === '/' || pathname === '/c/new') {
    return pathname;
  }

  if (/^\/c\/[^/]+/.test(pathname)) {
    return '/c/:conversationId';
  }

  if (pathname === '/prompts/new') {
    return pathname;
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

  return pathname || '/';
}

function getSafeQueryString(search: string): string {
  const params = new URLSearchParams(search);
  const parameterNames = Array.from(new Set(Array.from(params.keys()).filter(Boolean)));

  if (parameterNames.length === 0) {
    return '';
  }

  return `?${parameterNames.map((name) => encodeURIComponent(name)).join('&')}`;
}

function getPageSection(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/c/')) {
    return 'chat';
  }

  const section = pathname.split('/').find(Boolean);
  return section || 'karl';
}

function getPageUrlWithoutQuery(location: AdobePageLocation): string {
  const url = new URL(getSafePagePath(location.pathname), globalThis.location.origin);
  return url.toString();
}

function createSessionId(adobeWindow: AdobeAnalyticsWindow): string {
  const crypto = adobeWindow.crypto;
  const randomUUID = crypto?.randomUUID?.();
  if (randomUUID) {
    return randomUUID;
  }

  if (!crypto?.getRandomValues) {
    throw new Error('Browser Crypto API is unavailable');
  }

  const randomValues = new Uint32Array(4);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, (value) => value.toString(16).padStart(8, '0')).join('-');
}

function getSessionId(adobeWindow: AdobeAnalyticsWindow): string | undefined {
  try {
    const existingSessionId = adobeWindow.sessionStorage?.getItem(ADOBE_SESSION_STORAGE_KEY);
    if (existingSessionId) {
      return existingSessionId;
    }

    const sessionId = createSessionId(adobeWindow);
    adobeWindow.sessionStorage?.setItem(ADOBE_SESSION_STORAGE_KEY, sessionId);
    return sessionId;
  } catch {
    return undefined;
  }
}

export function clearAdobeSessionId(
  adobeWindow: AdobeAnalyticsWindow = globalThis as AdobeAnalyticsWindow,
): void {
  try {
    adobeWindow.sessionStorage?.removeItem(ADOBE_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures; consent state still prevents new pageview events.
  }
}

export function ensureAdobeDataLayer(
  adobeWindow: AdobeAnalyticsWindow = globalThis as AdobeAnalyticsWindow,
): unknown[] {
  adobeWindow.adobeDataLayer = adobeWindow.adobeDataLayer ?? [];
  return adobeWindow.adobeDataLayer;
}

function buildAdobeEventInfo(
  analyticsConfig: KnaufAnalyticsConfig,
  location: AdobePageLocation,
  { adobeWindow = globalThis as AdobeAnalyticsWindow, consentState }: EmitAdobeEventOptions = {},
): Record<string, string> {
  const language =
    globalThis.document.documentElement.lang || globalThis.navigator.language || 'en-US';
  const hostname = globalThis.location.hostname;
  const sessionId = getSessionId(adobeWindow);
  const pageName = getPageName(location.pathname);
  const eventInfo: Record<string, string> = {
    app_name: analyticsConfig.adobeAppName,
    consent_state: consentState ?? '',
    page_category: ADOBE_PAGE_CATEGORY,
    page_domain: getPageDomain(hostname),
    page_hostname: hostname,
    page_locale: language,
    page_name: pageName,
    page_path: getSafePagePath(location.pathname),
    page_query_string: getSafeQueryString(location.search),
    page_section: getPageSection(location.pathname),
    page_title: pageName,
    page_url: getPageUrlWithoutQuery(location),
    user_language: language,
    user_login_status: 'logged_in',
    user_timestamp_iso: new Date().toISOString(),
  };

  if (sessionId) {
    eventInfo.user_session_id = sessionId;
  }

  return eventInfo;
}

export function emitAdobePageView(
  analyticsConfig: KnaufAnalyticsConfig,
  location: AdobePageLocation,
  options: EmitAdobeEventOptions = {},
): void {
  const eventInfo = {
    ...buildAdobeEventInfo(analyticsConfig, location, options),
    action: 'view',
    event_specification: ADOBE_PAGE_VIEW_EVENT,
  };

  const payload = {
    event: ADOBE_PAGE_VIEW_EVENT,
    event_info: eventInfo,
  };

  ensureAdobeDataLayer(options.adobeWindow).push(payload);
}

export function emitAdobeAppInteraction(
  analyticsConfig: KnaufAnalyticsConfig,
  location: AdobePageLocation,
  interaction: AdobeAppInteraction,
  options: EmitAdobeEventOptions = {},
): void {
  const eventInfo = {
    ...buildAdobeEventInfo(analyticsConfig, location, options),
    action: interaction.action,
    component: interaction.component,
    event_specification: interaction.eventSpecification,
    page_section: interaction.pageSection ?? getPageSection(location.pathname),
  };

  const payload = {
    event: ADOBE_APP_INTERACTION_EVENT,
    event_info: eventInfo,
  };

  ensureAdobeDataLayer(options.adobeWindow).push(payload);
}

export function isAdobeAppInteraction(value: unknown): value is AdobeAppInteraction {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const interaction = value as Partial<AdobeAppInteraction>;
  return (
    typeof interaction.action === 'string' &&
    interaction.action.length > 0 &&
    typeof interaction.component === 'string' &&
    interaction.component.length > 0 &&
    typeof interaction.eventSpecification === 'string' &&
    interaction.eventSpecification.length > 0 &&
    (interaction.pageSection === undefined || typeof interaction.pageSection === 'string')
  );
}

export function dispatchAdobeAppInteraction(
  interaction: AdobeAppInteraction,
  adobeWindow: AdobeAnalyticsWindow = globalThis as AdobeAnalyticsWindow,
): void {
  adobeWindow.dispatchEvent(
    new CustomEvent(KNAUF_ADOBE_APP_INTERACTION_EVENT, {
      detail: interaction,
    }),
  );
}

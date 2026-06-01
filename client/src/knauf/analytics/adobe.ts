import type { AdobeAnalyticsWindow, KnaufAnalyticsConfig } from './types';

const ADOBE_PAGE_VIEW_EVENT = 'pageview';
const ADOBE_PAGE_CATEGORY = 'karl_page';
const ADOBE_SESSION_STORAGE_KEY = 'knauf_adobe_session_id';
type AdobePageLocation = Pick<Location, 'hash' | 'href' | 'pathname' | 'search'>;

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

  return pathname || 'KARL';
}

function getPageSection(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/c/')) {
    return 'chat';
  }

  const [section] = pathname.split('/').filter(Boolean);
  return section || 'karl';
}

function getPageUrlWithoutQuery(location: AdobePageLocation): string {
  const url = new URL(location.href, window.location.origin);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function createSessionId(adobeWindow: AdobeAnalyticsWindow): string {
  return (
    adobeWindow.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
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

export function clearAdobeSessionId(adobeWindow: AdobeAnalyticsWindow = window): void {
  try {
    adobeWindow.sessionStorage?.removeItem(ADOBE_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures; consent state still prevents new pageview events.
  }
}

export function ensureAdobeDataLayer(adobeWindow: AdobeAnalyticsWindow = window): unknown[] {
  adobeWindow.adobeDataLayer = adobeWindow.adobeDataLayer ?? [];
  return adobeWindow.adobeDataLayer;
}

export function emitAdobePageView(
  analyticsConfig: KnaufAnalyticsConfig,
  location: AdobePageLocation,
  adobeWindow: AdobeAnalyticsWindow = window,
): void {
  const language = document.documentElement.lang || window.navigator.language || 'en-US';
  const hostname = window.location.hostname;
  const sessionId = getSessionId(adobeWindow);
  const eventInfo: Record<string, string> = {
    action: 'view',
    app_name: analyticsConfig.adobeAppName,
    event_specification: ADOBE_PAGE_VIEW_EVENT,
    page_category: ADOBE_PAGE_CATEGORY,
    page_domain: getPageDomain(hostname),
    page_hostname: hostname,
    page_locale: language,
    page_name: getPageName(location.pathname),
    page_path: location.pathname,
    page_query_string: location.search,
    page_section: getPageSection(location.pathname),
    page_title: document.title,
    page_url: getPageUrlWithoutQuery(location),
    user_language: language,
    user_login_status: 'logged_in',
    user_timestamp_iso: new Date().toISOString(),
  };

  if (sessionId) {
    eventInfo.user_session_id = sessionId;
  }

  const payload = {
    event: ADOBE_PAGE_VIEW_EVENT,
    event_info: eventInfo,
  };

  ensureAdobeDataLayer(adobeWindow).push(payload);
}

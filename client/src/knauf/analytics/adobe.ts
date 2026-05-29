import type { AdobeAnalyticsWindow, KnaufAnalyticsConfig } from './types';

const ADOBE_PAGE_VIEW_EVENT = 'pageview';
type AdobePageLocation = Pick<Location, 'hash' | 'href' | 'pathname' | 'search'>;

function getPageDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }

  return parts.slice(-2).join('.');
}

export function emitAdobePageView(
  analyticsConfig: KnaufAnalyticsConfig,
  location: AdobePageLocation,
  adobeWindow: AdobeAnalyticsWindow = window,
): void {
  const pagePath = `${location.pathname}${location.search}${location.hash}`;
  const language = document.documentElement.lang || window.navigator.language || 'en-US';
  const hostname = window.location.hostname;
  const payload = {
    event: ADOBE_PAGE_VIEW_EVENT,
    event_info: {
      action: 'view',
      app_name: analyticsConfig.adobeAppName,
      event_specification: ADOBE_PAGE_VIEW_EVENT,
      page_category: analyticsConfig.adobeAppName,
      page_domain: getPageDomain(hostname),
      page_hostname: hostname,
      page_locale: language,
      page_name: pagePath,
      page_path: pagePath,
      page_query_string: location.search.replace(/^\?/, ''),
      page_section: 'chat',
      page_title: document.title,
      page_url: location.href,
      user_language: language,
      user_login_status: 'logged_in',
    },
  };

  adobeWindow.adobeDataLayer = adobeWindow.adobeDataLayer ?? [];
  adobeWindow.adobeDataLayer.push(payload);
}

import { emitAdobePageView } from './adobe';
import type { AdobeAnalyticsWindow, KnaufAnalyticsConfig } from './types';

const analyticsConfig: KnaufAnalyticsConfig = {
  enabled: true,
  oneTrustScriptSrc: 'https://example.test/onetrust.js',
  oneTrustDomainScriptId: 'domain-script',
  consentCategoryId: 'C0002',
  adobeLaunchScriptUrl: 'https://example.test/adobe.js',
  adobeAppName: 'knauf_agentic_karl',
};

function makeAdobeWindow() {
  return {
    adobeDataLayer: [],
    crypto: globalThis.crypto,
    sessionStorage: window.sessionStorage,
  } as unknown as AdobeAnalyticsWindow;
}

describe('Adobe analytics payload privacy', () => {
  beforeEach(() => {
    document.title = 'Customer issue from generated chat title';
    window.sessionStorage.clear();
  });

  it('uses route-safe page metadata instead of chat-derived titles or raw ids', () => {
    const adobeWindow = makeAdobeWindow();

    emitAdobePageView(
      analyticsConfig,
      {
        hash: '',
        href: 'http://localhost:3080/c/convo-secret?q=customer%20issue&source=test',
        pathname: '/c/convo-secret',
        search: '?q=customer%20issue&source=test',
      },
      {
        adobeWindow,
        consentState: ',C0001,C0002,',
      },
    );

    expect(adobeWindow.adobeDataLayer).toEqual([
      expect.objectContaining({
        event: 'pageview',
        event_info: expect.objectContaining({
          consent_state: ',C0001,C0002,',
          page_name: 'Chat',
          page_path: '/c/:conversationId',
          page_query_string: '?q&source',
          page_title: 'Chat',
          page_url: 'http://localhost:3080/c/:conversationId',
        }),
      }),
    ]);
    expect((adobeWindow.adobeDataLayer?.[0] as { event_info: Record<string, string> }).event_info)
      .not.toHaveProperty('consent_status');
  });

  it('redacts prompt ids and query values on prompt routes', () => {
    const adobeWindow = makeAdobeWindow();

    emitAdobePageView(
      analyticsConfig,
      {
        hash: '',
        href: 'http://localhost:3080/prompts/prompt-sensitive-id?search=private',
        pathname: '/prompts/prompt-sensitive-id',
        search: '?search=private',
      },
      { adobeWindow },
    );

    expect(adobeWindow.adobeDataLayer).toEqual([
      expect.objectContaining({
        event_info: expect.objectContaining({
          page_path: '/prompts/:promptId',
          page_query_string: '?search',
          page_name: 'Prompt',
          page_title: 'Prompt',
          page_url: 'http://localhost:3080/prompts/:promptId',
        }),
      }),
    ]);
  });
});

import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KnaufConsentAnalytics from './KnaufConsentAnalytics';
import { resetExternalScriptForTest } from './scriptLoader';

const mockUseGetStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

const startupConfig = {
  knauf: {
    analytics: {
      enabled: true,
      oneTrustScriptSrc: 'https://example.test/onetrust.js',
      oneTrustDomainScriptId: 'domain-script',
      consentCategoryId: 'C0002',
      adobeLaunchScriptUrl: 'https://example.test/adobe.js',
      adobeAppName: 'knauf_karl',
    },
  },
};

function renderController(initialEntry = '/c/new') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <KnaufConsentAnalytics />
    </MemoryRouter>,
  );
}

function finishScriptLoad(id: string) {
  const script = document.getElementById(id);
  if (!script) {
    throw new Error(`Expected script ${id} to be present`);
  }

  act(() => {
    script.dispatchEvent(new Event('load'));
  });
}

describe('KnaufConsentAnalytics', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReturnValue({ data: startupConfig });
    delete (window as any).OnetrustActiveGroups;
    delete (window as any).OptanonWrapper;
    delete (window as any).OneTrust;
    delete (window as any).adobeDataLayer;
    delete (window as any)._satellite;
    window.sessionStorage.clear();
    resetExternalScriptForTest('knauf-onetrust-sdk');
    resetExternalScriptForTest('knauf-adobe-analytics');
  });

  it('does nothing when analytics config is disabled', async () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });

    renderController();

    expect(document.getElementById('knauf-onetrust-sdk')).not.toBeInTheDocument();
    expect(document.getElementById('knauf-adobe-analytics')).not.toBeInTheDocument();
  });

  it('loads OneTrust but not Adobe before analytics consent', async () => {
    (window as any).OnetrustActiveGroups = ',C0001,';

    renderController();

    await waitFor(() => {
      expect(document.getElementById('knauf-onetrust-sdk')).toBeInTheDocument();
    });
    expect(document.getElementById('knauf-adobe-analytics')).not.toBeInTheDocument();
    expect((window as any).adobeDataLayer).toBeUndefined();
  });

  it('loads Adobe and emits a page view when analytics consent is granted', async () => {
    renderController('/c/new?source=test');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', { detail: ['C0001', 'C0002'] }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    expect((window as any).adobeDataLayer).toBeUndefined();

    finishScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect((window as any).adobeDataLayer).toHaveLength(1);
    });
    expect((window as any).adobeDataLayer).toEqual([
      expect.objectContaining({
        event: 'pageview',
        event_info: expect.objectContaining({
          app_name: 'knauf_karl',
          event_specification: 'pageview',
          page_category: 'karl_page',
          page_name: 'New Chat',
          page_path: '/c/new',
          page_query_string: '?source=test',
          page_section: 'chat',
          page_url: 'http://localhost:3080/c/new',
          user_login_status: 'logged_in',
          user_session_id: expect.any(String),
          user_timestamp_iso: expect.any(String),
        }),
      }),
    ]);
  });

  it('stops emitting page views after analytics consent is revoked', async () => {
    renderController('/c/new');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', { detail: ['C0001', 'C0002'] }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    finishScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect((window as any).adobeDataLayer).toHaveLength(1);
    });
    expect(window.sessionStorage.getItem('knauf_adobe_session_id')).toEqual(expect.any(String));

    act(() => {
      window.dispatchEvent(new CustomEvent('OneTrustGroupsUpdated', { detail: ['C0001'] }));
    });

    expect((window as any).adobeDataLayer).toHaveLength(1);
    expect(window.sessionStorage.getItem('knauf_adobe_session_id')).toBeNull();
  });
});

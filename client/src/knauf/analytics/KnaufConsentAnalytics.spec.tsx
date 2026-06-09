import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KnaufConsentAnalytics from './KnaufConsentAnalytics';
import { dispatchAdobeAppInteraction } from './adobe';
import { resetExternalScriptForTest } from './scriptLoader';

const mockUseGetStartupConfig = jest.fn();
const mockReportAnalyticsDiagnostic = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('./diagnostics', () => {
  const actual = jest.requireActual('./diagnostics');
  return {
    ...actual,
    reportAnalyticsDiagnostic: (...args: unknown[]) => mockReportAnalyticsDiagnostic(...args),
  };
});

const startupConfig = {
  knauf: {
    analytics: {
      enabled: true,
      oneTrustScriptSrc: 'https://example.test/onetrust.js',
      oneTrustDomainScriptId: 'domain-script',
      consentCategoryId: 'C0002',
      adobeLaunchScriptUrl: 'https://example.test/adobe.js',
      adobeAppName: 'knauf_agentic_karl',
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

function failScriptLoad(id: string) {
  const script = document.getElementById(id);
  if (!script) {
    throw new Error(`Expected script ${id} to be present`);
  }

  act(() => {
    script.dispatchEvent(new Event('error'));
  });
}

describe('KnaufConsentAnalytics', () => {
  beforeEach(() => {
    mockReportAnalyticsDiagnostic.mockClear();
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
    expect(mockReportAnalyticsDiagnostic).not.toHaveBeenCalled();
  });

  it('loads OneTrust but not Adobe before analytics consent', async () => {
    (window as any).OnetrustActiveGroups = ',C0001,';

    renderController();

    await waitFor(() => {
      expect(document.getElementById('knauf-onetrust-sdk')).toBeInTheDocument();
    });
    expect(document.getElementById('knauf-adobe-analytics')).not.toBeInTheDocument();
    expect((window as any).adobeDataLayer).toBeUndefined();
    expect(mockReportAnalyticsDiagnostic).not.toHaveBeenCalled();
  });

  it('loads Adobe and emits a page view when analytics consent is granted', async () => {
    renderController('/c/new?source=test');
    document.title = 'Sensitive conversation-derived title';

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', {
          detail: ['C0001', 'C0002'],
        }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    expect((window as any).adobeDataLayer).toEqual([]);

    finishScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect((window as any).adobeDataLayer).toHaveLength(1);
    });
    expect((window as any).adobeDataLayer).toEqual([
      expect.objectContaining({
        event: 'pageview',
        event_info: expect.objectContaining({
          app_name: 'knauf_agentic_karl',
          consent_state: ',C0001,C0002,',
          event_specification: 'pageview',
          page_category: 'agentic_karl_page',
          page_name: 'New Chat',
          page_path: '/c/new',
          page_query_string: '?source',
          page_section: 'chat',
          page_title: 'New Chat',
          page_url: 'http://localhost:3080/c/new',
          user_login_status: 'logged_in',
          user_session_id: expect.any(String),
          user_timestamp_iso: expect.any(String),
        }),
      }),
    ]);
    expect((window as any).adobeDataLayer[0].event_info).not.toHaveProperty('consent_status');
    expect(mockReportAnalyticsDiagnostic).not.toHaveBeenCalled();
  });

  it('stops emitting page views after analytics consent is revoked', async () => {
    renderController('/c/new');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', {
          detail: ['C0001', 'C0002'],
        }),
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

  it('emits app interaction events through the consent-gated Adobe data layer', async () => {
    renderController('/c/new');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', {
          detail: ['C0001', 'C0002'],
        }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    finishScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect((window as any).adobeDataLayer).toHaveLength(1);
    });

    act(() => {
      dispatchAdobeAppInteraction({
        action: 'enable_image_generation',
        component: 'chat_tools',
        eventSpecification: 'enable_image_generation',
        pageSection: 'chat',
      });
    });

    await waitFor(() => {
      expect((window as any).adobeDataLayer).toHaveLength(2);
    });
    expect((window as any).adobeDataLayer[1]).toEqual(
      expect.objectContaining({
        event: 'app_interaction',
        event_info: expect.objectContaining({
          action: 'enable_image_generation',
          app_name: 'knauf_agentic_karl',
          component: 'chat_tools',
          consent_state: ',C0001,C0002,',
          event_specification: 'enable_image_generation',
          page_category: 'agentic_karl_page',
          page_section: 'chat',
          user_login_status: 'logged_in',
        }),
      }),
    );
    expect(mockReportAnalyticsDiagnostic).not.toHaveBeenCalled();
  });

  it('reports invalid startup analytics config', async () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        knauf: {
          analytics: {
            enabled: true,
          },
        },
      },
    });

    renderController('/c/new');

    await waitFor(() => {
      expect(mockReportAnalyticsDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'config_invalid',
          reason: 'startup_config_invalid',
        }),
      );
    });
    expect(document.getElementById('knauf-onetrust-sdk')).not.toBeInTheDocument();
  });

  it('reports OneTrust script load failures', async () => {
    renderController('/c/new');

    await waitFor(() => {
      expect(document.getElementById('knauf-onetrust-sdk')).toBeInTheDocument();
    });
    failScriptLoad('knauf-onetrust-sdk');

    await waitFor(() => {
      expect(mockReportAnalyticsDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'onetrust_script_load_failed',
          reason: 'script_load_error',
          scriptHost: 'example.test',
          scriptId: 'knauf-onetrust-sdk',
          scriptPath: '/onetrust.js',
        }),
      );
    });
  });

  it('reports Adobe Launch script load failures', async () => {
    renderController('/c/new');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', {
          detail: ['C0001', 'C0002'],
        }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    failScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect(mockReportAnalyticsDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'adobe_launch_script_load_failed',
          reason: 'script_load_error',
          scriptHost: 'example.test',
          scriptId: 'knauf-adobe-analytics',
          scriptPath: '/adobe.js',
        }),
      );
    });
  });

  it('reports data layer push failures without retrying successful diagnostics', async () => {
    (window as any).adobeDataLayer = {
      push: jest.fn(() => {
        throw new Error('push failed');
      }),
    };
    renderController('/c/new');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('OneTrustGroupsUpdated', {
          detail: ['C0001', 'C0002'],
        }),
      );
    });

    await waitFor(() => {
      expect(document.getElementById('knauf-adobe-analytics')).toBeInTheDocument();
    });
    finishScriptLoad('knauf-adobe-analytics');

    await waitFor(() => {
      expect(mockReportAnalyticsDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'adobe_data_layer_push_failed',
          pagePath: '/c/new',
          reason: 'pageview_push_failed',
        }),
      );
    });
  });
});

import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import Root from '~/routes/Root';

const mockUseAuthContext = jest.fn();
const mockUseGetStartupConfig = jest.fn();
const mockUseUserTermsQuery = jest.fn();

jest.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
  // v0.8.7: Root's dependency graph now calls useNavigate.
  useNavigate: () => jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
}));

jest.mock('~/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories can't reference out-of-scope imports; require() is the standard dodge
  const { atom } = require('recoil');
  return {
    __esModule: true,
    default: {
      sidebarExpanded: atom({ key: 'rootKnaufSidebarExpanded', default: false }),
    },
  };
});

jest.mock('~/hooks', () => ({
  useSearchEnabled: jest.fn(),
  useAssistantsMap: jest.fn(() => ({})),
  useAuthContext: () => mockUseAuthContext(),
  useAgentsMap: jest.fn(() => ({})),
  useFileMap: jest.fn(() => ({})),
  // v0.8.7: Root mounts KeyboardShortcutsProvider → useKeyboardShortcuts, which pulls
  // useLocalize + useHasAccess from the ~/hooks barrel.
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));

jest.mock('~/Providers', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- same constraint as ~/store mock above
  const React = require('react');
  const PassThrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    PromptGroupsProvider: PassThrough,
    SetConvoProvider: PassThrough,
    AssistantsMapContext: React.createContext({}),
    AgentsMapContext: React.createContext({}),
    FileMapContext: React.createContext({}),
  };
});

jest.mock('~/data-provider', () => ({
  useHealthCheck: jest.fn(),
  useGetStartupConfig: () => mockUseGetStartupConfig(),
  useUserTermsQuery: (options: unknown) => mockUseUserTermsQuery(options),
}));

jest.mock('~/components/UnifiedSidebar', () => ({
  UnifiedSidebar: () => <div data-testid="unified-sidebar" />,
}));

jest.mock('~/components/ui', () => ({
  TermsAndConditionsModal: () => null,
}));

jest.mock('~/components/Banners', () => ({
  Banner: () => null,
}));

jest.mock('~/knauf/analytics/KnaufConsentAnalytics', () => ({
  __esModule: true,
  default: () => <div data-testid="knauf-consent-analytics" />,
}));

// KK20-173 — mock the top header so this spec doesn't transitively require
// every hook the real KnaufTopBar pulls in (`useLocalize`, auth, settings
// dialog, etc.). Root.tsx mounts it; we only need its presence here.
jest.mock('~/knauf/components/Header/KnaufTopBar', () => ({
  __esModule: true,
  default: () => <div data-testid="knauf-top-bar" />,
}));

jest.mock('~/knauf/hooks/Auth/useMigrationAccess', () => ({
  useMigrationAccess: () => ({ allowed: true, isLoading: false, isError: false, hasData: true }),
}));

// v0.8.7: Root mounts <KeyboardShortcutsProvider/>, whose useKeyboardShortcuts
// hook now pulls the full new-conversation + react-query stack (useQueryClient,
// useNewConvo, useMatch). This spec only exercises the analytics consent mount,
// so neutralize the shortcuts subtree the same way KnaufTopBar is mocked above.
jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  __esModule: true,
  default: () => {},
}));
jest.mock('~/components/Nav/KeyboardShortcutsDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Nav/KeyboardDeleteDialog', () => ({
  __esModule: true,
  default: () => null,
}));

function renderRoot() {
  return render(
    <RecoilRoot>
      <Root />
    </RecoilRoot>,
  );
}

describe('Root — Knauf analytics mount', () => {
  beforeEach(() => {
    mockUseAuthContext.mockReset();
    mockUseGetStartupConfig.mockReturnValue({ data: { interface: {} } });
    mockUseUserTermsQuery.mockReturnValue({ data: undefined });
  });

  it('mounts the consent analytics controller only after authentication when EULA is not required', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: true, logout: jest.fn() });

    renderRoot();

    expect(screen.getByTestId('knauf-consent-analytics')).toBeInTheDocument();
    expect(mockUseUserTermsQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('does not mount the consent analytics controller while unauthenticated', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: false, logout: jest.fn() });

    renderRoot();

    expect(screen.queryByTestId('knauf-consent-analytics')).not.toBeInTheDocument();
  });

  it('does not mount the consent analytics controller before startup config resolves', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: true, logout: jest.fn() });
    mockUseGetStartupConfig.mockReturnValue({ data: undefined });

    renderRoot();

    expect(screen.queryByTestId('knauf-consent-analytics')).not.toBeInTheDocument();
    expect(document.getElementById('knauf-eula-onetrust-guard')).toBeInTheDocument();
    expect(mockUseUserTermsQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('does not mount the consent analytics controller while required EULA is unaccepted', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: true, logout: jest.fn() });
    mockUseGetStartupConfig.mockReturnValue({
      data: { interface: { termsOfService: { modalAcceptance: true } } },
    });
    mockUseUserTermsQuery.mockReturnValue({ data: { termsAccepted: false } });
    const staleOneTrustBanner = document.createElement('div');
    staleOneTrustBanner.id = 'onetrust-banner-sdk';
    document.body.append(staleOneTrustBanner);

    renderRoot();

    expect(screen.queryByTestId('knauf-consent-analytics')).not.toBeInTheDocument();
    expect(document.getElementById('knauf-eula-onetrust-guard')).toBeInTheDocument();
    expect(globalThis.getComputedStyle(staleOneTrustBanner).display).toBe('none');
    expect(mockUseUserTermsQuery).toHaveBeenCalledWith({ enabled: true });
    staleOneTrustBanner.remove();
  });

  it('mounts the consent analytics controller after required EULA acceptance', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: true, logout: jest.fn() });
    mockUseGetStartupConfig.mockReturnValue({
      data: { interface: { termsOfService: { modalAcceptance: true } } },
    });
    mockUseUserTermsQuery.mockReturnValue({ data: { termsAccepted: true } });

    renderRoot();

    expect(screen.getByTestId('knauf-consent-analytics')).toBeInTheDocument();
    expect(document.getElementById('knauf-eula-onetrust-guard')).not.toBeInTheDocument();
    expect(mockUseUserTermsQuery).toHaveBeenCalledWith({ enabled: true });
  });
});

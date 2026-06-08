import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import Root from '~/routes/Root';

const mockUseAuthContext = jest.fn();

jest.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
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
  useGetStartupConfig: () => ({ data: { interface: {} } }),
  useUserTermsQuery: () => ({ data: undefined }),
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
  });

  it('mounts the consent analytics controller only after authentication', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: true, logout: jest.fn() });

    renderRoot();

    expect(screen.getByTestId('knauf-consent-analytics')).toBeInTheDocument();
  });

  it('does not mount the consent analytics controller while unauthenticated', () => {
    mockUseAuthContext.mockReturnValue({ isAuthenticated: false, logout: jest.fn() });

    renderRoot();

    expect(screen.queryByTestId('knauf-consent-analytics')).not.toBeInTheDocument();
  });
});

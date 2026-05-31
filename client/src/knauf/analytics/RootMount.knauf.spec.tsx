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

import React from 'react';

const mockCreateBrowserRouter = jest.fn((routes: unknown, options: unknown) => ({ routes, options }));

jest.mock('react-router-dom', () => ({
  createBrowserRouter: (routes: unknown, options: unknown) =>
    mockCreateBrowserRouter(routes, options),
  Navigate: function MockNavigate() {
    return null;
  },
  Outlet: function MockOutlet() {
    return null;
  },
}));

jest.mock('~/components/Auth', () => ({
  Login: function MockLogin() {
    return null;
  },
  VerifyEmail: function MockVerifyEmail() {
    return null;
  },
  Registration: function MockRegistration() {
    return null;
  },
  ResetPassword: function MockResetPassword() {
    return null;
  },
  ApiErrorWatcher: function MockApiErrorWatcher() {
    return null;
  },
  TwoFactorScreen: function MockTwoFactorScreen() {
    return null;
  },
  RequestPasswordReset: function MockRequestPasswordReset() {
    return null;
  },
}));

jest.mock('~/components/Agents/MarketplaceContext', () => ({
  MarketplaceProvider: function MockMarketplaceProvider() {
    return null;
  },
}));

jest.mock('~/components/Agents/Marketplace', () => ({
  __esModule: true,
  default: function MockAgentMarketplace() {
    return null;
  },
}));

jest.mock('~/components/OAuth', () => ({
  OAuthSuccess: function MockOAuthSuccess() {
    return null;
  },
  OAuthError: function MockOAuthError() {
    return null;
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: function MockAuthContextProvider() {
    return null;
  },
}));

jest.mock('~/knauf/components/Public/UserAgreement', () => ({
  __esModule: true,
  default: function MockUserAgreement() {
    return null;
  },
}));

jest.mock('~/routes/RouteErrorBoundary', () => ({
  __esModule: true,
  default: function MockRouteErrorBoundary() {
    return null;
  },
}));

jest.mock('~/routes/Layouts/Startup', () => ({
  __esModule: true,
  default: function MockStartupLayout() {
    return null;
  },
}));

jest.mock('~/routes/Layouts/Login', () => ({
  __esModule: true,
  default: function MockLoginLayout() {
    return null;
  },
}));

jest.mock('~/routes/Dashboard', () => ({
  __esModule: true,
  default: {
    path: 'dashboard',
    element: null,
  },
}));

jest.mock('~/routes/ShareRoute', () => ({
  __esModule: true,
  default: function MockShareRoute() {
    return null;
  },
}));

jest.mock('~/routes/ChatRoute', () => ({
  __esModule: true,
  default: function MockChatRoute() {
    return null;
  },
}));

jest.mock('~/routes/Search', () => ({
  __esModule: true,
  default: function MockSearch() {
    return null;
  },
}));

jest.mock('~/routes/Root', () => ({
  __esModule: true,
  default: function MockRoot() {
    return null;
  },
}));

type RouteConfig = {
  path?: string;
  element?: React.ReactNode;
  children?: RouteConfig[];
};

function getElementTypeName(element: React.ReactNode): string {
  if (!React.isValidElement(element)) {
    return '';
  }

  return typeof element.type === 'function' ? element.type.name : String(element.type);
}

describe('[knauf] user agreement route mounts', () => {
  beforeEach(() => {
    mockCreateBrowserRouter.mockClear();
    jest.isolateModules(() => {
      require('~/routes/index');
    });
  });

  it('mounts the Knauf user agreement page at /privacy and /eula', () => {
    const routes = mockCreateBrowserRouter.mock.calls[0]?.[0] as RouteConfig[];
    const privacyRoute = routes.find((route) => route.path === 'privacy');
    const eulaRoute = routes.find((route) => route.path === 'eula');

    expect(getElementTypeName(privacyRoute?.element)).toBe('MockUserAgreement');
    expect(getElementTypeName(eulaRoute?.element)).toBe('MockUserAgreement');
  });
});

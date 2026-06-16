import React from 'react';
import { render, screen } from '@testing-library/react';
import AuthLayout from '~/components/Auth/AuthLayout';
import ChatFooter from '~/components/Chat/Footer';

const mockUseGetStartupConfig = jest.fn();

jest.mock('@librechat/client', () => ({
  __esModule: true,
  ThemeSelector: () => <div data-testid="theme-selector" />,
}));

jest.mock('~/components/Banners', () => ({
  Banner: () => null,
}));

jest.mock('~/components/Auth/SocialLoginRender', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Auth/Footer', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    if (key === 'com_ui_logo') {
      return `${values?.[0] ?? ''} Logo`;
    }

    return key;
  },
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

jest.mock('react-gtm-module', () => ({
  initialize: jest.fn(),
}));

describe('[knauf] brand fallbacks', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReset();
  });

  it('uses Agentic Karl for the chat footer when customFooter is absent', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: {} });

    render(<ChatFooter className="flex" />);

    expect(screen.getByText('Agentic Karl')).toBeInTheDocument();
    expect(screen.getByText('Knauf AI Platform')).toBeInTheDocument();
    expect(screen.queryByText(/LibreChat/i)).not.toBeInTheDocument();
  });

  it('uses Agentic Karl for the pre-config auth logo alt text', () => {
    render(
      <AuthLayout
        header={null}
        isFetching={false}
        startupConfig={null}
        startupConfigError={null}
        pathname="/forgot-password"
        error={null}
      >
        <div />
      </AuthLayout>,
    );

    expect(screen.getByAltText('Agentic Karl | Knauf AI Platform Logo')).toBeInTheDocument();
    expect(screen.queryByAltText(/LibreChat/i)).not.toBeInTheDocument();
  });
});

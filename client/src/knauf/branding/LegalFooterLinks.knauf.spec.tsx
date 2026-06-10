import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import AuthFooter from '~/components/Auth/Footer';
import ChatFooter from '~/components/Chat/Footer';

const mockUseGetStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <span>{children}</span>,
}));

jest.mock('react-gtm-module', () => ({
  initialize: jest.fn(),
}));

const startupConfig = {
  customFooter: 'Agentic Karl | Knauf AI Platform',
  interface: {
    privacyPolicy: { externalUrl: '/privacy' },
    termsOfService: { externalUrl: '/privacy' },
  },
} as TStartupConfig;

describe('[knauf] legal footer links', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReset();
  });

  it('renders one combined legal link in the chat footer', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: startupConfig });

    render(<ChatFooter className="flex" />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('com_knauf_terms_and_privacy');
    expect(links[0]).toHaveAttribute('href', '/privacy');
    expect(screen.queryByText('com_ui_privacy_policy')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_terms_of_service')).not.toBeInTheDocument();
  });

  it('renders one combined legal link in the auth footer', () => {
    render(<AuthFooter startupConfig={startupConfig} />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('com_knauf_terms_and_privacy');
    expect(links[0]).toHaveAttribute('href', '/privacy');
    expect(screen.queryByText('com_ui_privacy_policy')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_terms_of_service')).not.toBeInTheDocument();
  });
});

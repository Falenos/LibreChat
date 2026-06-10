import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import UserAgreement from './UserAgreement';

const mockUseGetStartupConfig = jest.fn();
const mockNavigate = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="agreement-content">{children}</div>
  ),
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="back-icon" />,
}));

function renderUserAgreement() {
  return render(
    <MemoryRouter>
      <UserAgreement />
    </MemoryRouter>,
  );
}

describe('[knauf] UserAgreement public page', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReset();
    mockNavigate.mockReset();
  });

  it('renders the configured terms content from startup config', () => {
    mockUseGetStartupConfig.mockReturnValue({
      isFetching: false,
      data: {
        interface: {
          termsOfService: {
            modalContent: ['End User License Agreement (EULA)', 'Knauf Digital GmbH'],
          },
        },
      },
    });

    renderUserAgreement();

    expect(screen.getByTestId('agreement-content')).toHaveTextContent(
      '# End User License Agreement (EULA) Knauf Digital GmbH',
    );
    expect(screen.getByAltText('Knauf')).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(screen.getByRole('button', { name: 'com_ui_back' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'com_auth_login' })).toHaveAttribute(
      'href',
      '/login?redirect=false',
    );
  });

  it('normalizes numbered legal sections into document headings', () => {
    mockUseGetStartupConfig.mockReturnValue({
      isFetching: false,
      data: {
        interface: {
          termsOfService: {
            modalContent: 'End User License Agreement (EULA)\n1. Introduction\nBody text',
          },
        },
      },
    });

    renderUserAgreement();

    expect(screen.getByTestId('agreement-content')).toHaveTextContent(
      '# End User License Agreement (EULA) ## 1. Introduction Body text',
    );
  });

  it('shows the upstream no-content message when terms content is absent', () => {
    mockUseGetStartupConfig.mockReturnValue({
      isFetching: false,
      data: { interface: { termsOfService: {} } },
    });

    renderUserAgreement();

    expect(screen.getByText('com_ui_no_terms_content')).toBeInTheDocument();
  });
});

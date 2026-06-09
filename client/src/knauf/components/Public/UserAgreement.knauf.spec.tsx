import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import UserAgreement from './UserAgreement';

const mockUseGetStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="agreement-content">{content}</div>,
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
      'End User License Agreement (EULA) Knauf Digital GmbH',
    );
    expect(screen.getByRole('link', { name: 'KARL' })).toHaveAttribute(
      'href',
      '/login?redirect=false',
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

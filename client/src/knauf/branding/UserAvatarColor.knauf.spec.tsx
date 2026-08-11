import { render, screen } from '@testing-library/react';
import type { TMessageProps } from '~/common';
import EndpointIcon from '~/components/Endpoints/Icon';
import ShareMessageIcon from '~/components/Share/MessageIcon';

const mockUseAvatar = jest.fn(() => '');

jest.mock('@librechat/client', () => ({
  UserIcon: () => <span data-testid="user-icon" />,
  useAvatar: () => mockUseAvatar(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({
    user: {
      id: 'user-knauf-blue',
      name: 'Zahar Alexandru',
      username: 'zahar',
      avatar: '',
    },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Endpoints/MessageEndpointIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="endpoint-icon" />,
}));

jest.mock('~/components/Endpoints/ConvoIconURL', () => ({
  __esModule: true,
  default: () => <span data-testid="convo-icon-url" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | undefined>) => classes.filter(Boolean).join(' '),
  getIconEndpoint: jest.fn(() => 'openAI'),
  logger: { log: jest.fn() },
}));

describe('User avatar colour — Knauf dark blue', () => {
  beforeEach(() => mockUseAvatar.mockReturnValue(''));

  it('uses Knauf dark blue for the active chat user icon fallback', () => {
    render(<EndpointIcon isCreatedByUser endpoint="openAI" />);

    expect(screen.getByTestId('user-icon').parentElement).toHaveStyle({
      backgroundColor: 'rgb(33, 58, 117)',
    });
  });

  it('uses Knauf dark blue for shared-message user icon fallback', () => {
    render(
      <ShareMessageIcon
        message={{ isCreatedByUser: true } as TMessageProps['message']}
        conversation={null}
      />,
    );

    expect(screen.getByTestId('user-icon').parentElement).toHaveStyle({
      backgroundColor: 'rgb(33, 58, 117)',
    });
  });

  it('keeps the decorative user image out of copied conversation text', () => {
    mockUseAvatar.mockReturnValue('https://example.com/avatar.png');

    const { container } = render(<EndpointIcon isCreatedByUser endpoint="openAI" />);

    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });
});

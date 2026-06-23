/**
 * [knauf] Seam test for the KK20-173 top header (`KnaufTopBar`).
 *
 * Mocks every upstream dependency and pins the Knauf user-menu contract.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import KnaufTopBar from './KnaufTopBar';

const mockUseAuthContext = jest.fn();
const mockUseGetStartupConfig = jest.fn();
const mockUseGetUserBalance = jest.fn();
const mockLogout = jest.fn();
const mockMyFilesModal = jest.fn();
const mockSettings = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => mockUseAuthContext(),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
  useGetUserBalance: (opts: unknown) => mockUseGetUserBalance(opts),
}));

jest.mock('~/components/Chat/Input/Files/MyFilesModal', () => ({
  MyFilesModal: (props: { open: boolean }) => {
    mockMyFilesModal(props);
    return props.open ? <div data-testid="my-files-modal" /> : null;
  },
}));

jest.mock('~/components/Nav/Settings', () => ({
  __esModule: true,
  default: (props: { open: boolean }) => {
    mockSettings(props);
    return props.open ? <div data-testid="settings-dialog" /> : null;
  },
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  Avatar: () => <div data-testid="avatar" />,
  DropdownMenuSeparator: () => <div role="separator" />,
  GearIcon: () => <span aria-label="gear" />,
}));

function setAuth(user = { email: 'jorge@knauf.com', name: 'Jorge' }) {
  mockUseAuthContext.mockReturnValue({
    user,
    isAuthenticated: true,
    logout: mockLogout,
  });
}

function setStartupConfig(overrides: Record<string, unknown> = {}) {
  mockUseGetStartupConfig.mockReturnValue({
    data: {
      helpAndFaqURL: 'https://help.example.com',
      balance: { enabled: false },
      ...overrides,
    },
  });
}

function setBalance(data: { tokenCredits: number } | null = null) {
  mockUseGetUserBalance.mockReturnValue({ data });
}

describe('[knauf] KnaufTopBar — KK20-173 top header user menu', () => {
  const originalWindowOpen = window.open;

  beforeEach(() => {
    mockUseAuthContext.mockReset();
    mockUseGetStartupConfig.mockReset();
    mockUseGetUserBalance.mockReset();
    mockLogout.mockReset();
    mockMyFilesModal.mockReset();
    mockSettings.mockReset();
    setAuth();
    setStartupConfig();
    setBalance(null);
    window.open = jest.fn();
  });

  afterEach(() => {
    window.open = originalWindowOpen;
  });

  it('renders the Knauf logo and the user avatar button', () => {
    render(<KnaufTopBar />);
    const logo = screen.getByAltText('Knauf');
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(screen.getByTestId('avatar')).toBeInTheDocument();
    expect(screen.getByTestId('knauf-topbar-user')).toBeInTheDocument();
  });

  it('opens the dropdown menu when the avatar button is clicked and shows the user email', () => {
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    expect(screen.getByText('jorge@knauf.com')).toBeInTheDocument();
  });

  it('opens the My Files modal when the My Files item is clicked', () => {
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    fireEvent.click(screen.getByText('com_nav_my_files'));
    expect(screen.getByTestId('my-files-modal')).toBeInTheDocument();
  });

  it('hides the Help & FAQ item even when a URL is configured', () => {
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    expect(screen.queryByText('com_nav_help_faq')).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('opens the Settings dialog when the Settings item is clicked', () => {
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    fireEvent.click(screen.getByText('com_nav_settings'));
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('calls the logout mutation when the Log out item is clicked', () => {
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    fireEvent.click(screen.getByText('com_nav_log_out'));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('shows the balance row when balance is enabled and balance data is present', () => {
    setStartupConfig({ balance: { enabled: true } });
    setBalance({ tokenCredits: 1234 });
    render(<KnaufTopBar />);
    fireEvent.click(screen.getByTestId('knauf-topbar-user'));
    expect(screen.getByText(/com_nav_balance/)).toBeInTheDocument();
  });
});

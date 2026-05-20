/**
 * Knauf seam test — admin/simplified builder router (KK20-125 / FEAT-03).
 *
 * Pins the contract of `AgentConfigSwitch`:
 *   - non-admin users always see the simplified Knauf builder;
 *   - admins default to the upstream detailed builder;
 *   - admins with mode === 'simplified' fall back to the Knauf builder.
 *
 * If `AgentConfigSwitch` is replaced or its role/mode logic is reordered,
 * these assertions flip.
 */
import { render, screen } from '@testing-library/react';
import { SystemRoles } from 'librechat-data-provider';

let mockBuilderMode: 'detailed' | 'simplified' = 'detailed';
const mockUseAuthContext = jest.fn();

jest.mock('recoil', () => ({
  useRecoilValue: () => mockBuilderMode,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

jest.mock('~/components/SidePanel/Agents/AgentConfig', () => ({
  __esModule: true,
  default: () => <div data-testid="upstream-agent-config" />,
}));

jest.mock('./KnaufAgentConfig', () => ({
  __esModule: true,
  default: () => <div data-testid="knauf-agent-config" />,
}));

jest.mock('~/knauf/store/builderMode', () => ({
  knaufAdminBuilderModeAtom: { key: 'mock-knaufAdminBuilderMode' },
}));

import AgentConfigSwitch from './AgentConfigSwitch';

describe('AgentConfigSwitch — admin/simplified router (KK20-125)', () => {
  beforeEach(() => {
    mockBuilderMode = 'detailed';
    mockUseAuthContext.mockReset();
  });

  it('renders the Knauf simplified builder for non-admin users regardless of stored mode', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.USER } });
    mockBuilderMode = 'detailed'; // even with the admin default in storage
    render(<AgentConfigSwitch />);

    expect(screen.getByTestId('knauf-agent-config')).toBeInTheDocument();
    expect(screen.queryByTestId('upstream-agent-config')).not.toBeInTheDocument();
  });

  it('renders the upstream detailed builder for admins by default', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.ADMIN } });
    render(<AgentConfigSwitch />);

    expect(screen.getByTestId('upstream-agent-config')).toBeInTheDocument();
    expect(screen.queryByTestId('knauf-agent-config')).not.toBeInTheDocument();
  });

  it('falls back to the Knauf simplified builder when an admin toggles to simplified', () => {
    mockUseAuthContext.mockReturnValue({ user: { role: SystemRoles.ADMIN } });
    mockBuilderMode = 'simplified';
    render(<AgentConfigSwitch />);

    expect(screen.getByTestId('knauf-agent-config')).toBeInTheDocument();
    expect(screen.queryByTestId('upstream-agent-config')).not.toBeInTheDocument();
  });

  it('treats a missing user (signed-out / loading) as non-admin', () => {
    mockUseAuthContext.mockReturnValue({ user: undefined });
    render(<AgentConfigSwitch />);

    expect(screen.getByTestId('knauf-agent-config')).toBeInTheDocument();
  });
});

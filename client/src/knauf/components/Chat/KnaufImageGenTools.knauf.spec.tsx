/**
 * [knauf] Seam test for the visibility gate of KnaufImageGenTools — the
 * image-generation toggle now backed by `useImageGenAvailable`. The
 * component must render nothing when the hook reports unavailability and
 * the popover/chip when it reports availability. The hook's own policy
 * (custom-agent vs default-spec vs kill switch) is covered by its own
 * spec at `client/src/knauf/hooks/Chat/useImageGenAvailable.spec.ts`.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufImageGenTools from './KnaufImageGenTools';

const mockUseImageGenAvailable = jest.fn();
const mockUseToolToggle = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useToolToggle: (opts: unknown) => mockUseToolToggle(opts),
}));

jest.mock('~/knauf/hooks/Chat/useImageGenAvailable', () => ({
  useImageGenAvailable: (args: unknown) => mockUseImageGenAvailable(args),
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  CheckboxButton: ({ label }: { label: string }) => (
    <button type="button" data-testid="image-gen-chip">
      {label}
    </button>
  ),
  DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) => (
    <div data-testid="image-gen-popover">{trigger}</div>
  ),
  PinIcon: () => <span data-testid="pin-icon" />,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));

jest.mock('@ariakit/react', () => ({
  __esModule: true,
  MenuButton: ({ children, ...rest }: React.PropsWithChildren<unknown>) => (
    <button type="button" data-testid="image-gen-trigger" {...rest}>
      {children}
    </button>
  ),
}));

function setToggle(opts: { enabled?: boolean; isPinned?: boolean } = {}) {
  mockUseToolToggle.mockReturnValue({
    toggleState: opts.enabled ?? false,
    debouncedChange: jest.fn(),
    isPinned: opts.isPinned ?? false,
    setIsPinned: jest.fn(),
  });
}

describe('[knauf] KnaufImageGenTools — visibility gate', () => {
  beforeEach(() => {
    mockUseImageGenAvailable.mockReset();
    mockUseToolToggle.mockReset();
  });

  it('renders nothing when useImageGenAvailable returns false', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    const { container } = render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the popover trigger when useImageGenAvailable returns true', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle();
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-popover')).toBeInTheDocument();
    expect(screen.getByTestId('image-gen-trigger')).toBeInTheDocument();
  });

  it('renders the pinned chip when the toggle is pinned and chip is available', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle({ isPinned: true });
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-chip')).toHaveTextContent('com_knauf_create_image');
  });

  it('renders the chip when the toggle is enabled even without a pin', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle({ enabled: true });
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-chip')).toBeInTheDocument();
  });

  it('forwards agentId + spec to the availability hook', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" spec="karl" />);
    expect(mockUseImageGenAvailable).toHaveBeenCalledWith({ agentId: 'agent-x', spec: 'karl' });
  });
});

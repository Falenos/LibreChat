/**
 * [knauf] Seam test for the slimmed `KnaufImageGenTools` chip. The
 * popover/menu-item lives in upstream `ToolsDropdown` now; this component
 * only renders the pinned/toggled CheckboxButton chip in the composer row.
 * Visibility is delegated to `useImageGenAvailable` — that hook's own
 * spec covers the policy branches.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufImageGenTools from './KnaufImageGenTools';

const mockUseImageGenAvailable = jest.fn();
const mockUseToolToggle = jest.fn();
const mockDispatchAdobeAppInteraction = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useToolToggle: (opts: unknown) => mockUseToolToggle(opts),
}));

jest.mock('~/knauf/hooks/Chat/useImageGenAvailable', () => ({
  useImageGenAvailable: (args: unknown) => mockUseImageGenAvailable(args),
}));

jest.mock('~/knauf/analytics/adobe', () => ({
  dispatchAdobeAppInteraction: (payload: unknown) => mockDispatchAdobeAppInteraction(payload),
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  CheckboxButton: ({
    checked,
    label,
    setValue,
  }: {
    checked?: boolean;
    label: string;
    setValue?: (values: { value: boolean }) => void;
  }) => (
    <button type="button" data-testid="image-gen-chip" onClick={() => setValue?.({ value: !checked })}>
      {label}
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

describe('[knauf] KnaufImageGenTools — chip-only visibility', () => {
  beforeEach(() => {
    mockUseImageGenAvailable.mockReset();
    mockUseToolToggle.mockReset();
    mockDispatchAdobeAppInteraction.mockClear();
  });

  it('renders nothing when useImageGenAvailable returns false', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle({ enabled: true, isPinned: true });
    const { container } = render(
      <KnaufImageGenTools agentId={null} conversationId="convo-1" spec="karl" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when available but neither toggled nor pinned', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle({ enabled: false, isPinned: false });
    const { container } = render(
      <KnaufImageGenTools agentId={null} conversationId="convo-1" spec="karl" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the chip when pinned', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle({ isPinned: true });
    render(<KnaufImageGenTools agentId={null} conversationId="convo-1" spec="karl" />);
    expect(screen.getByTestId('image-gen-chip')).toHaveTextContent('com_knauf_create_image');
  });

  it('renders the chip when toggled on even without pin', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle({ enabled: true });
    render(<KnaufImageGenTools agentId={null} conversationId="convo-1" spec="karl" />);
    expect(screen.getByTestId('image-gen-chip')).toBeInTheDocument();
  });

  it('forwards agentId + spec to the availability hook', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" spec="karl" />);
    expect(mockUseImageGenAvailable).toHaveBeenCalledWith({ agentId: 'agent-x', spec: 'karl' });
  });

  it('dispatches an app_interaction when the chip toggles image generation', () => {
    const debouncedChange = jest.fn();
    mockUseImageGenAvailable.mockReturnValue(true);
    mockUseToolToggle.mockReturnValue({
      toggleState: false,
      debouncedChange,
      isPinned: true,
      setIsPinned: jest.fn(),
    });

    render(<KnaufImageGenTools agentId={null} conversationId="convo-1" spec="karl" />);
    screen.getByTestId('image-gen-chip').click();

    expect(debouncedChange).toHaveBeenCalledWith({ e: undefined, value: true });
    expect(mockDispatchAdobeAppInteraction).toHaveBeenCalledWith({
      action: 'enable_image_generation',
      component: 'chat_tools',
      eventSpecification: 'enable_image_generation',
      pageSection: 'chat',
    });
  });
});

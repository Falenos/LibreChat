/**
 * [knauf] Seam test for the visibility gate of KnaufImageGenTools — the
 * agent-chat-only image-generation toggle. The toggle must render nothing
 * when the active agent does not have `image_gen_oai` in its stored
 * tools, and must render a clickable trigger when it does. If either
 * branch flips, this seam (and the user-facing contract) is broken.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufImageGenTools from './KnaufImageGenTools';

const mockUseGetAgentByIdQuery = jest.fn();
const mockUseToolToggle = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useToolToggle: (opts: unknown) => mockUseToolToggle(opts),
}));

jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: (id: unknown) => mockUseGetAgentByIdQuery(id),
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
    mockUseGetAgentByIdQuery.mockReset();
    mockUseToolToggle.mockReset();
  });

  it('renders nothing when the agent does not have image_gen_oai in tools', () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-x', tools: ['file_search', 'web_search'] },
    });
    setToggle();
    const { container } = render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the agent record is not yet loaded', () => {
    mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });
    setToggle();
    const { container } = render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the popover trigger when the agent has image_gen_oai in tools', () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-x', tools: ['file_search', 'image_gen_oai'] },
    });
    setToggle();
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-popover')).toBeInTheDocument();
    expect(screen.getByTestId('image-gen-trigger')).toBeInTheDocument();
  });

  it('renders the pinned chip when the toggle is pinned', () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-x', tools: ['image_gen_oai'] },
    });
    setToggle({ isPinned: true });
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-chip')).toHaveTextContent('com_knauf_create_image');
  });

  it('renders the chip when the toggle is enabled even without a pin', () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-x', tools: ['image_gen_oai'] },
    });
    setToggle({ enabled: true });
    render(<KnaufImageGenTools agentId="agent-x" conversationId="convo-1" />);
    expect(screen.getByTestId('image-gen-chip')).toBeInTheDocument();
  });
});

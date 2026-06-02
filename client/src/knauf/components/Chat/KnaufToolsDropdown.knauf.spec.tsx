/**
 * [knauf] Seam test for `KnaufToolsDropdown`. The wrapper has one job:
 * build the "Create image" `extraItems` payload when `useImageGenAvailable`
 * returns true (and an empty payload otherwise) and forward it to the
 * upstream `ToolsDropdown`. The upstream popover itself isn't re-tested
 * here — the upstream component already covers its own rendering.
 */
import React from 'react';
import { render } from '@testing-library/react';
import KnaufToolsDropdown from './KnaufToolsDropdown';

const mockUseImageGenAvailable = jest.fn();
const mockUseToolToggle = jest.fn();
const mockUseBadgeRowContext = jest.fn();
type UpstreamProps = { disabled?: boolean; extraItems?: unknown[] };
const mockUpstreamToolsDropdown = jest.fn<null, [UpstreamProps]>(() => null);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useToolToggle: (opts: unknown) => mockUseToolToggle(opts),
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => mockUseBadgeRowContext(),
}));

jest.mock('~/knauf/hooks/Chat/useImageGenAvailable', () => ({
  useImageGenAvailable: (args: unknown) => mockUseImageGenAvailable(args),
}));

jest.mock('~/components/Chat/Input/ToolsDropdown', () => ({
  __esModule: true,
  default: (props: { disabled?: boolean; extraItems?: unknown[] }) =>
    mockUpstreamToolsDropdown(props),
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  PinIcon: () => null,
}));

function setToggle() {
  mockUseToolToggle.mockReturnValue({
    toggleState: false,
    debouncedChange: jest.fn(),
    isPinned: false,
    setIsPinned: jest.fn(),
  });
}

function lastUpstreamProps(): UpstreamProps {
  const calls = mockUpstreamToolsDropdown.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) {
    throw new Error('upstream ToolsDropdown was not rendered');
  }
  return last[0];
}

describe('[knauf] KnaufToolsDropdown — extraItems wiring', () => {
  beforeEach(() => {
    mockUseImageGenAvailable.mockReset();
    mockUseToolToggle.mockReset();
    mockUseBadgeRowContext.mockReset();
    mockUpstreamToolsDropdown.mockClear();
    mockUseBadgeRowContext.mockReturnValue({
      specName: 'karl',
      conversationId: 'convo-1',
    });
  });

  it('forwards agentId=null + spec from context to the availability hook', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    render(<KnaufToolsDropdown />);
    expect(mockUseImageGenAvailable).toHaveBeenCalledWith({ agentId: null, spec: 'karl' });
  });

  it('passes an empty extraItems array when image gen is unavailable', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    render(<KnaufToolsDropdown />);
    expect(lastUpstreamProps().extraItems).toEqual([]);
  });

  it('passes a single-item extraItems array when image gen is available', () => {
    mockUseImageGenAvailable.mockReturnValue(true);
    setToggle();
    render(<KnaufToolsDropdown />);
    const items = lastUpstreamProps().extraItems ?? [];
    expect(items).toHaveLength(1);
  });

  it('forwards the disabled prop to the upstream ToolsDropdown', () => {
    mockUseImageGenAvailable.mockReturnValue(false);
    setToggle();
    render(<KnaufToolsDropdown disabled />);
    expect(lastUpstreamProps().disabled).toBe(true);
  });
});

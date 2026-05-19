/**
 * Knauf seam test — sidebar marketplace injection (KK20-124 / FEAT-02).
 *
 * Pins the `[knauf]` block inside `client/src/hooks/Nav/useUnifiedSidebarLinks.ts`:
 *   - when `useShowMarketplace()` returns true, a NavLink with id 'marketplace'
 *     is inserted immediately after the conversations link, with an onClick
 *     that navigates to '/agents';
 *   - when it returns false, the marketplace link is absent.
 *
 * If the seam is removed, these assertions flip.
 */
import { renderHook } from '@testing-library/react';

const mockNavigate = jest.fn();
let mockShowMarketplace = true;
const mockSideNavLinks: Array<{ id: string }> = [];

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => null,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationByIndex: () => ({ key: 'mock-convo' }),
  },
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: () => ({ data: { expiresAt: undefined } }),
}));

jest.mock('librechat-data-provider', () => ({
  getConfigDefaults: () => ({ interface: {} }),
  getEndpointField: () => undefined,
}));

jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/hooks/Nav/useSideNavLinks', () => ({
  __esModule: true,
  default: () => mockSideNavLinks,
}));

jest.mock('~/hooks/Nav/useShowMarketplace', () => ({
  __esModule: true,
  default: () => mockShowMarketplace,
}));

import useUnifiedSidebarLinks from '~/hooks/Nav/useUnifiedSidebarLinks';

describe('useUnifiedSidebarLinks — marketplace seam (KK20-124)', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSideNavLinks.length = 0;
    mockShowMarketplace = true;
  });

  it('injects a marketplace NavLink immediately after the conversations link when useShowMarketplace returns true', () => {
    mockSideNavLinks.push({ id: 'prompts' }, { id: 'bookmarks' });
    const { result } = renderHook(() => useUnifiedSidebarLinks());

    expect(result.current.map((l) => l.id)).toEqual([
      'conversations',
      'marketplace',
      'prompts',
      'bookmarks',
    ]);
  });

  it('omits the marketplace NavLink when useShowMarketplace returns false', () => {
    mockShowMarketplace = false;
    mockSideNavLinks.push({ id: 'prompts' });
    const { result } = renderHook(() => useUnifiedSidebarLinks());

    expect(result.current.map((l) => l.id)).toEqual(['conversations', 'prompts']);
  });

  it('marketplace NavLink onClick navigates to /agents', () => {
    const { result } = renderHook(() => useUnifiedSidebarLinks());
    const marketplaceLink = result.current.find((l) => l.id === 'marketplace');

    expect(marketplaceLink).toBeDefined();
    expect(marketplaceLink?.Component).toBeUndefined();
    marketplaceLink?.onClick?.();
    expect(mockNavigate).toHaveBeenCalledWith('/agents');
  });
});

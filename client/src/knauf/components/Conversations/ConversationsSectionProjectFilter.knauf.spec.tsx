import React from 'react';
import { render } from '@testing-library/react';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';

const mockUseConversationsInfiniteQuery = jest.fn();
let mockSearch = {
  enabled: true,
  query: '',
  debouncedQuery: '',
  isTyping: false,
};

jest.mock('recoil', () => ({
  useSetRecoilState: () => jest.fn(),
  useRecoilValue: () => mockSearch,
}));

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => false,
  useAuthContext: () => ({ isAuthenticated: true }),
  useLocalStorage: () => [true, jest.fn()],
  useNavScrolling: () => ({ moveToTop: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useConversationsInfiniteQuery: (...args: unknown[]) => mockUseConversationsInfiniteQuery(...args),
  useTitleGeneration: jest.fn(),
}));

jest.mock('~/components/Conversations', () => ({ Conversations: () => null }));
jest.mock('~/components/Conversations/ProjectsSection', () => () => null);
jest.mock('~/components/Nav/Favorites/FavoritesList', () => () => null);
jest.mock('~/components/Nav/SearchBar', () => () => null);
jest.mock('~/components/Nav/Bookmarks/BookmarkNav', () => () => null);
jest.mock('~/store', () => ({
  __esModule: true,
  default: { sidebarExpanded: {}, search: {} },
}));

describe('[knauf] project conversations in the sidebar', () => {
  beforeEach(() => {
    mockSearch = {
      enabled: true,
      query: '',
      debouncedQuery: '',
      isTyping: false,
    };
    mockUseConversationsInfiniteQuery.mockReturnValue({
      data: { pages: [{ conversations: [], nextCursor: null }] },
      fetchNextPage: jest.fn(),
      isFetchingNextPage: false,
      isLoading: false,
      isFetching: false,
    });
  });

  it('requests only unassigned conversations for normal chat history', () => {
    render(<ConversationsSection />);

    expect(mockUseConversationsInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'unassigned', search: undefined }),
      expect.any(Object),
    );
  });

  it('keeps message search global across project and unassigned conversations', () => {
    mockSearch = {
      enabled: true,
      query: 'weather',
      debouncedQuery: 'weather',
      isTyping: false,
    };

    render(<ConversationsSection />);

    expect(mockUseConversationsInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined, search: 'weather' }),
      expect.any(Object),
    );
  });
});

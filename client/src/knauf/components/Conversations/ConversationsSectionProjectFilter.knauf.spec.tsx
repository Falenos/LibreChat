import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';

const mockUseConversationsInfiniteQuery = jest.fn();
let mockActiveConversation: TConversation | null = null;
let mockRenderedConversations: TConversation[] = [];
let mockSearch = {
  enabled: true,
  query: '',
  debouncedQuery: '',
  isTyping: false,
};

jest.mock('recoil', () => ({
  useSetRecoilState: () => jest.fn(),
  useRecoilValue: (atom: unknown) =>
    (atom as { key?: string })?.key === 'mock-conversation' ? mockActiveConversation : mockSearch,
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

jest.mock('~/components/Conversations', () => ({
  Conversations: ({ conversations }: { conversations: TConversation[] }) => {
    mockRenderedConversations = conversations;
    return null;
  },
}));
jest.mock('~/components/Conversations/ProjectsSection', () => () => null);
jest.mock('~/components/Nav/Favorites/FavoritesList', () => () => null);
jest.mock('~/components/Nav/SearchBar', () => () => null);
jest.mock('~/components/Nav/Bookmarks/BookmarkNav', () => () => null);
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    sidebarExpanded: {},
    search: { key: 'mock-search' },
    conversationByIndex: () => ({ key: 'mock-conversation' }),
  },
}));

describe('[knauf] project conversations in the sidebar', () => {
  beforeEach(() => {
    mockActiveConversation = null;
    mockRenderedConversations = [];
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

  it('keeps the opened message-search conversation selected when its title does not match', () => {
    mockSearch = {
      enabled: true,
      query: 'text found only inside a message',
      debouncedQuery: 'text found only inside a message',
      isTyping: false,
    };
    const selectedConversation = {
      conversationId: 'selected-conversation',
      title: 'A different conversation title',
    } as TConversation;
    mockUseConversationsInfiniteQuery.mockReturnValue({
      data: {
        pages: [
          {
            conversations: [
              {
                conversationId: 'irrelevant-title-match',
                title: "AI's Current Mood Inquiry",
              } as TConversation,
            ],
            nextCursor: null,
          },
        ],
      },
      fetchNextPage: jest.fn(),
      isFetchingNextPage: false,
      isLoading: false,
      isFetching: false,
    });

    const view = render(
      <MemoryRouter initialEntries={['/c/selected-conversation']}>
        <Routes>
          <Route path="/" element={<ConversationsSection />}>
            <Route path="c/:conversationId" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(mockRenderedConversations).toEqual([]);

    mockActiveConversation = selectedConversation;
    view.rerender(
      <MemoryRouter initialEntries={['/c/selected-conversation']}>
        <Routes>
          <Route path="/" element={<ConversationsSection />}>
            <Route path="c/:conversationId" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(mockRenderedConversations).toEqual([selectedConversation]);
  });
});

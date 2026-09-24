/**
 * [knauf] Regression coverage for the "chat history disappears" investigation.
 *
 * See knauf/docs/operations/chat-history-disappearing-investigation.md.
 *
 * `removeConvoFromAllQueries` and its siblings drop pages that become empty, but never drop the
 * corresponding entry from `pageParams`. TanStack Query v4 pairs `pages[i]` with `pageParams[i]`
 * when it replays an infinite query, and `getNextPageParam` reads `lastPage.nextCursor` — so once
 * the two arrays disagree, the next background refetch or `fetchNextPage` pages against the wrong
 * cursors. That can make *more* conversations vanish from the sidebar than the one removed.
 *
 * Upstream's `convos.spec.ts` already covers the happy path, but every fixture there seeds
 * `pageParams: []`, which makes the desync structurally invisible. These tests seed realistic
 * `pageParams` instead.
 *
 * `addConversationToInfinitePages` is included as the positive control: it is the one helper in
 * this family that keeps the arrays aligned, so it proves these assertions are satisfiable rather
 * than testing something impossible.
 */
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, InfiniteData } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import {
  addConversationToInfinitePages,
  removeConvoFromAllQueries,
  removeConvoFromInfinitePages,
  updateConvoFieldsInfinite,
} from './convos';

type AnyInfinite = InfiniteData<{ conversations: TConversation[]; nextCursor: string | null }>;

const convo = (id: string): TConversation =>
  ({
    conversationId: id,
    title: `convo ${id}`,
    updatedAt: '2026-09-15T10:00:00.000Z',
    endpoint: 'azureOpenAI',
  }) as unknown as TConversation;

/**
 * Two pages, each holding a single conversation, with the cursor chain a real infinite query
 * would carry: page 0 fetched with `undefined`, page 1 fetched with the cursor page 0 returned.
 */
const twoPages = (): AnyInfinite => ({
  pages: [
    { conversations: [convo('a')], nextCursor: 'cursor-0' },
    { conversations: [convo('b')], nextCursor: null },
  ],
  pageParams: [undefined, 'cursor-0'],
});

/** The invariant TanStack Query relies on when it replays an infinite query. */
const expectAligned = (data: AnyInfinite | undefined) => {
  expect(data).toBeDefined();
  expect(data!.pages.length).toBe(data!.pageParams.length);
};

// [knauf] seam test — infinite-page helpers must keep `pages` and `pageParams` aligned
describe('[knauf] infinite-page helpers keep pages and pageParams aligned', () => {
  describe('removeConvoFromInfinitePages', () => {
    it('keeps the arrays aligned when a removal empties a page', () => {
      const result = removeConvoFromInfinitePages(twoPages(), 'a');

      // Page 0 is emptied and dropped, so pageParams must lose an entry too.
      expect(result!.pages.length).toBe(1);
      expectAligned(result);
    });

    it('leaves both arrays untouched when the removal empties no page', () => {
      const data: AnyInfinite = {
        pages: [{ conversations: [convo('a'), convo('b')], nextCursor: null }],
        pageParams: [undefined],
      };

      const result = removeConvoFromInfinitePages(data, 'a');

      expect(result!.pages.length).toBe(1);
      expect(result!.pages[0].conversations).toHaveLength(1);
      expectAligned(result);
    });
  });

  describe('updateConvoFieldsInfinite', () => {
    it('keeps the arrays aligned when moving a conversation to the top empties its page', () => {
      // Without keepPosition the helper strips the convo from every page, unshifts it onto page 0,
      // then drops emptied pages — so page 1 disappears here.
      const result = updateConvoFieldsInfinite(twoPages(), convo('b'), false);

      expect(result!.pages.length).toBe(1);
      expectAligned(result);
    });
  });

  describe('removeConvoFromAllQueries', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData([QueryKeys.allConversations], twoPages());
    });

    afterEach(() => {
      queryClient.clear();
    });

    it('keeps the arrays aligned when a removal empties a page', () => {
      removeConvoFromAllQueries(queryClient, 'a');

      const data = queryClient.getQueryData<AnyInfinite>([QueryKeys.allConversations]);
      expect(data!.pages.length).toBe(1);
      expectAligned(data);
    });

    it('applies to every cached allConversations query, aligned in each', () => {
      // The helper matches with `exact: false`, so project-scoped and filtered lists are hit too.
      queryClient.setQueryData([QueryKeys.allConversations, { projectId: 'p1' }], twoPages());

      removeConvoFromAllQueries(queryClient, 'a');

      expectAligned(queryClient.getQueryData<AnyInfinite>([QueryKeys.allConversations]));
      expectAligned(
        queryClient.getQueryData<AnyInfinite>([QueryKeys.allConversations, { projectId: 'p1' }]),
      );
    });

    it('does not strand a cursor that points past the surviving pages', () => {
      removeConvoFromAllQueries(queryClient, 'a');

      const data = queryClient.getQueryData<AnyInfinite>([QueryKeys.allConversations])!;
      // 'cursor-0' was page 0's nextCursor. With page 0 gone it addresses nothing, so replaying it
      // re-fetches a window the cache no longer has a page for.
      expect(data.pageParams).not.toContain('cursor-0');
    });
  });

  describe('addConversationToInfinitePages (control)', () => {
    it('keeps the arrays aligned when seeding from empty', () => {
      expectAligned(addConversationToInfinitePages(undefined, convo('a')));
    });

    it('keeps the arrays aligned when prepending to existing pages', () => {
      expectAligned(addConversationToInfinitePages(twoPages(), convo('c')));
    });
  });
});
// End [knauf]

import React from 'react';
import copy from 'copy-to-clipboard';
import { Tools } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from '~/hooks/Messages/useSearchResultsByTurn';
import useCopyToClipboard from '~/hooks/Messages/useCopyToClipboard';
import { useCitation } from '~/components/Web/Context';
import { SearchContext } from '~/Providers';

jest.mock('copy-to-clipboard');
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { pages?: string }) =>
    key === 'com_file_pages' ? `Pages: ${values?.pages ?? ''}` : key,
}));

describe('useSearchResultsByTurn file citation indexes', () => {
  it('keeps web and file references independent across explicit file-search turns', () => {
    const attachments = [
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          turn: 0,
          sources: [
            { fileId: 'same-file', fileName: 'same.pdf', pages: [1] },
            { fileId: 'same-file', fileName: 'same.pdf', pages: [2] },
          ],
        },
      },
      {
        type: Tools.web_search,
        [Tools.web_search]: {
          turn: 0,
          references: [
            {
              link: 'https://example.com/web-reference',
              title: 'Web reference',
              type: 'link',
            },
          ],
        },
      },
      {
        type: Tools.file_search,
        [Tools.file_search]: {
          turn: 1,
          sources: [{ fileId: 'other-file', fileName: 'other.pdf', pages: [3] }],
        },
      },
    ] as unknown as TAttachment[];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect(result.current['0'].references?.map((reference) => reference.link)).toEqual([
      'https://example.com/web-reference',
      '#file-same-file',
      '#file-same-file',
    ]);
    expect(result.current['0'].fileReferences?.map((reference: any) => reference.pages)).toEqual([
      [1],
      [2],
    ]);
    expect(result.current['1'].fileReferences?.map((reference: any) => reference.pages)).toEqual([
      [3],
    ]);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SearchContext.Provider value={{ searchResults: result.current }}>
        {children}
      </SearchContext.Provider>
    );
    const { result: citations } = renderHook(
      () => ({
        web: useCitation({ turn: 0, refType: 'ref', index: 0 }),
        firstChunk: useCitation({ turn: 0, refType: 'file', index: 0 }),
        secondChunk: useCitation({ turn: 0, refType: 'file', index: 1 }),
        secondTurn: useCitation({ turn: 1, refType: 'file', index: 0 }),
      }),
      { wrapper },
    );

    expect(citations.current.web?.link).toBe('https://example.com/web-reference');
    expect((citations.current.firstChunk as any)?.pages).toEqual([1]);
    expect((citations.current.secondChunk as any)?.pages).toEqual([2]);
    expect((citations.current.secondTurn as any)?.pages).toEqual([3]);

    const setIsCopied = jest.fn();
    const { result: copyCitationText } = renderHook(() =>
      useCopyToClipboard({
        text: 'Web \\ue202turn0ref0; chunks \\ue202turn0file0 and \\ue202turn0file1; next \\ue202turn1file0.',
        searchResults: result.current,
      }),
    );
    act(() => copyCitationText.current(setIsCopied));

    expect(copy).toHaveBeenCalledWith(
      `Web [1]; chunks [2] and [2]; next [3].

Citations:
[1] https://example.com/web-reference
[2] #file-same-file
[3] #file-other-file
`,
      { format: 'text/plain' },
    );
  });

  it('advances the legacy fallback after an explicit nonzero turn', () => {
    const attachments = [
      { fileId: 'first', turn: undefined },
      { fileId: 'explicit', turn: 4 },
      { fileId: 'last', turn: undefined },
    ].map(({ fileId, turn }) => ({
      type: Tools.file_search,
      [Tools.file_search]: {
        ...(typeof turn === 'number' ? { turn } : {}),
        sources: [{ fileId, fileName: `${fileId}.pdf`, pages: [1] }],
      },
    })) as unknown as TAttachment[];

    const { result } = renderHook(() => useSearchResultsByTurn(attachments));

    expect((result.current['0'].fileReferences?.[0] as any).fileId).toBe('first');
    expect((result.current['4'].fileReferences?.[0] as any).fileId).toBe('explicit');
    expect((result.current['5'].fileReferences?.[0] as any).fileId).toBe('last');
  });
});

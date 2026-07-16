import { useMemo } from 'react';
import { TAttachment, Tools, SearchResultData } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

interface FileSource {
  fileId: string;
  fileName: string;
  pages?: number[];
  relevance?: number;
  pageRelevance?: Record<string, number>;
  metadata?: any;
}

// [knauf] NO-TICKET — file-search attachments carry ordered chunks and an explicit turn.
/**
 * The `file_search` attachment is typed as {@link SearchResultData} in the
 * shared schema, but at runtime the agent file-search tool emits a
 * `{ sources: FileSource[], turn?: number }` payload. Read it defensively.
 */
type FileSearchAttachmentData = SearchResultData & { sources?: FileSource[]; turn?: number };

function getFileSearchSources(data: FileSearchAttachmentData): FileSource[] {
  return Array.isArray(data.sources) ? data.sources : [];
}
// End [knauf]

/**
 * Hook that creates a map of turn numbers to SearchResultData from web search and agent file search attachments
 * @param attachments Array of attachment metadata
 * @returns A map of turn numbers to their corresponding search result data
 */
export function useSearchResultsByTurn(attachments?: TAttachment[]) {
  const localize = useLocalize();
  const searchResultsByTurn = useMemo(() => {
    const turnMap: { [key: string]: SearchResultData } = {};
    let agentFileSearchTurn = 0;

    attachments?.forEach((attachment) => {
      // Handle web search attachments (existing functionality)
      if (attachment.type === Tools.web_search && attachment[Tools.web_search]) {
        const searchData = attachment[Tools.web_search];
        if (searchData && typeof searchData.turn === 'number') {
          // [knauf] NO-TICKET — web and file evidence may share a turn without sharing indexes.
          const key = searchData.turn.toString();
          const existing = turnMap[key];
          const fileReferences = existing?.fileReferences ?? [];
          turnMap[key] = {
            ...existing,
            ...searchData,
            references: [...(searchData.references ?? []), ...fileReferences],
            fileReferences,
          };
          // End [knauf]
        }
      }

      // [knauf] NO-TICKET — retain every selected chunk in anchor order and honor its tool turn.
      // Handle agent file search attachments (following web search pattern)
      if (attachment.type === Tools.file_search && attachment[Tools.file_search]) {
        const data = attachment[Tools.file_search] as FileSearchAttachmentData;
        const turn = typeof data.turn === 'number' ? data.turn : agentFileSearchTurn;
        const fileReferences = getFileSearchSources(data).map(
          (source) =>
            ({
              title: source.fileName || localize('com_file_unknown'),
              link: `#file-${source.fileId}`,
              attribution: source.fileName || localize('com_file_unknown'),
              snippet:
                source.pages && source.pages.length > 0
                  ? localize('com_file_pages', { pages: source.pages.join(', ') })
                  : '',
              type: 'file' as const,
              fileId: source.fileId,
              fileName: source.fileName,
              pages: source.pages,
              relevance: source.relevance,
              pageRelevance: source.pageRelevance,
              metadata: source.metadata,
            }) as any,
        );
        const key = turn.toString();
        const existing = turnMap[key];
        turnMap[key] = {
          turn,
          organic: [],
          topStories: [],
          images: [],
          ...existing,
          references: [...(existing?.references ?? []), ...fileReferences],
          fileReferences: [...(existing?.fileReferences ?? []), ...fileReferences],
        };
        agentFileSearchTurn = Math.max(agentFileSearchTurn, turn + 1);
      }
      // End [knauf]
    });

    return turnMap;
  }, [attachments, localize]);

  return searchResultsByTurn;
}

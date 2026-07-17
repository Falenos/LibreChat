const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { generateShortLivedToken } = require('@librechat/api');
const { Tools, EToolResources } = require('librechat-data-provider');

// [knauf] Shared retrieval helpers.
const {
  useAzureSearchForAgents: isAzureSearchEnabledForAgents,
} = require('~/server/services/Files/VectorDB/crud');
const { applyCitationLimits } = require('~/server/services/Files/Citations');
// End [knauf]
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles } = require('~/models');

const fileSearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string; fromAgent: boolean }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources, req, agentId } = options;
  const file_ids = tool_resources?.[EToolResources.file_search]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.file_search]?.files ?? [];

  // Get all files first
  const allFiles = (await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [];

  // Filter by access if user and agent are provided
  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
    });
  } else {
    dbFiles = allFiles;
  }

  dbFiles = dbFiles.concat(resourceFiles);

  let toolContext = `- Note: Semantic search is available through the ${Tools.file_search} tool but no files are currently loaded. Request the user to upload documents to search through.`;

  const files = [];
  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }
    if (i === 0) {
      toolContext = `- Note: Use the ${Tools.file_search} tool to find relevant information within:`;
    }
    toolContext += `\n\t- ${file.filename}${
      agentResourceIds.has(file.file_id) ? '' : ' (just attached by user)'
    }`;
    files.push({
      file_id: file.file_id,
      filename: file.filename,
      // [knauf] KK20-204 — carry the shared asset id so the /query below resolves a
      // deduped reuse row's vectors (stored under knauf_asset_id), not its own id.
      knauf_asset_id: file.knauf_asset_id,
      // End [knauf]
      // [knauf] KK20-203 — carry context so query routing can split agent vs chat files.
      context: file.context,
      fromAgent: agentResourceIds.has(file.file_id),
      // End [knauf]
    });
  }

  return { files, toolContext };
};

/**
 *
 * @param {Object} options
 * @param {string} options.userId
 * @param {Array<{ file_id: string; filename: string; fromAgent?: boolean }>} options.files
 * @param {string} [options.entity_id]
 * @param {boolean} [options.fileCitations=false] - Whether to include citation instructions
 * @param {number} [options.maxDistinctQueries=3] - Maximum unique queries for this tool instance
 * @param {number} [options.maxCitations=30] - Maximum sources exposed to citation anchors
 * @param {number} [options.maxCitationsPerFile=7] - Maximum anchors from one logical file
 * @param {number} [options.minRelevanceScore=0.45] - Minimum rank-derived citation relevance
 * @param {object} [options.runContext] - Stable request object shared by event-driven tool reloads
 * @param {string} [options.cachePartition] - Runtime agent identity for cache/budget isolation
 * @returns
 */
// [knauf] NO-TICKET — canonical dual-backend retrieval replaces per-file fan-out while
// preserving authorized logical file ids for citations and bounding backend retrieval work.
const DEFAULT_MAX_DISTINCT_QUERIES = 3;
const DEFAULT_MAX_CITATIONS = 30;
const DEFAULT_MAX_CITATIONS_PER_FILE = 7;
const DEFAULT_MIN_RELEVANCE_SCORE = 0.45;
const MAX_RESULTS = 10;
const RRF_K = 60;
const runStates = new WeakMap();

const getRunState = (runContext, entityId) => {
  let requestState;
  if (!runContext || typeof runContext !== 'object') {
    requestState = { nextTurn: 0, statesByEntity: new Map() };
  } else {
    requestState = runStates.get(runContext);
    if (!requestState) {
      requestState = { nextTurn: 0, statesByEntity: new Map() };
      runStates.set(runContext, requestState);
    }
  }
  const entityKey = entityId ?? '__unscoped__';
  let entityState = requestState.statesByEntity.get(entityKey);
  if (!entityState) {
    entityState = { queryCache: new Map(), distinctQueries: new Set() };
    requestState.statesByEntity.set(entityKey, entityState);
  }
  return { requestState, entityState };
};

const normalizeQuery = (query) =>
  String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const createFileSearchTool = async ({
  userId,
  files,
  entity_id,
  fileCitations = false,
  maxDistinctQueries = DEFAULT_MAX_DISTINCT_QUERIES,
  maxCitations = DEFAULT_MAX_CITATIONS,
  maxCitationsPerFile = DEFAULT_MAX_CITATIONS_PER_FILE,
  minRelevanceScore = DEFAULT_MIN_RELEVANCE_SCORE,
  runContext,
  cachePartition = entity_id,
}) => {
  const queryLimit =
    Number.isInteger(maxDistinctQueries) && maxDistinctQueries > 0
      ? maxDistinctQueries
      : DEFAULT_MAX_DISTINCT_QUERIES;
  const azureEnabled = isAzureSearchEnabledForAgents();
  const targetsByKey = new Map();

  const candidates = files
    .map((file) => {
      const physicalId = file.knauf_asset_id ?? file.file_id;
      const backend =
        azureEnabled && file.fromAgent === true && file.context === 'agents' ? 'azure' : 'pgvector';
      return {
        key: `${backend}:${physicalId}`,
        backend,
        physicalId,
        fileId: file.file_id,
        filename: file.filename,
      };
    })
    .filter((target) => target.physicalId)
    .sort(
      (a, b) =>
        a.key.localeCompare(b.key) ||
        String(a.fileId).localeCompare(String(b.fileId)) ||
        String(a.filename).localeCompare(String(b.filename)),
    );

  for (const target of candidates) {
    const { key } = target;
    if (!targetsByKey.has(key)) {
      targetsByKey.set(key, target);
    }
  }

  const targets = [...targetsByKey.values()];
  const targetsByBackend = {
    pgvector: targets.filter((target) => target.backend === 'pgvector'),
    azure: targets.filter((target) => target.backend === 'azure'),
  };
  const targetFingerprint = targets
    .map((target) => `${target.key}:${target.fileId}`)
    .sort()
    .join('|');
  const { requestState, entityState } = getRunState(runContext, cachePartition);
  const { queryCache, distinctQueries } = entityState;

  const executeSearch = async (query, turn) => {
    if (targets.length === 0) {
      return ['No files to search. Instruct the user to add files for the search.', undefined];
    }

    const jwtToken = generateShortLivedToken(userId);
    if (!jwtToken) {
      return ['There was an error authenticating the file search request.', undefined];
    }

    const headers = {
      Authorization: `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
    };
    const requests = [];

    if (targetsByBackend.pgvector.length > 0) {
      requests.push({
        backend: 'pgvector',
        targets: targetsByBackend.pgvector,
        url: `${process.env.RAG_API_URL}/query_multiple`,
        body: {
          query,
          file_ids: targetsByBackend.pgvector.map((target) => target.physicalId),
          k: MAX_RESULTS,
          ...(entity_id ? { entity_id } : {}),
        },
      });
    }

    if (targetsByBackend.azure.length > 0) {
      requests.push({
        backend: 'azure',
        targets: targetsByBackend.azure,
        url: `${process.env.RAG_API_URL}/agent/query-multiple`,
        ...(entity_id
          ? {
              body: {
                query,
                file_ids: targetsByBackend.azure.map((target) => target.physicalId),
                k: MAX_RESULTS,
                entity_id,
              },
            }
          : {
              error: new Error('Missing agent scope for Azure file search.'),
              userMessage:
                'Agent knowledge search is unavailable because the agent scope is missing.',
            }),
      });
    }

    const responses = await Promise.all(
      requests.map(async (request) => {
        if (request.error) {
          logger.error(`[${Tools.file_search}] ${request.backend} batch query rejected locally.`);
          return request;
        }
        try {
          const response = await axios.post(request.url, request.body, { headers });
          return { ...request, data: Array.isArray(response.data) ? response.data : [] };
        } catch (error) {
          logger.error(`[${Tools.file_search}] ${request.backend} batch query failed:`, error);
          return { ...request, error };
        }
      }),
    );

    if (responses.every((response) => response.error)) {
      return [
        responses.find((response) => response.userMessage)?.userMessage ??
          'No results found or errors occurred while searching the files.',
        undefined,
      ];
    }

    const rankedResults = [];
    for (const response of responses) {
      if (response.error) {
        continue;
      }
      const targetsForResponse = new Map(
        response.targets.map((target) => [String(target.physicalId), target]),
      );
      const seenChunks = new Set();
      let backendRank = 0;

      for (const item of response.data) {
        const docInfo = Array.isArray(item) ? item[0] : item;
        if (!docInfo || typeof docInfo !== 'object') {
          continue;
        }
        const metadata = docInfo.metadata ?? {};
        const physicalId =
          metadata.file_id ??
          (response.targets.length === 1 ? response.targets[0].physicalId : undefined);
        const target = physicalId == null ? undefined : targetsForResponse.get(String(physicalId));
        if (!target) {
          logger.warn(`[${Tools.file_search}] Skipping result with unknown physical file id.`);
          continue;
        }

        const content = String(docInfo.page_content ?? '').trim();
        if (!content) {
          continue;
        }
        const chunkIdentity =
          metadata.digest ?? `${metadata.page ?? ''}:${content.replace(/\s+/g, ' ')}`;
        const chunkKey = `${response.backend}:${target.physicalId}:${chunkIdentity}`;
        if (seenChunks.has(chunkKey)) {
          continue;
        }
        seenChunks.add(chunkKey);
        backendRank += 1;
        // Normalized reciprocal-rank relevance stays above the default citation
        // threshold without comparing incompatible raw backend scores.
        const relevance = (RRF_K + 1) / (RRF_K + backendRank);
        rankedResults.push({
          backend: response.backend,
          backendRank,
          rrf: 1 / (RRF_K + backendRank),
          relevance,
          filename: target.filename,
          file_id: target.fileId,
          content,
          page: metadata.page ?? null,
        });
      }
    }

    const fusedResults = rankedResults
      .sort(
        (a, b) =>
          b.rrf - a.rrf || a.backend.localeCompare(b.backend) || a.backendRank - b.backendRank,
      )
      .slice(0, MAX_RESULTS);
    const unavailableBackends = responses
      .filter((response) => response.error)
      .map((response) => response.backend);
    const partialWarning =
      unavailableBackends.length > 0
        ? `Warning: ${unavailableBackends.join(', ')} search was unavailable; these results are partial.\n\n`
        : '';
    if (fusedResults.length === 0) {
      return [
        `${partialWarning}No content found in the files. The files may not have been processed correctly or you may need to refine your query.`,
        undefined,
      ];
    }

    const allSources = fusedResults.map((result) => ({
      type: 'file',
      fileId: result.file_id,
      content: result.content,
      fileName: result.filename,
      relevance: result.relevance,
      pages: result.page != null ? [result.page] : [],
      pageRelevance: result.page != null ? { [result.page]: result.relevance } : {},
    }));
    const sources = fileCitations
      ? applyCitationLimits(
          allSources.filter((source) => source.relevance >= minRelevanceScore),
          maxCitations,
          maxCitationsPerFile,
        )
      : allSources;
    const resultBySource = new Map(
      allSources.map((source, index) => [source, fusedResults[index]]),
    );
    const visibleResults = sources.map((source) => resultBySource.get(source)).filter(Boolean);

    const formattedString =
      partialWarning +
      visibleResults
        .map(
          (result, index) =>
            `File: ${result.filename}${
              fileCitations ? `\nAnchor: \\ue202turn${turn}file${index} (${result.filename})` : ''
            }\nRelevance: ${result.relevance.toFixed(4)}\nContent: ${result.content}\n`,
        )
        .join('\n---\n');

    return [
      formattedString,
      { [Tools.file_search]: { sources, fileCitations, preselected: true, turn } },
    ];
  };

  return tool(
    async ({ query }) => {
      const normalizedQuery = normalizeQuery(query);
      const cacheKey = `${normalizedQuery}\n${targetFingerprint}`;
      if (queryCache.has(cacheKey)) {
        const [cachedContent] = await queryCache.get(cacheKey);
        return [cachedContent, undefined];
      }

      if (distinctQueries.size >= queryLimit) {
        const exhausted = Promise.resolve([
          JSON.stringify({
            type: 'search_budget_exhausted',
            maxDistinctQueries: queryLimit,
            instruction:
              'Answer with the evidence already retrieved. If it is insufficient, explain the limitation without calling file_search again.',
          }),
          undefined,
        ]);
        queryCache.set(cacheKey, exhausted);
        return exhausted;
      }

      distinctQueries.add(cacheKey);
      const turn = requestState.nextTurn++;
      const searchPromise = executeSearch(String(query ?? '').trim(), turn);
      queryCache.set(cacheKey, searchPromise);
      return searchPromise;
    },
    {
      name: Tools.file_search,
      responseFormat: 'content_and_artifact',
      description: `Searches extracted text from attached documents using natural language queries. It cannot inspect images or recover image pixels from earlier turns; current images are supplied directly through multimodal message input. If a needed image is no longer in context, ask the user to reattach it. Use this to extract specific information or find relevant passages in available documents.${
        fileCitations
          ? `

**CITE FILE SEARCH RESULTS:**
Each result has an authoritative Anchor line. Copy that exact marker verbatim immediately after statements derived from its content. Never invent or reset a turn or file index. For a multi-file citation, wrap the copied markers with \\ue200 and \\ue201.

**CRITICAL:** Output the escape sequences EXACTLY as returned. Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**`
          : ''
      }`,
      schema: fileSearchJsonSchema,
    },
  );
};
// End [knauf]

module.exports = { createFileSearchTool, primeFiles, fileSearchJsonSchema };

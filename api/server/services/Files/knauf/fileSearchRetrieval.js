const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { generateShortLivedToken } = require('@librechat/api');
const { Tools } = require('librechat-data-provider');
// Semantic merge fix: this branch renamed the flag accessor in WP0
// (useAzureSearchForAgents → isAzureSearchEnabledForAgents, eslint react-hooks).
const { isAzureSearchEnabledForAgents } = require('../VectorDB/crud');

const DEFAULT_MAX_DISTINCT_QUERIES = 3;
const DEFAULT_MAX_CITATIONS = 30;
const DEFAULT_MAX_CITATIONS_PER_FILE = 7;
const MAX_RESULTS = 10;
const RRF_K = 60;
const SUCCESS_GROUNDING =
  "File search succeeded. The attached file is available. Use the excerpts below to answer the user's request. Do not claim the file is missing or ask the user to upload it again. If the excerpts do not cover the whole document, state that limitation and answer from the available evidence. Page numbers may be unavailable; do not search only to obtain citation metadata.";
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
    entityState = {
      queryCache: new Map(),
      distinctQueries: new Set(),
      hasRetrievedEvidence: false,
    };
    requestState.statesByEntity.set(entityKey, entityState);
  }
  return { requestState, entityState };
};

const normalizeQuery = (query) =>
  String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const limitSourcesInRankOrder = (sources, maxCitations, maxCitationsPerFile) => {
  const selected = [];
  const countByFile = new Map();
  for (const source of sources) {
    const count = countByFile.get(source.fileId) ?? 0;
    if (count >= maxCitationsPerFile) {
      continue;
    }
    selected.push(source);
    countByFile.set(source.fileId, count + 1);
    if (selected.length >= maxCitations) {
      break;
    }
  }
  return selected;
};

const createKnaufFileSearchTool = async (
  {
    userId,
    files,
    entity_id,
    fileCitations = false,
    maxDistinctQueries = DEFAULT_MAX_DISTINCT_QUERIES,
    maxCitations = DEFAULT_MAX_CITATIONS,
    maxCitationsPerFile = DEFAULT_MAX_CITATIONS_PER_FILE,
    runContext,
    cachePartition = entity_id,
  },
  fileSearchJsonSchema,
) => {
  const queryLimit =
    Number.isInteger(maxDistinctQueries) && maxDistinctQueries > 0
      ? maxDistinctQueries
      : DEFAULT_MAX_DISTINCT_QUERIES;
  const citationLimit =
    Number.isInteger(maxCitations) && maxCitations > 0 ? maxCitations : DEFAULT_MAX_CITATIONS;
  const perFileLimit =
    Number.isInteger(maxCitationsPerFile) && maxCitationsPerFile > 0
      ? maxCitationsPerFile
      : DEFAULT_MAX_CITATIONS_PER_FILE;
  const azureEnabled = isAzureSearchEnabledForAgents();
  const targetsByKey = new Map();

  const candidates = files
    .map((file) => {
      const physicalId = file.knauf_asset_id ?? file.file_id;
      const configuredBackend =
        file.knauf_vector_backend === 'azure_search' ? 'azure' : file.knauf_vector_backend;
      const backend =
        configuredBackend ??
        (azureEnabled && file.fromAgent === true && file.context === 'agents'
          ? 'azure'
          : 'pgvector');
      const generation =
        Number.isInteger(file.knauf_active_generation) && file.knauf_active_generation >= 0
          ? file.knauf_active_generation
          : 0;
      return {
        key: `${backend}:${physicalId}:${generation}`,
        backend,
        physicalId,
        generation,
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
    if (!targetsByKey.has(target.key)) {
      targetsByKey.set(target.key, target);
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
          generations: Object.fromEntries(
            targetsByBackend.pgvector.map((target) => [target.physicalId, target.generation]),
          ),
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
                generations: Object.fromEntries(
                  targetsByBackend.azure.map((target) => [target.physicalId, target.generation]),
                ),
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
        rankedResults.push({
          backend: response.backend,
          backendRank,
          rrf: 1 / (RRF_K + backendRank),
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
        `${partialWarning}The attached files are available, but no matching content was found. Explain that the available excerpts do not contain sufficient evidence; do not claim the files are missing, ask the user to upload them again, or call file_search again for this question.`,
        undefined,
      ];
    }

    const allSources = fusedResults.map((result) => ({
      type: 'file',
      fileId: result.file_id,
      content: result.content,
      fileName: result.filename,
      pages: result.page != null ? [result.page] : [],
      metadata: {
        backend: result.backend,
        backendRank: result.backendRank,
        rankingStrategy: 'cross_backend_rrf',
        rankingScore: result.rrf,
      },
    }));
    const sources = fileCitations
      ? limitSourcesInRankOrder(allSources, citationLimit, perFileLimit)
      : allSources;
    const resultBySource = new Map(
      allSources.map((source, index) => [source, fusedResults[index]]),
    );
    const visibleResults = sources.map((source) => resultBySource.get(source)).filter(Boolean);
    entityState.hasRetrievedEvidence = true;

    const formattedString =
      `${SUCCESS_GROUNDING}\n\n${partialWarning}` +
      visibleResults
        .map(
          (result, index) =>
            `File: ${result.filename}${
              fileCitations ? `\nAnchor: \\ue202turn${turn}file${index} (${result.filename})` : ''
            }\nContent: ${result.content}\n`,
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
            fileStatus: 'available',
            evidenceStatus: entityState.hasRetrievedEvidence ? 'retrieved' : 'not_retrieved',
            instruction:
              'The attached file is available. Answer with the evidence already retrieved. If it is insufficient, explain that limitation; do not claim the file is missing, ask the user to upload it again, or call file_search again.',
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
      description: `Searches extracted text from attached documents using natural language queries. A listed document is already attached; when results are returned, treat the file as available and never ask the user to upload it again. Page metadata may be unavailable, so do not search only to obtain page numbers or citation metadata. It cannot inspect images or recover image pixels from earlier turns; current images are supplied directly through multimodal message input. If a needed image is no longer in context, ask the user to reattach it. Use this to extract specific information or find relevant passages in available documents.${
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

module.exports = { createKnaufFileSearchTool };

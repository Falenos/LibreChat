const { Tools, EToolResources } = require('librechat-data-provider');

const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles } = require('~/models');
// [knauf] Delegate fork-specific retrieval to a Knauf-owned module.
const { createKnaufFileSearchTool } = require('~/server/services/Files/knauf/fileSearchRetrieval');
// End [knauf]

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
      // End [knauf]
      fromAgent: agentResourceIds.has(file.file_id),
    });
  }

  return { files, toolContext };
};

// [knauf] Keep the upstream tool surface stable while the implementation remains isolated.
const createFileSearchTool = (options) => createKnaufFileSearchTool(options, fileSearchJsonSchema);
// End [knauf]

module.exports = { createFileSearchTool, primeFiles, fileSearchJsonSchema };

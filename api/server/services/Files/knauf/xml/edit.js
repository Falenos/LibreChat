'use strict';

const path = require('path');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { getToolDefinition, sanitizeFilename } = require('@librechat/api');
const { IdmlError } = require('../idml/core');
const { applyTextEdits } = require('../idml/edit');
const {
  FILE_TRANSLATION_ARTIFACT_KEY,
  formatForFile,
  persistOutput,
  readFileBuffer,
  requestToolFiles,
  resolveInputFiles,
  xmlAdapter,
} = require('../translation/tool');

const TOOL_NAME = 'edit_xml';
const XML_MIME = 'application/xml';
const MAX_INSPECT_SEGMENTS = 100;
const MAX_INSPECT_METADATA_CHARACTERS = 4000;
const isXmlFile = (file) => formatForFile(file)?.mode === 'xml';

function publicError(error) {
  if (error instanceof IdmlError) {
    return { code: error.code, error: error.message };
  }
  return { code: 'xml_edit_failed', error: 'XML operation failed' };
}

function editedFilename(sourceName) {
  const extension = path.extname(sourceName) || '.xml';
  return sanitizeFilename(`${path.basename(sourceName, extension)}_edited${extension}`);
}

async function selectedFiles(req, filename) {
  const files = await resolveInputFiles(req, isXmlFile);
  if (!filename) {
    return files;
  }
  const selected = files.filter((file) => path.basename(file.filename) === path.basename(filename));
  if (!selected.length) {
    throw new IdmlError(`Attached XML not found: ${filename}`, 'file_not_found', 404);
  }
  return selected;
}

function inspectAdapter(adapter, { query, offset = 0, limit = 50 } = {}) {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_INSPECT_SEGMENTS) : 50;
  const matches = query
    ? adapter.segments.filter((segment) => segment.source.includes(query))
    : adapter.segments;
  const elementMatches = query
    ? adapter.elements.filter(
        (element) =>
          element.path.includes(query) ||
          Object.entries(element.attributes).some(
            ([name, value]) => name.includes(query) || value.includes(query),
          ),
      )
    : adapter.elements;
  const commentMatches = query
    ? adapter.comments.filter((comment) => comment.text.includes(query))
    : adapter.comments;
  const processingInstructionMatches = query
    ? adapter.processingInstructions.filter(
        ({ target, body }) => target.includes(query) || body.includes(query),
      )
    : adapter.processingInstructions;
  return {
    totalElements: adapter.elements.length,
    matchedElements: elementMatches.length,
    totalSegments: adapter.segments.length,
    matchedSegments: matches.length,
    totalComments: adapter.comments.length,
    matchedComments: commentMatches.length,
    totalProcessingInstructions: adapter.processingInstructions.length,
    matchedProcessingInstructions: processingInstructionMatches.length,
    offset: safeOffset,
    limit: safeLimit,
    elements: elementMatches.slice(safeOffset, safeOffset + safeLimit),
    segments: matches.slice(safeOffset, safeOffset + safeLimit).map((segment) => ({
      id: segment.id,
      path: segment.path,
      text: segment.source,
    })),
    comments: commentMatches.slice(safeOffset, safeOffset + safeLimit).map(({ text }) => ({
      text: text.slice(0, MAX_INSPECT_METADATA_CHARACTERS),
      ...(text.length > MAX_INSPECT_METADATA_CHARACTERS && {
        truncated: true,
        totalCharacters: text.length,
      }),
    })),
    processingInstructions: processingInstructionMatches
      .slice(safeOffset, safeOffset + safeLimit)
      .map(({ target, body }) => ({
        target,
        body: body.slice(0, MAX_INSPECT_METADATA_CHARACTERS),
        ...(body.length > MAX_INSPECT_METADATA_CHARACTERS && {
          truncated: true,
          totalCharacters: body.length,
        }),
      })),
  };
}

async function inspectXml({ req, args }) {
  const reports = [];
  for (const file of await selectedFiles(req, args?.filename)) {
    const adapter = xmlAdapter(await readFileBuffer(req, file));
    reports.push({ filename: file.filename, ...inspectAdapter(adapter, args) });
  }
  return { status: 'completed', action: 'inspect', files: reports };
}

function validateExplicitSegmentSelection(req, args) {
  const requestedIds = (args?.segment_edits ?? []).map((edit) => edit?.segment_id);
  if (!requestedIds.length) return;
  const userText = typeof req?.body?.text === 'string' ? req.body.text : '';
  const explicitIds = new Set(userText.match(/\bx\d+\b/g) ?? []);
  if (requestedIds.some((segmentId) => !explicitIds.has(segmentId))) {
    throw new IdmlError(
      'Segment edits require the user to specify each segment_id; use replacements for text-only requests',
      'segment_selection_required',
      409,
    );
  }
}

async function editXml({ req, args }) {
  validateExplicitSegmentSelection(req, args);
  const files = await selectedFiles(req, args?.filename);
  if ((args?.segment_edits?.length ?? 0) > 0 && files.length !== 1) {
    throw new IdmlError(
      'Select one filename when editing by segment_id',
      'segment_target_required',
      400,
    );
  }
  const outputs = [];
  const reports = [];
  for (const file of files) {
    try {
      const adapter = xmlAdapter(await readFileBuffer(req, file));
      const edits = applyTextEdits(adapter, args, {
        segmentIdPattern: /^x\d+$/,
        formatLabel: 'XML',
      });
      outputs.push(
        await persistOutput({
          req,
          buffer: adapter.build(edits.translations),
          filename: editedFilename(file.filename),
          mimeType: XML_MIME,
          conversationId: req.body.conversationId,
        }),
      );
      reports.push({ sourceFile: file.filename, status: 'completed', edits: edits.applied });
    } catch (error) {
      reports.push({ sourceFile: file.filename, status: 'failed', ...publicError(error) });
    }
  }
  if (!outputs.length) {
    throw new IdmlError(reports[0]?.error ?? 'No XML output was produced', reports[0]?.code);
  }
  return {
    files: outputs,
    report: {
      status: outputs.length === files.length ? 'completed' : 'partial',
      action: 'replace_text',
      files: reports,
      preserved: 'elements, namespaces, attributes, comments, processing instructions, and order',
      validation: 'schema_or_consumer_review_required',
    },
  };
}

function buildXmlToolContext(req) {
  const names = requestToolFiles(req)
    .filter(isXmlFile)
    .map((file) => file.filename ?? file.name ?? 'attached XML');
  if (!names.length) {
    return '';
  }
  return [
    `XML structure/attribute inspection and text-node editing are available for: ${names.join(', ')}.`,
    'Use edit_xml action inspect before an uncertain edit, then replace exact text or a returned segment_id.',
    'For text-only requests, use replacements. Use segment_edits only when the user explicitly supplies a segment_id; never infer one or bypass ambiguity.',
    'Attribute editing is unsupported. If the user requests it, do not call edit_xml; explain that attributes are read-only and no output file was created.',
    'Inspection reports comments and processing instructions as read-only metadata.',
    'Element names, namespaces, attributes, comments, processing instructions, and order are preserved.',
    'DTD/entities and malformed XML are rejected. Validate the export against its schema or consuming system.',
  ].join('\n');
}

function createXmlEditTool({ req }) {
  const definition = getToolDefinition(TOOL_NAME);
  if (!definition) {
    throw new Error(`${TOOL_NAME} definition is missing`);
  }
  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: definition.description,
    schema: definition.schema,
    responseFormat: 'content_and_artifact',
    func: async (args) => {
      try {
        if (args?.action === 'inspect') {
          return [
            JSON.stringify(await inspectXml({ req, args })),
            { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: [] } },
          ];
        }
        if (args?.action !== 'replace_text') {
          throw new IdmlError('action must be inspect or replace_text', 'invalid_action', 400);
        }
        const result = await editXml({ req, args });
        logger.info('[edit_xml] completed', {
          userId: req?.user?.id,
          conversationId: req?.body?.conversationId,
          status: result.report.status,
          outputs: result.files.length,
        });
        return [
          JSON.stringify(result.report),
          { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: result.files } },
        ];
      } catch (error) {
        const payload = publicError(error);
        logger.warn('[edit_xml] failed', {
          userId: req?.user?.id,
          conversationId: req?.body?.conversationId,
          code: payload.code,
        });
        return [
          JSON.stringify({ status: 'failed', ...payload }),
          { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: [] } },
        ];
      }
    },
  });
}

module.exports = {
  TOOL_NAME,
  buildXmlToolContext,
  createXmlEditTool,
  editXml,
  inspectAdapter,
  inspectXml,
  isXmlFile,
  validateExplicitSegmentSelection,
};

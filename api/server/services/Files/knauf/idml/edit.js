'use strict';

const path = require('path');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { getToolDefinition, sanitizeFilename } = require('@librechat/api');
const { IDML_MIME, IdmlError, buildIdml, parseIdml } = require('./core');
const {
  FILE_TRANSLATION_ARTIFACT_KEY,
  formatForFile,
  persistOutput,
  readFileBuffer,
  requestToolFiles,
  resolveInputFiles,
} = require('../translation/tool');

const TOOL_NAME = 'edit_idml';
const MAX_INSPECT_SEGMENTS = 100;
const MAX_EDIT_OPERATIONS = 100;
const MAX_EDIT_TEXT = 100000;
const MAX_EDITED_CHARACTERS = 2000000;

const isIdmlFile = (file) => formatForFile(file)?.mode === 'idml';

function publicError(error) {
  if (error instanceof IdmlError) {
    return { code: error.code, error: error.message };
  }
  return { code: 'idml_edit_failed', error: 'IDML operation failed' };
}

function editedFilename(sourceName) {
  const extension = path.extname(sourceName) || '.idml';
  return sanitizeFilename(`${path.basename(sourceName, extension)}_edited${extension}`);
}

function countOccurrences(value, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateEditOperations(
  args,
  { segmentIdPattern = /^s\d+-c\d+(?:-p\d+)?$/, formatLabel = 'IDML' } = {},
) {
  const replacements = args?.replacements ?? [];
  const segmentEdits = args?.segment_edits ?? [];
  if (!Array.isArray(replacements) || !Array.isArray(segmentEdits)) {
    throw new IdmlError(`${formatLabel} edits must be arrays`, 'invalid_edit', 400);
  }
  if (!replacements.length && !segmentEdits.length) {
    throw new IdmlError('Provide replacements or segment_edits', 'missing_edit', 400);
  }
  if (replacements.length + segmentEdits.length > MAX_EDIT_OPERATIONS) {
    throw new IdmlError(
      `${formatLabel} edit exceeds the 100-operation limit`,
      'too_many_edits',
      400,
    );
  }
  for (const replacement of replacements) {
    if (
      typeof replacement?.find !== 'string' ||
      replacement.find.length === 0 ||
      replacement.find.length > MAX_EDIT_TEXT ||
      typeof replacement?.replace !== 'string' ||
      replacement.replace.length > MAX_EDIT_TEXT ||
      (replacement.replace_all != null && typeof replacement.replace_all !== 'boolean')
    ) {
      throw new IdmlError(
        'Each replacement needs bounded find and replace text',
        'invalid_edit',
        400,
      );
    }
  }
  const ids = new Set();
  for (const edit of segmentEdits) {
    if (
      typeof edit?.segment_id !== 'string' ||
      !segmentIdPattern.test(edit.segment_id) ||
      typeof edit?.text !== 'string' ||
      edit.text.length > MAX_EDIT_TEXT
    ) {
      throw new IdmlError(
        'Each segment edit needs a valid segment_id and bounded text',
        'invalid_edit',
        400,
      );
    }
    if (ids.has(edit.segment_id)) {
      throw new IdmlError(
        `Duplicate segment edit ${edit.segment_id}`,
        'duplicate_segment_edit',
        400,
      );
    }
    ids.add(edit.segment_id);
  }
  return { replacements, segmentEdits };
}

function applyTextEdits(parsed, args, options) {
  const { replacements, segmentEdits } = validateEditOperations(args, options);
  const formatLabel = options?.formatLabel ?? 'IDML';
  const textById = new Map(parsed.segments.map((segment) => [segment.id, segment.source]));
  let totalCharacters = parsed.segments.reduce((sum, segment) => sum + segment.source.length, 0);
  let applied = 0;

  for (const replacement of replacements) {
    const matches = Array.from(textById, ([id, text]) => ({
      id,
      count: countOccurrences(text, replacement.find),
    })).filter((match) => match.count > 0);
    const total = matches.reduce((sum, match) => sum + match.count, 0);
    if (total === 0) {
      throw new IdmlError(`Text not found: ${replacement.find}`, 'text_not_found', 400);
    }
    if (total > 1 && replacement.replace_all !== true) {
      throw new IdmlError(
        `Text occurs ${total} times; set replace_all to edit every occurrence`,
        'ambiguous_match',
        409,
      );
    }
    const replacedCount = replacement.replace_all === true ? total : 1;
    const nextTotal =
      totalCharacters + replacedCount * (replacement.replace.length - replacement.find.length);
    if (nextTotal > MAX_EDITED_CHARACTERS) {
      throw new IdmlError(
        `Edited ${formatLabel} text exceeds the 2,000,000-character limit`,
        'edit_too_large',
        400,
      );
    }
    for (const match of matches) {
      const source = textById.get(match.id);
      textById.set(
        match.id,
        replacement.replace_all === true
          ? source.replaceAll(replacement.find, () => replacement.replace)
          : source.replace(replacement.find, () => replacement.replace),
      );
      applied += replacement.replace_all === true ? match.count : 1;
      if (replacement.replace_all !== true) {
        break;
      }
    }
    totalCharacters = nextTotal;
  }

  for (const edit of segmentEdits) {
    if (!textById.has(edit.segment_id)) {
      throw new IdmlError(`Unknown segment ${edit.segment_id}`, 'unknown_segment', 400);
    }
    totalCharacters += edit.text.length - textById.get(edit.segment_id).length;
    if (totalCharacters > MAX_EDITED_CHARACTERS) {
      throw new IdmlError(
        `Edited ${formatLabel} text exceeds the 2,000,000-character limit`,
        'edit_too_large',
        400,
      );
    }
    textById.set(edit.segment_id, edit.text);
    applied += 1;
  }
  return { translations: textById, applied };
}

function inspectParsed(parsed, { query, offset = 0, limit = 50 } = {}) {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_INSPECT_SEGMENTS) : 50;
  const segments = query
    ? parsed.segments.filter((segment) => segment.source.includes(query))
    : parsed.segments;
  return {
    totalSegments: parsed.segments.length,
    matchedSegments: segments.length,
    offset: safeOffset,
    limit: safeLimit,
    segments: segments.slice(safeOffset, safeOffset + safeLimit).map((segment) => ({
      id: segment.id,
      story: segment.entryName,
      text: segment.source,
    })),
  };
}

async function selectedFiles(req, filename) {
  const files = await resolveInputFiles(req, isIdmlFile);
  if (!filename) {
    return files;
  }
  const selected = files.filter((file) => path.basename(file.filename) === path.basename(filename));
  if (!selected.length) {
    throw new IdmlError(`Attached IDML not found: ${filename}`, 'file_not_found', 404);
  }
  return selected;
}

async function inspectIdml({ req, args }) {
  const reports = [];
  for (const file of await selectedFiles(req, args?.filename)) {
    const parsed = await parseIdml(await readFileBuffer(req, file));
    reports.push({ filename: file.filename, ...inspectParsed(parsed, args) });
  }
  return { status: 'completed', action: 'inspect', files: reports };
}

async function editIdml({ req, args }) {
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
      const parsed = await parseIdml(await readFileBuffer(req, file));
      const edits = applyTextEdits(parsed, args);
      const output = await buildIdml(parsed, edits.translations, { allowEmpty: true });
      outputs.push(
        await persistOutput({
          req,
          buffer: output.buffer,
          filename: editedFilename(file.filename),
          mimeType: IDML_MIME,
          conversationId: req.body.conversationId,
        }),
      );
      reports.push({ sourceFile: file.filename, status: 'completed', edits: edits.applied });
    } catch (error) {
      reports.push({ sourceFile: file.filename, status: 'failed', ...publicError(error) });
    }
  }
  if (!outputs.length) {
    throw new IdmlError(reports[0]?.error ?? 'No IDML output was produced', reports[0]?.code);
  }
  return {
    files: outputs,
    report: {
      status: outputs.length === files.length ? 'completed' : 'partial',
      action: 'replace_text',
      files: reports,
      preserved: 'non-story package entries',
      layoutValidation: 'human_required',
    },
  };
}

function buildIdmlToolContext(req) {
  const names = requestToolFiles(req)
    .filter(isIdmlFile)
    .map((file) => file.filename ?? file.name ?? 'attached IDML');
  if (!names.length) {
    return '';
  }
  return [
    `IDML inspection and story-text editing are available for: ${names.join(', ')}.`,
    'Use edit_idml action inspect before an uncertain edit, then replace exact text or a returned segment_id.',
    'Ambiguous replacements require replace_all=true. Styling, images, frames, and visual layout are not edited.',
    'Changed files are downloadable; final layout and overset acceptance remains human.',
  ].join('\n');
}

function createIdmlEditTool({ req }) {
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
          const report = await inspectIdml({ req, args });
          return [JSON.stringify(report), { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: [] } }];
        }
        if (args?.action !== 'replace_text') {
          throw new IdmlError('action must be inspect or replace_text', 'invalid_action', 400);
        }
        const result = await editIdml({ req, args });
        logger.info('[edit_idml] completed', {
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
        logger.warn('[edit_idml] failed', {
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
  applyTextEdits,
  buildIdmlToolContext,
  createIdmlEditTool,
  editIdml,
  inspectParsed,
  isIdmlFile,
};

'use strict';

const path = require('path');
const { v4 } = require('uuid');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { SaxesParser } = require('@knauf/knauf/server/saxes');
const {
  getCloudFrontConfig,
  getStorageMetadata,
  getS3Key,
  getToolDefinition,
  recordFileTranslationOutcome,
  sanitizeFilename,
} = require('@librechat/api');
const { Constants, FileSources, isKnaufSourceCodeFile } = require('librechat-data-provider');
const {
  IDML_MIME,
  IdmlError,
  assertValidXmlCharacters,
  buildIdml,
  decodeXmlBuffer,
  normalizeLocale,
  parseIdml,
  validateXmlStructure,
} = require('../idml/core');
const {
  AZURE_BATCH_GLOSSARY_MAX_BYTES,
  AZURE_SYNC_GLOSSARY_MAX_BYTES,
  glossaryForRequest,
  mergePreservedTerms,
  translateBatchWithAzure,
  translateDocumentWithAzure,
  translateWithAzure,
} = require('./providers/azure');
const {
  detectProtectedLogo,
  maskRegionForTranslation,
  restoreProtectedRegion,
} = require('./logoProtection');
const { compressTranslatedPdf } = require('./pdfCompression');
const { getRetentionExpiry } = require('../../retention');
const { getStrategyFunctions } = require('../../strategies');
const {
  classifyTranslationError,
  enqueueTranslationJob,
  getOwnedTranslationJob,
  getTranslationJobConfig,
  requestTranslationCancellation,
} = require('./jobs');
const db = require('~/models');

const TOOL_NAME = 'translate_file';
const STATUS_TOOL_NAME = 'translation_status';
const FILE_TRANSLATION_ARTIFACT_KEY = 'knauf_file_translation';
const OUTPUT_CONTEXT = 'knauf_file_translation';
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_SEGMENTED_BYTES = 25 * 1024 * 1024;
const AZURE_SYNC_INPUT_BYTES = 10 * 1024 * 1024;
const AZURE_BATCH_DOCUMENT_BYTES = 40 * 1024 * 1024;
const AZURE_BATCH_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_XML_NODES = 100000;
const MAX_XML_SEGMENTS = 10000;
const MAX_XML_CHARACTERS = 500000;
const MAX_XML_ATTRIBUTES = 10000;
const MAX_XML_ATTRIBUTE_CHARACTERS = 500000;
const MAX_XML_DEPTH = 256;
const MAX_STRUCTURED_SEGMENTS = 10000;
const MAX_STRUCTURED_CHARACTERS = 500000;
const MAX_PRESERVE_TERMS = 100;
const MAX_PRESERVE_TERM_CHARACTERS = 200;

const FORMATS = {
  idml: { mime: IDML_MIME, mode: 'idml' },
  pdf: { mime: 'application/pdf', mode: 'batch' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mode: 'document',
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mode: 'document',
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mode: 'document',
  },
  csv: { mime: 'text/csv', mode: 'document' },
  txt: { mime: 'text/plain', mode: 'document' },
  md: { mime: 'text/markdown', mode: 'markdown' },
  markdown: { mime: 'text/markdown', mode: 'markdown' },
  json: { mime: 'application/json', mode: 'json' },
  xml: { mime: 'application/xml', mode: 'xml' },
  svg: { mime: 'image/svg+xml', mode: 'svg' },
  png: { mime: 'image/png', mode: 'image' },
  jpg: { mime: 'image/jpeg', mode: 'image' },
  jpeg: { mime: 'image/jpeg', mode: 'image' },
  webp: { mime: 'image/webp', mode: 'image' },
};
const MIME_FORMATS = new Map(
  Object.entries(FORMATS).map(([extension, format]) => [format.mime, { ...format, extension }]),
);
MIME_FORMATS.set('application/csv', { ...FORMATS.csv, extension: 'csv' });
MIME_FORMATS.set('text/xml', { ...FORMATS.xml, extension: 'xml' });
MIME_FORMATS.set('image/svg', { ...FORMATS.svg, extension: 'svg' });
const FONT_VALIDATION_NOT_APPLICABLE = new Set(['csv', 'txt', 'md', 'markdown', 'json', 'xml']);

function formatForFile(file) {
  const filename = file?.filename ?? file?.name ?? '';
  if (isKnaufSourceCodeFile(filename, file?.type)) {
    return null;
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  return extension && FORMATS[extension]
    ? { ...FORMATS[extension], extension }
    : (MIME_FORMATS.get(file?.type) ?? null);
}

const isTranslatableFile = (file) => formatForFile(file) != null;

const fontValidationForFormat = (format) =>
  FONT_VALIDATION_NOT_APPLICABLE.has(format.extension) ? 'not_applicable' : 'human_required';

const isFileTranslationConfigured = () =>
  process.env.KNAUF_FILE_TRANSLATION_ENABLED === 'true' &&
  Boolean(process.env.AZURE_TRANSLATOR_ENDPOINT && process.env.AZURE_TRANSLATOR_KEY);

function requestToolFiles(req) {
  if (Array.isArray(req?.knaufToolFiles)) {
    return req.knaufToolFiles;
  }
  return Array.isArray(req?.body?.files) ? req.body.files : [];
}

function requestedFileIds(req, predicate = isTranslatableFile) {
  return Array.from(
    new Set(
      requestToolFiles(req)
        .filter(predicate)
        .map((file) => file?.file_id)
        .filter((fileId) => typeof fileId === 'string' && fileId.length > 0),
    ),
  );
}

async function resolveInputFiles(req, predicate = isTranslatableFile) {
  const fileIds = requestedFileIds(req, predicate);
  if (fileIds.length === 0) {
    throw new IdmlError('Attach a supported file to the current message', 'file_not_attached', 400);
  }
  const query = { file_id: { $in: fileIds }, user: req.user.id };
  if (req.user.tenantId) {
    query.tenantId = req.user.tenantId;
  }
  const files = await db.getFiles(query);
  const byId = new Map(files.filter(predicate).map((file) => [file.file_id, file]));
  if (byId.size !== fileIds.length) {
    throw new IdmlError('One or more attached files are unavailable', 'file_not_found', 404);
  }
  return fileIds.map((fileId) => byId.get(fileId));
}

async function resolveInputFileResults(req, predicate = isTranslatableFile) {
  const requested = requestToolFiles(req).filter(predicate);
  const fileIds = requestedFileIds(req, predicate);
  if (fileIds.length === 0) {
    throw new IdmlError('Attach a supported file to the current message', 'file_not_attached', 400);
  }
  const query = { file_id: { $in: fileIds }, user: req.user.id };
  if (req.user.tenantId) {
    query.tenantId = req.user.tenantId;
  }
  const files = await db.getFiles(query);
  const byId = new Map(files.filter(predicate).map((file) => [file.file_id, file]));
  const names = new Map(
    requested.map((file) => [file.file_id, file.filename ?? file.name ?? 'attached file']),
  );
  const outputIds = new Map(requested.map((file) => [file.file_id, file.output_file_id]));
  return fileIds.map((fileId) =>
    byId.has(fileId)
      ? {
          status: 'fulfilled',
          value: { ...byId.get(fileId), output_file_id: outputIds.get(fileId) },
        }
      : {
          status: 'rejected',
          filename: names.get(fileId),
          reason: new IdmlError('Attached file is unavailable', 'file_not_found', 404),
        },
  );
}

function selectTranslationFiles(files, args = {}, currentMessageFileIds = []) {
  const filenames = args?.filenames;
  const allFiles = args?.all_files;
  if (
    (allFiles != null && typeof allFiles !== 'boolean') ||
    (filenames != null &&
      (!Array.isArray(filenames) ||
        filenames.length === 0 ||
        filenames.length > 20 ||
        filenames.some((name) => typeof name !== 'string' || !name || name.length > 255) ||
        new Set(filenames).size !== filenames.length)) ||
    (allFiles === true && filenames != null)
  ) {
    throw new IdmlError(
      'Choose either unique filenames or all_files=true',
      'invalid_translation_file_selection',
      400,
    );
  }
  if (filenames) {
    return filenames.map((filename) => {
      const matches = files.filter((file) => (file.filename ?? file.name) === filename);
      if (!matches.length) {
        throw new IdmlError(
          `Translation file is not available: ${filename}`,
          'translation_file_not_found',
          404,
        );
      }
      if (matches.length > 1) {
        throw new IdmlError(
          `More than one available file is named ${filename}`,
          'translation_file_ambiguous',
          409,
        );
      }
      return matches[0];
    });
  }
  if (allFiles === true) {
    return files;
  }
  const currentFileIdSet = new Set(currentMessageFileIds);
  const currentCandidates = files.filter((file) => currentFileIdSet.has(file.file_id));
  if (currentFileIdSet.size === 0) {
    throw new IdmlError(
      `Choose filenames or set all_files=true. Available files: ${files
        .map((file) => file.filename ?? file.name ?? 'attached file')
        .join(', ')}`,
      'translation_file_selection_required',
      409,
    );
  }
  if (currentCandidates.length === 0) {
    throw new IdmlError(
      'No supported file is attached to the current message. Choose an explicit filename or attach a supported file.',
      'translation_file_selection_required',
      409,
    );
  }
  const implicitCandidates = currentCandidates;
  if (implicitCandidates.length > 1) {
    throw new IdmlError(
      `Choose filenames or set all_files=true. Available files: ${implicitCandidates
        .map((file) => file.filename ?? file.name ?? 'attached file')
        .join(', ')}`,
      'translation_file_selection_required',
      409,
    );
  }
  return implicitCandidates;
}

function currentMessageTranslationFiles(req, files) {
  const currentFileIds = Array.isArray(req?.knaufCurrentMessageFileIds)
    ? req.knaufCurrentMessageFileIds
    : [];
  return files.filter((file) => currentFileIds.includes(file.file_id));
}

const cancellationError = () =>
  new IdmlError('Translation was cancelled', 'translation_cancelled', 499);

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

async function readFileBuffer(req, file, signal) {
  throwIfAborted(signal);
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    throw new IdmlError('File storage source cannot be read', 'storage_unavailable', 503);
  }
  const stream = await getDownloadStream(req, file.storageKey || file.filepath);
  throwIfAborted(signal);
  const chunks = [];
  let bytes = 0;
  const onAbort = () => stream.destroy?.(cancellationError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) {
        stream.destroy?.();
        throw new IdmlError('File exceeds the 50 MB translation limit', 'invalid_size');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (signal?.aborted) {
      throw cancellationError();
    }
    if (error instanceof IdmlError) {
      throw error;
    }
    throw new IdmlError('Unable to read the attached file', 'storage_read_failed', 503);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks, bytes);
}

function outputFilename(sourceName, targetLocale, fallbackExtension) {
  const extension = path.extname(sourceName) || `.${fallbackExtension}`;
  const stem = path.basename(sourceName, extension);
  const locale = targetLocale.replace(/[^A-Za-z0-9-]/g, '-');
  return sanitizeFilename(`${stem}_${locale}${extension}`);
}

function buildTranslationStorageLocator({ req, fileId, filename, mimeType }) {
  const source = req.config.fileStrategy;
  const userId = String(req.user.id);
  const tenantId = req.user.tenantId ?? null;
  const storageFileName = `${fileId}__${filename}`;
  const storagePath = `uploads/${userId}/${storageFileName}`;
  let filepath;
  let storageKey = null;
  if (source === FileSources.s3 || source === FileSources.cloudfront) {
    const cloudFrontConfig = source === FileSources.cloudfront ? getCloudFrontConfig() : null;
    const includeRegionInPath = cloudFrontConfig?.includeRegionInPath ?? false;
    storageKey = getS3Key({
      basePath: 'uploads',
      userId,
      fileName: storageFileName,
      tenantId,
      ...(source === FileSources.cloudfront
        ? {
            includeRegionInPath,
            storageRegion: cloudFrontConfig?.storageRegion ?? process.env.AWS_REGION,
            useInlinePath: false,
          }
        : {}),
    });
    filepath = storageKey;
  } else if (source === FileSources.firebase) {
    filepath = `https://translation.invalid/o/${encodeURIComponent(storagePath)}`;
  } else if (source === FileSources.azure_blob) {
    const container = process.env.AZURE_CONTAINER_NAME ?? 'files';
    filepath = `https://translation.invalid/${container}/${storagePath}`;
  } else {
    filepath = `/${storagePath}`;
  }
  return {
    file_id: fileId,
    source,
    filepath,
    storageKey,
    filename,
    type: mimeType,
  };
}

async function persistOutput({
  req,
  buffer,
  filename,
  mimeType,
  conversationId,
  fileId = v4(),
  signal,
}) {
  const source = req.config.fileStrategy;
  const { saveBuffer, deleteFile } = getStrategyFunctions(source);
  if (!saveBuffer) {
    throw new IdmlError('Configured file storage cannot save output', 'storage_unavailable', 503);
  }
  const locator = buildTranslationStorageLocator({ req, fileId, filename, mimeType });
  const deletionFile = (storedPath) => ({
    ...locator,
    user: req.user.id,
    tenantId: req.user.tenantId ?? null,
    filepath: storedPath ?? locator.filepath,
  });
  const fence = () => req.knaufTranslationWriteFence?.({ outputFileId: fileId });
  throwIfAborted(signal);
  await fence();
  if (req.knaufTranslationPrepareStorageLocator) {
    const prepared = await req.knaufTranslationPrepareStorageLocator(locator);
    if (!prepared) {
      throw new IdmlError(
        'Translation attempt is no longer writable',
        'translation_fence_lost',
        409,
      );
    }
  }
  const writeController = new AbortController();
  const onAbort = () => writeController.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = getTranslationJobConfig().storageWriteTimeoutMs;
  const timeout = setTimeout(
    () =>
      writeController.abort(
        Object.assign(new Error('translation output storage write timed out'), {
          code: 'storage_write_timeout',
        }),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  let filepath;
  const savePromise = Promise.resolve().then(() =>
    saveBuffer({
      userId: req.user.id,
      tenantId: req.user.tenantId,
      buffer,
      fileName: `${fileId}__${filename}`,
      basePath: 'uploads',
      signal: writeController.signal,
      abortSignal: writeController.signal,
      timeoutMs,
    }),
  );
  try {
    filepath = await Promise.race([
      savePromise,
      new Promise((_, reject) =>
        writeController.signal.addEventListener(
          'abort',
          () => reject(writeController.signal.reason ?? cancellationError()),
          { once: true },
        ),
      ),
    ]);
  } catch (error) {
    if (writeController.signal.aborted) {
      void savePromise
        .then(async (latePath) => {
          try {
            await deleteFile?.(req, deletionFile(latePath));
          } catch {
            logger.warn('[translate_file] failed to reap a late fenced output blob', {
              fileId,
              source,
            });
          }
        })
        .catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
  try {
    throwIfAborted(signal);
    await fence();
  } catch (error) {
    try {
      await deleteFile?.(req, deletionFile(filepath));
    } catch {
      logger.warn('[translate_file] failed to roll back a fenced output blob', {
        fileId,
        source,
      });
    }
    throw error;
  }
  try {
    const storageMetadata = getStorageMetadata({ filepath, source });
    let retentionExpiry;
    if (Object.prototype.hasOwnProperty.call(req, 'knaufTranslationOutputExpiresAt')) {
      retentionExpiry = req.knaufTranslationOutputExpiresAt
        ? { expiredAt: req.knaufTranslationOutputExpiresAt }
        : {};
    } else {
      retentionExpiry = await getRetentionExpiry(req);
    }
    const file = await db.createFile(
      {
        user: req.user.id,
        tenantId: req.user.tenantId,
        conversationId:
          conversationId && conversationId !== Constants.NEW_CONVO ? conversationId : undefined,
        file_id: fileId,
        bytes: buffer.length,
        filepath,
        ...storageMetadata,
        filename,
        object: 'file',
        type: mimeType,
        context: OUTPUT_CONTEXT,
        source,
        usage: 1,
        ...retentionExpiry,
      },
      true,
      { userId: req.user.id, tenantId: req.user.tenantId ?? null },
    );
    if (!file) {
      throw new Error('metadata insert returned no file');
    }
    const persisted = typeof file.toObject === 'function' ? file.toObject() : file;
    try {
      throwIfAborted(signal);
      await fence();
    } catch (error) {
      error.outputFiles = [persisted];
      throw error;
    }
    return persisted;
  } catch (writeError) {
    if (writeError?.outputFiles) {
      throw writeError;
    }
    let existing;
    try {
      [existing] = await db.getFiles({
        file_id: fileId,
        user: req.user.id,
        ...(req.user.tenantId ? { tenantId: req.user.tenantId } : {}),
      });
    } catch {
      logger.warn('[translate_file] retained output blob after ambiguous metadata write', {
        fileId,
        source,
      });
      throw new IdmlError(
        'Output file metadata could not be verified',
        'storage_write_failed',
        503,
      );
    }
    if (existing) {
      const persisted = typeof existing.toObject === 'function' ? existing.toObject() : existing;
      try {
        throwIfAborted(signal);
        await fence();
      } catch (error) {
        error.outputFiles = [persisted];
        throw error;
      }
      return persisted;
    }
    try {
      await deleteFile?.(req, deletionFile(filepath));
    } catch {
      logger.warn('[translate_file] failed to roll back an unregistered output blob', {
        fileId,
        source,
      });
    }
    throw new IdmlError('Output file metadata could not be saved', 'storage_write_failed', 503);
  }
}

function buildOffsetAdapter(source, candidates, encode = (value) => value) {
  const segments = candidates.map((candidate, index) => ({
    id: `t${index}`,
    source: candidate.source,
  }));
  return {
    segments,
    build(translations) {
      const output = [];
      let cursor = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const translated = translations.get(`t${index}`);
        if (typeof translated !== 'string') {
          throw new IdmlError('Translation omitted a text segment', 'segment_mismatch', 502);
        }
        output.push(source.slice(cursor, candidate.start), encode(translated));
        cursor = candidate.end;
      }
      output.push(source.slice(cursor));
      return Buffer.from(output.join(''), 'utf8');
    },
  };
}

function retainCandidate(candidates, candidate, budget, label) {
  budget.characters += candidate.source.length;
  if (
    candidates.length >= MAX_STRUCTURED_SEGMENTS ||
    budget.characters > MAX_STRUCTURED_CHARACTERS
  ) {
    throw new IdmlError(`${label} contains too much translatable text`, 'too_many_segments', 400);
  }
  candidates.push(candidate);
}

function jsonAdapter(buffer) {
  const source = buffer.toString('utf8');
  const candidates = [];
  const budget = { characters: 0 };
  const strings = /"(?:\\.|[^"\\])*"/g;
  for (const match of source.matchAll(strings)) {
    const end = match.index + match[0].length;
    const whitespace = source.slice(end).match(/^\s*/)[0].length;
    if (source[end + whitespace] === ':') {
      continue;
    }
    let value;
    try {
      value = JSON.parse(match[0]);
    } catch {
      throw new IdmlError('Attached JSON is malformed', 'invalid_json', 400);
    }
    if (typeof value === 'string' && /\p{L}/u.test(value)) {
      retainCandidate(candidates, { start: match.index, end, source: value }, budget, 'JSON');
    }
  }
  try {
    JSON.parse(source);
  } catch {
    throw new IdmlError('Attached JSON is malformed', 'invalid_json', 400);
  }
  return buildOffsetAdapter(source, candidates, (value) => JSON.stringify(value));
}

function markdownLinkRanges(line) {
  const ranges = [];
  for (const match of line.matchAll(/\]\[([^\]\r\n]*)\]/g)) {
    ranges.push({ start: match.index + 2, end: match.index + match[0].length - 1 });
  }
  let searchFrom = 0;
  while (searchFrom < line.length) {
    const opening = line.indexOf('](', searchFrom);
    if (opening < 0) {
      break;
    }
    let depth = 0;
    let escaped = false;
    let closing = -1;
    for (let index = opening + 2; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')' && depth > 0) {
        depth -= 1;
      } else if (character === ')') {
        closing = index;
        break;
      }
    }
    if (closing < 0) {
      break;
    }
    ranges.push({ start: opening + 2, end: closing });
    searchFrom = closing + 1;
  }
  return ranges;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function markdownAdapter(buffer) {
  const source = buffer.toString('utf8');
  const candidates = [];
  const budget = { characters: 0 };
  let offset = 0;
  let fence = null;
  for (const lineMatch of source.matchAll(/.*(?:\r?\n|$)/g)) {
    const line = lineMatch[0];
    if (!line) {
      continue;
    }
    const content = line.replace(/\r?\n$/, '');
    const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!fence) {
        fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      } else if (
        fence.character === fenceMatch[1][0] &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim() === ''
      ) {
        fence = null;
      }
      offset += line.length;
      continue;
    }
    if (!fence && !/^(?: {4}|\t)/.test(line) && !/^ {0,3}\[[^\]\r\n]+\]:/.test(line)) {
      const protectedRanges = mergeRanges([
        ...Array.from(
          line.matchAll(/`+[^`\r\n]*`+|https?:\/\/[^\s<>)\]]+|<[^>\r\n]+>/g),
          (match) => ({ start: match.index, end: match.index + match[0].length }),
        ),
        ...markdownLinkRanges(line),
      ]);
      let cursor = 0;
      for (const protectedRange of [...protectedRanges, { start: line.length, end: line.length }]) {
        const chunk = line.slice(cursor, protectedRange.start);
        for (const match of chunk.matchAll(/[^\u005B\u005D()*_~#>|\r\n]+/g)) {
          const value = match[0];
          const leading = value.match(/^\s*/)[0].length;
          const trailing = value.match(/\s*$/)[0].length;
          const text = value.slice(leading, trailing ? value.length - trailing : undefined);
          if (/\p{L}/u.test(text)) {
            const start = offset + cursor + match.index + leading;
            retainCandidate(
              candidates,
              { start, end: start + text.length, source: text },
              budget,
              'Markdown',
            );
          }
        }
        cursor = protectedRange.end;
      }
    }
    offset += line.length;
  }
  return buildOffsetAdapter(source, candidates);
}

function svgAdapter(buffer) {
  const source = decodeXmlBuffer(buffer, 'SVG');
  validateXmlStructure(source, 'SVG', {
    maxNodes: MAX_XML_NODES,
    maxDepth: MAX_XML_DEPTH,
    maxAttributes: MAX_XML_ATTRIBUTES,
    maxAttributeCharacters: MAX_XML_ATTRIBUTE_CHARACTERS,
  });
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(source, 'image/svg+xml');
  if (errors.length || document.getElementsByTagName('parsererror').length) {
    throw new IdmlError('Attached SVG is malformed', 'invalid_xml', 400);
  }
  const nodes = [];
  let characters = 0;
  for (const tagName of ['text', 'tspan']) {
    for (const element of Array.from(document.getElementsByTagName(tagName))) {
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === 3 && /\p{L}/u.test(node.data)) {
          characters += node.data.length;
          if (nodes.length >= MAX_STRUCTURED_SEGMENTS || characters > MAX_STRUCTURED_CHARACTERS) {
            throw new IdmlError(
              'SVG contains too much translatable text',
              'too_many_segments',
              400,
            );
          }
          nodes.push(node);
        }
      }
    }
  }
  const segments = nodes.map((node, index) => ({ id: `t${index}`, source: node.data }));
  return {
    segments,
    build(translations) {
      nodes.forEach((node, index) => {
        const translated = translations.get(`t${index}`);
        if (typeof translated !== 'string') {
          throw new IdmlError('Translation omitted an SVG text segment', 'segment_mismatch', 502);
        }
        assertValidXmlCharacters(translated, 'SVG translation');
        node.data = translated;
      });
      return Buffer.from(new XMLSerializer().serializeToString(document), 'utf8');
    },
  };
}

function xmlTextRanges(source) {
  const ranges = [];
  const comments = [];
  const processingInstructions = [];
  let depth = 0;
  let boundary = 0;
  try {
    const parser = new SaxesParser();
    parser.on('error', (error) => {
      throw error;
    });
    parser.on('opentag', () => {
      depth += 1;
      boundary = parser.position;
    });
    parser.on('text', (text) => {
      const end = parser.position - 1;
      if (depth > 0 && end > boundary) {
        ranges.push({ type: 'text', text, start: boundary, end });
      }
      boundary = end;
    });
    parser.on('cdata', (text) => {
      const end = parser.position;
      const opening = source.lastIndexOf('<![CDATA[', end - 3);
      if (depth <= 0 || opening !== boundary || source.slice(end - 3, end) !== ']]>') {
        throw new IdmlError('Attached XML has invalid CDATA offsets', 'invalid_xml', 400);
      }
      ranges.push({ type: 'cdata', text, start: opening + 9, end: end - 3 });
      boundary = end;
    });
    parser.on('closetag', () => {
      depth -= 1;
      boundary = parser.position;
    });
    parser.on('comment', (text) => {
      comments.push({ text });
      boundary = parser.position;
    });
    parser.on('processinginstruction', ({ target, body }) => {
      processingInstructions.push({ target, body });
      boundary = parser.position;
    });
    for (const event of ['xmldecl', 'doctype']) {
      parser.on(event, () => {
        boundary = parser.position;
      });
    }
    parser.write(source).close();
  } catch (error) {
    if (error instanceof IdmlError) throw error;
    throw new IdmlError('Attached XML is malformed', 'invalid_xml', 400);
  }
  return { comments, processingInstructions, ranges };
}

function escapeXmlTextValue(value) {
  assertValidXmlCharacters(value, 'XML translation');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;');
}

function xmlAdapter(buffer) {
  const source = decodeXmlBuffer(buffer, 'XML');
  validateXmlStructure(source, 'XML', {
    maxNodes: MAX_XML_NODES,
    maxDepth: MAX_XML_DEPTH,
    maxAttributes: MAX_XML_ATTRIBUTES,
    maxAttributeCharacters: MAX_XML_ATTRIBUTE_CHARACTERS,
  });
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(source, 'application/xml');
  if (
    errors.length ||
    !document.documentElement ||
    document.getElementsByTagName('parsererror').length
  ) {
    throw new IdmlError('Attached XML is malformed', 'invalid_xml', 400);
  }

  const { comments, processingInstructions, ranges } = xmlTextRanges(source);
  let rangeIndex = 0;
  const nodes = [];
  const elements = [];
  const stack = [
    { node: document.documentElement, path: `/${document.documentElement.nodeName}[1]` },
  ];
  let visited = 0;
  let characters = 0;
  let attributeCount = 0;
  let attributeCharacters = 0;
  while (stack.length) {
    const { node: current, path: currentPath } = stack.pop();
    visited += 1;
    if (visited > MAX_XML_NODES) {
      throw new IdmlError('XML contains too many nodes', 'too_many_nodes', 400);
    }
    if (current.nodeType === 1) {
      const attributes = {};
      for (const attribute of Array.from(current.attributes ?? [])) {
        attributeCount += 1;
        attributeCharacters += attribute.name.length + attribute.value.length;
        if (
          attributeCount > MAX_XML_ATTRIBUTES ||
          attributeCharacters > MAX_XML_ATTRIBUTE_CHARACTERS
        ) {
          throw new IdmlError('XML contains too much attribute data', 'too_many_attributes', 400);
        }
        attributes[attribute.name] = attribute.value;
      }
      elements.push({ path: currentPath, attributes });
      const children = [];
      const elementCounts = new Map();
      let textIndex = 0;
      for (let child = current.firstChild; child; child = child.nextSibling) {
        let childPath;
        if (child.nodeType === 1) {
          const index = (elementCounts.get(child.nodeName) ?? 0) + 1;
          elementCounts.set(child.nodeName, index);
          childPath = `${currentPath}/${child.nodeName}[${index}]`;
        } else if ([3, 4].includes(child.nodeType)) {
          textIndex += 1;
          childPath = `${currentPath}/text()[${textIndex}]`;
        }
        children.push({ node: child, path: childPath });
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
      continue;
    }
    if (![3, 4].includes(current.nodeType)) {
      continue;
    }
    const range = ranges[rangeIndex];
    const expectedType = current.nodeType === 4 ? 'cdata' : 'text';
    if (!range || range.type !== expectedType || range.text !== current.data) {
      throw new IdmlError('Attached XML text offsets could not be verified', 'invalid_xml', 400);
    }
    rangeIndex += 1;
    const match = (current.data ?? '').match(/^(\s*)([\s\S]*?)(\s*)$/u);
    const text = match?.[2] ?? current.data ?? '';
    if (
      /\p{L}/u.test(text) &&
      !/^(?:https?:\/\/|www\.|mailto:|[^\s@]+@[^\s@]+\.[^\s@]+)\S*$/iu.test(text)
    ) {
      characters += text.length;
      if (nodes.length >= MAX_XML_SEGMENTS || characters > MAX_XML_CHARACTERS) {
        throw new IdmlError('XML contains too much translatable text', 'too_many_segments', 400);
      }
      nodes.push({
        node: current,
        prefix: match?.[1] ?? '',
        suffix: match?.[3] ?? '',
        source: text,
        path: currentPath,
        range,
      });
    }
  }
  if (rangeIndex !== ranges.length) {
    throw new IdmlError('Attached XML text offsets could not be verified', 'invalid_xml', 400);
  }

  const segments = nodes.map((item, index) => ({
    id: `x${index}`,
    source: item.source,
    path: item.path,
  }));
  return {
    segments,
    elements,
    comments,
    processingInstructions,
    build(translations) {
      const replacements = [];
      nodes.forEach((item, index) => {
        const translated = translations.get(`x${index}`);
        if (typeof translated !== 'string') {
          throw new IdmlError('Translation omitted an XML text segment', 'segment_mismatch', 502);
        }
        if (translated === item.source) {
          return;
        }
        assertValidXmlCharacters(translated, 'XML translation');
        const value = `${item.prefix}${translated}${item.suffix}`;
        if (item.range.type === 'cdata') {
          if (translated.includes(']]>')) {
            throw new IdmlError(
              'XML CDATA edit contains a forbidden ]]> sequence',
              'invalid_edit',
              400,
            );
          }
          if (translated.includes('\r')) {
            throw new IdmlError(
              'XML CDATA edits cannot contain carriage returns',
              'invalid_edit',
              400,
            );
          }
          replacements.push({ ...item.range, value });
          return;
        }
        replacements.push({ ...item.range, value: escapeXmlTextValue(value) });
      });
      let cursor = 0;
      const output = [];
      for (const replacement of replacements) {
        output.push(source.slice(cursor, replacement.start), replacement.value);
        cursor = replacement.end;
      }
      output.push(source.slice(cursor));
      return Buffer.from(output.join(''), 'utf8');
    },
  };
}

function dictionaryEntryCount(glossary) {
  return (
    glossary.stats.dictionaryRetained ??
    glossary.stats.dictionaryApplied ??
    glossary.stats.applied ??
    glossary.entries.length
  );
}

function protectedOnlyGlossary({ baseStats, preserveTerms, segments, filterToDocument, maxBytes }) {
  return mergePreservedTerms(
    { entries: [], stats: { ...baseStats, applied: 0, bytes: 0 } },
    preserveTerms,
    segments,
    { filterToDocument, maxBytes },
  );
}

function markProtectedTermsRequired(error, glossary) {
  if ((glossary.stats.preservedApplied ?? 0) > 0 && error && typeof error === 'object') {
    error.protectedTermsRequired = true;
  }
  return error;
}

async function translateWithOptionalGlossaryFallback({
  translate,
  glossary,
  preserveTerms,
  segments,
  filterToDocument,
  maxBytes,
}) {
  try {
    return { result: await translate(glossary), glossary };
  } catch (error) {
    const dictionaryApplied = dictionaryEntryCount(glossary);
    const optionalDictionaryRejected =
      dictionaryApplied > 0 &&
      (error?.translationBatchesCompleted ?? 0) === 0 &&
      process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED !== 'true' &&
      error?.code === 'translator_rejected';
    if (!optionalDictionaryRejected) {
      throw markProtectedTermsRequired(error, glossary);
    }

    logger.warn(
      '[translate_file] Azure rejected the optional managed glossary; retrying without managed entries',
      {
        code: error.code,
        preserveTermCount: preserveTerms.length,
      },
    );
    const fallback = protectedOnlyGlossary({
      baseStats: glossary.stats,
      preserveTerms,
      segments,
      filterToDocument,
      maxBytes,
    });
    fallback.stats = {
      ...fallback.stats,
      dictionaryConfigured:
        glossary.stats.dictionaryConfigured ?? Boolean(glossary.stats.configured),
      dictionaryRequested: dictionaryApplied,
      dictionaryApplied: 0,
      dictionaryRetained: 0,
      requested: dictionaryApplied,
      reason: preserveTerms.length > 0 ? 'dictionary_provider_rejected' : 'provider_rejected',
    };

    try {
      return { result: await translate(fallback), glossary: fallback };
    } catch (fallbackError) {
      throw markProtectedTermsRequired(fallbackError, fallback);
    }
  }
}

async function translateOneFile({
  req,
  file,
  sourceLocale,
  targetLocale,
  preserveTerms = [],
  signal,
}) {
  throwIfAborted(signal);
  const format = formatForFile(file);
  const input = await readFileBuffer(req, file, signal);
  const startedAt = Date.now();
  let result;
  let output;
  let segments = [];
  let glossary;
  let layoutValidation = 'human_required';
  let fontValidation = fontValidationForFormat(format);

  if (format.mode === 'idml') {
    if (input.length > MAX_SEGMENTED_BYTES) {
      throw new IdmlError('IDML exceeds the 25 MB translation limit', 'invalid_size');
    }
    const parsed = await parseIdml(input);
    segments = parsed.segments;
    glossary = mergePreservedTerms(
      await glossaryForRequest({ sourceLocale, targetLocale, segments }),
      preserveTerms,
      segments,
    );
    if (segments.length) {
      ({ result, glossary } = await translateWithOptionalGlossaryFallback({
        translate: (requestGlossary) =>
          translateWithAzure({
            segments,
            sourceLocale,
            targetLocale,
            glossary: requestGlossary,
            signal,
          }),
        glossary,
        preserveTerms,
        segments,
        filterToDocument: true,
        maxBytes: AZURE_SYNC_GLOSSARY_MAX_BYTES,
      }));
    } else {
      result = { translations: new Map(), providerLocale: targetLocale, batches: 0 };
    }
    const built = await buildIdml(parsed, result.translations);
    output = built.buffer;
    fontValidation = built.fontValidation;
  } else if (['json', 'markdown', 'xml', 'svg'].includes(format.mode)) {
    if (input.length > MAX_SEGMENTED_BYTES) {
      throw new IdmlError(
        'Structured text file exceeds the 25 MB translation limit',
        'invalid_size',
      );
    }
    let adapter;
    if (format.mode === 'json') {
      adapter = jsonAdapter(input);
    } else if (format.mode === 'markdown') {
      adapter = markdownAdapter(input);
    } else if (format.mode === 'xml') {
      adapter = xmlAdapter(input);
    } else {
      adapter = svgAdapter(input);
    }
    segments = adapter.segments;
    glossary = mergePreservedTerms(
      await glossaryForRequest({ sourceLocale, targetLocale, segments }),
      preserveTerms,
      segments,
    );
    if (segments.length) {
      ({ result, glossary } = await translateWithOptionalGlossaryFallback({
        translate: (requestGlossary) =>
          translateWithAzure({
            segments,
            sourceLocale,
            targetLocale,
            glossary: requestGlossary,
            signal,
          }),
        glossary,
        preserveTerms,
        segments,
        filterToDocument: true,
        maxBytes: AZURE_SYNC_GLOSSARY_MAX_BYTES,
      }));
    } else {
      result = { translations: new Map(), providerLocale: targetLocale, batches: 0 };
    }
    output = adapter.build(result.translations);
    layoutValidation = ['json', 'xml'].includes(format.mode) ? 'not_applicable' : 'human_required';
  } else {
    const isImage = format.mode === 'image';
    const translateTextWithinImage = ['docx', 'pptx'].includes(
      path.extname(file.filename).slice(1).toLowerCase(),
    );
    glossary = mergePreservedTerms(
      await glossaryForRequest({
        sourceLocale,
        targetLocale,
        segments: [],
        filterToDocument: false,
        maxBytes: AZURE_BATCH_GLOSSARY_MAX_BYTES,
      }),
      preserveTerms,
      [],
      { filterToDocument: false, maxBytes: AZURE_BATCH_GLOSSARY_MAX_BYTES },
    );
    const mustBatch =
      isImage ||
      format.mode === 'batch' ||
      input.length > AZURE_SYNC_INPUT_BYTES ||
      (glossary.stats.bytes ?? 0) > AZURE_SYNC_GLOSSARY_MAX_BYTES;
    const limit = isImage ? AZURE_BATCH_IMAGE_BYTES : AZURE_BATCH_DOCUMENT_BYTES;
    if (mustBatch && input.length > limit) {
      throw new IdmlError(
        `${isImage ? 'Image' : 'Document'} exceeds Azure Translator's ${limit / 1024 / 1024} MB batch limit`,
        'invalid_size',
      );
    }
    // [knauf] Protect known brand marks (e.g. the Knauf wordmark) from being
    // OCR'd and redrawn by Azure's image translation. Detection failures are
    // swallowed: an undetected logo just behaves as it did before this change.
    let protectedLogoRegions = [];
    let translationInput = input;
    if (isImage) {
      try {
        protectedLogoRegions = await detectProtectedLogo(input, { signal });
        if (protectedLogoRegions.length) {
          let masked = await maskRegionForTranslation(input, protectedLogoRegions);
          // Masking re-encodes the whole image and can grow it enough to
          // blow past the size check we already passed above (measured up
          // to ~1.3x at the default quality; more for an originally
          // low-quality/high-compression source, since re-encoding at a
          // flat high quality can nearly double it). Before giving up on
          // protection outright, retry once at a lower re-encode quality —
          // still comfortably above what Azure's OCR needs to key on, and
          // far better than shipping the mark unprotected.
          if (masked.length > limit) {
            const retryQuality = 80;
            const retried = await maskRegionForTranslation(input, protectedLogoRegions, {
              quality: retryQuality,
            });
            if (retried.length <= limit) {
              logger.warn(
                '[translate_file] masked image exceeded Azure batch size limit; retried at lower quality',
                {
                  firstAttemptBytes: masked.length,
                  retryQuality,
                  retryBytes: retried.length,
                  limit,
                },
              );
              masked = retried;
            } else {
              logger.warn(
                '[translate_file] masked image exceeds Azure batch size limit even at reduced quality; translating unprotected',
                { firstAttemptBytes: masked.length, retryBytes: retried.length, limit },
              );
              protectedLogoRegions = [];
            }
          }
          if (protectedLogoRegions.length) {
            translationInput = masked;
            logger.info('[translate_file] masking protected logo region(s) before translation', {
              regions: protectedLogoRegions.map((region) => ({
                name: region.name,
                confidence: Number(region.confidence.toFixed(3)),
              })),
            });
          }
        }
      } catch (error) {
        // A cancelled translation must propagate as a cancellation, not be
        // reinterpreted as "detection merely failed" and silently continue
        // translating unprotected.
        if (signal?.aborted) {
          throw error;
        }
        logger.warn('[translate_file] logo protection detection failed; continuing unprotected', {
          message: error?.message,
        });
        protectedLogoRegions = [];
        translationInput = input;
      }
    }
    const translateDocument = (requestGlossary) =>
      (mustBatch ? translateBatchWithAzure : translateDocumentWithAzure)({
        buffer: translationInput,
        filename: file.filename,
        mimeType: format.mime,
        sourceLocale,
        targetLocale,
        glossary: requestGlossary,
        translateTextWithinImage,
        signal,
      });
    ({ result, glossary } = await translateWithOptionalGlossaryFallback({
      translate: translateDocument,
      glossary,
      preserveTerms,
      segments: [],
      filterToDocument: false,
      maxBytes: AZURE_BATCH_GLOSSARY_MAX_BYTES,
    }));
    output = result.buffer;
    if (isImage && protectedLogoRegions.length) {
      try {
        output = await restoreProtectedRegion(output, input, protectedLogoRegions);
      } catch (error) {
        logger.warn('[translate_file] logo restoration failed; output keeps Azure result', {
          message: error?.message,
        });
      }
    }
    // [knauf] Azure Document Translation rebuilds PDFs from scratch (full font
    // embedding, re-encoded images), which can multiply file size several
    // times over. Recompress before persisting; best-effort, never fails the
    // translation.
    if (format.mime === 'application/pdf') {
      output = await compressTranslatedPdf(output, { log: logger, signal });
    }
  }

  throwIfAborted(signal);
  const persisted = await persistOutput({
    req,
    buffer: output,
    filename: outputFilename(file.filename, targetLocale, format.extension),
    mimeType: format.mime,
    conversationId: req.body.conversationId,
    fileId: file.output_file_id,
    signal,
  });
  return {
    file: persisted,
    report: {
      sourceFile: file.filename,
      status: 'completed',
      provider: 'azure_translator',
      providerLocale: result.providerLocale,
      durationMs: Date.now() - startedAt,
      batches: result.batches,
      segments: segments.length,
      glossary: glossary.stats,
      layoutValidation,
      fontValidation,
    },
  };
}

async function mapLimited(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, run),
  );
  const rejected = lanes.find((lane) => lane.status === 'rejected');
  if (rejected) {
    rejected.reason.partialResults = results.filter(Boolean);
    throw rejected.reason;
  }
  return results;
}

function publicError(error) {
  if (error instanceof IdmlError) {
    return {
      code: error.code,
      error: error.message,
      retryAfter: error.retryAfter,
      ...(error.protectedTermsRequired ? { protectedTermsRequired: true } : {}),
    };
  }
  return { code: 'translation_transport_failed', error: 'Translation temporarily failed' };
}

function normalizePreserveTerms(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PRESERVE_TERMS) {
    throw new IdmlError(
      `preserve_terms must contain at most ${MAX_PRESERVE_TERMS} strings`,
      'invalid_preserve_terms',
      400,
    );
  }
  const terms = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new IdmlError(
        'preserve_terms must contain only strings',
        'invalid_preserve_terms',
        400,
      );
    }
    const term = item.trim();
    if (!term || term.length > MAX_PRESERVE_TERM_CHARACTERS || /[\t\r\n]/.test(term)) {
      throw new IdmlError(
        `Each preserved term must be 1-${MAX_PRESERVE_TERM_CHARACTERS} characters without tabs or newlines`,
        'invalid_preserve_terms',
        400,
      );
    }
    if (!seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms.sort();
}

async function translateFiles({ req, args, signal, expectedGlossaryRevision }) {
  throwIfAborted(signal);
  const configuredGlossaryRevision = process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION || 'none';
  if (expectedGlossaryRevision != null && expectedGlossaryRevision !== configuredGlossaryRevision) {
    throw new IdmlError(
      'The worker does not have the glossary revision pinned by this job',
      'glossary_revision_unavailable',
      503,
    );
  }
  const targetLocale = normalizeLocale(args?.target_locale, 'target_locale');
  const sourceLocale = args?.source_locale
    ? normalizeLocale(args.source_locale, 'source_locale')
    : null;
  const preserveTerms = normalizePreserveTerms(args?.preserve_terms);
  if (preserveTerms.length > 0 && !sourceLocale) {
    throw new IdmlError(
      'source_locale is required when preserving exact terms',
      'source_locale_required',
      400,
    );
  }
  if (sourceLocale && targetLocale.toLowerCase() === sourceLocale.toLowerCase()) {
    throw new IdmlError('Source and target locales must differ', 'same_locale', 400);
  }
  const inputFiles = await resolveInputFileResults(req);
  let settled;
  try {
    settled = await mapLimited(
      inputFiles,
      getTranslationJobConfig().fileConcurrency,
      async (input) => {
        if (input.status === 'rejected') {
          return input;
        }
        const file = input.value;
        try {
          return {
            status: 'fulfilled',
            value: await translateOneFile({
              req,
              file,
              sourceLocale,
              targetLocale,
              preserveTerms,
              signal,
            }),
          };
        } catch (error) {
          if (signal?.aborted) {
            throw cancellationError();
          }
          return { status: 'rejected', reason: error, filename: file.filename };
        }
      },
      signal,
    );
  } catch (error) {
    error.outputFiles = (error.partialResults ?? [])
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value.file);
    throw error;
  }
  const files = settled
    .filter((item) => item.status === 'fulfilled')
    .map((item) => item.value.file);
  const retryableFailure = settled.find(
    (item) => item.status === 'rejected' && classifyTranslationError(item.reason) !== 'permanent',
  );
  if (retryableFailure) {
    retryableFailure.reason.outputFiles = files;
    throw retryableFailure.reason;
  }
  const reports = settled.map((item) =>
    item.status === 'fulfilled'
      ? item.value.report
      : { sourceFile: item.filename, status: 'failed', ...publicError(item.reason) },
  );
  let status = 'partial';
  if (files.length === inputFiles.length) {
    status = 'completed';
  } else if (files.length === 0) {
    status = 'failed';
  }
  return {
    files,
    report: {
      status,
      sourceLocale,
      targetLocale,
      files: reports,
      layoutValidation: 'human_required',
    },
  };
}

async function outputFilesForJob(req, job) {
  if (!job?.output_file_ids?.length) return [];
  const query = { file_id: { $in: job.output_file_ids }, user: req.user.id };
  if (req.user.tenantId) query.tenantId = req.user.tenantId;
  const files = await db.getFiles(query);
  const byId = new Map(files.map((file) => [file.file_id, file]));
  return job.output_file_ids.map((fileId) => byId.get(fileId)).filter(Boolean);
}

async function jobToolResult(req, job) {
  const files = await outputFilesForJob(req, job);
  return {
    files,
    report: {
      jobId: job.job_id,
      status: job.status,
      sourceLocale: job.source_locale ?? 'auto',
      targetLocale: job.target_locale,
      attemptCount: job.attempt_count,
      ...(job.report ?? {}),
      ...(job.last_error_code ? { code: job.last_error_code, error: job.last_error_detail } : {}),
      ...(job.protected_terms_required ? { protectedTermsRequired: true } : {}),
      ...(job.cancel_requested_at && job.status === 'processing'
        ? { cancellation: 'requested' }
        : {}),
    },
  };
}

async function waitForTranslationJob({ req, job, signal }) {
  const deadline = Date.now() + getTranslationJobConfig().inlineWaitMs;
  let current = job;
  while (current?.active && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await getOwnedTranslationJob({
      user: req.user.id,
      tenantId: req.user.tenantId,
      jobId: job.job_id,
    });
  }
  return jobToolResult(req, current ?? job);
}

function sourceLocaleRequired(files, preserveTerms = []) {
  const glossaryConfigured =
    process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED === 'true' ||
    !['', 'none'].includes(process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION ?? 'none');
  return (
    glossaryConfigured ||
    preserveTerms.length > 0 ||
    files.some((file) =>
      ['idml', 'json', 'markdown', 'xml', 'svg'].includes(formatForFile(file)?.mode),
    )
  );
}

async function enqueueTranslationFiles({ req, args, signal }) {
  const targetLocale = normalizeLocale(args?.target_locale, 'target_locale');
  const sourceLocale = args?.source_locale
    ? normalizeLocale(args.source_locale, 'source_locale')
    : null;
  const preserveTerms = normalizePreserveTerms(args?.preserve_terms);
  const availableFiles = await resolveInputFiles(req);
  const files = selectTranslationFiles(
    availableFiles,
    args,
    currentMessageTranslationFiles(req, availableFiles).map((file) => file.file_id),
  );
  if (sourceLocaleRequired(files, preserveTerms) && !sourceLocale) {
    throw new IdmlError(
      'source_locale is required for structured text or glossary-backed translation',
      'source_locale_required',
      400,
    );
  }
  if (sourceLocale && sourceLocale.toLowerCase() === targetLocale.toLowerCase()) {
    throw new IdmlError('Source and target locales must differ', 'same_locale', 400);
  }
  const retentionExpiry = await getRetentionExpiry(req);
  const { job, created } = await enqueueTranslationJob({
    user: req.user.id,
    tenantId: req.user.tenantId,
    conversationId: req.body.conversationId,
    files: files.map((file) => ({
      file_id: file.file_id,
      filename: file.filename,
      type: file.type,
      bytes: file.bytes,
    })),
    sourceLocale,
    targetLocale,
    preserveTerms,
    outputExpiresAt: retentionExpiry.expiredAt ?? null,
    outputRetentionResolved: true,
  });
  recordFileTranslationOutcome(created ? 'accepted' : 'idempotent');
  return waitForTranslationJob({ req, job, signal });
}

async function translationJobAction({ req, args }) {
  if (typeof args?.job_id !== 'string' || !args.job_id) {
    throw new IdmlError('job_id is required', 'translation_job_id_required', 400);
  }
  const scope = {
    user: req.user.id,
    tenantId: req.user.tenantId,
    jobId: args.job_id,
  };
  let job = await getOwnedTranslationJob(scope);
  if (!job) throw new IdmlError('Translation job was not found', 'translation_job_not_found', 404);
  if (job.conversation_id && job.conversation_id !== req.body?.conversationId) {
    throw new IdmlError('Translation job was not found', 'translation_job_not_found', 404);
  }
  if (args.action === 'cancel') {
    const cancelled = await requestTranslationCancellation(scope);
    if (cancelled?.status === 'cancelled' && job.status !== 'cancelled') {
      recordFileTranslationOutcome('cancelled');
    }
    job = cancelled ?? job;
  } else if (args.action !== 'status') {
    throw new IdmlError('action must be status or cancel', 'invalid_action', 400);
  }
  return jobToolResult(req, job);
}

function buildFileToolContext(req) {
  if (!isFileTranslationConfigured()) {
    return '';
  }
  const files = requestToolFiles(req).filter(isTranslatableFile);
  if (!files.length) {
    return '';
  }
  const names = files.map((file) => file.filename ?? file.name ?? 'attached file');
  const currentFiles = currentMessageTranslationFiles(req, files);
  const selectionInstruction =
    currentFiles.length === 1
      ? `The current-message file ${currentFiles[0].filename ?? currentFiles[0].name ?? 'attached file'} is the default; omit filenames for a request to translate this file.`
      : currentFiles.length > 1
        ? `Do not call translate_file for an ambiguous request. Ask the user to choose the exact current-message filename from: ${currentFiles
            .map((file) => file.filename ?? file.name ?? 'attached file')
            .join(', ')}.`
        : Array.isArray(req?.knaufCurrentMessageFileIds) &&
            req.knaufCurrentMessageFileIds.length > 0
          ? `No supported file is attached to the current message. Ask the user to attach a supported file or choose an exact historical filename from: ${names.join(', ')}.`
          : `Do not call translate_file without an explicit filename. Ask the user to choose from the available historical files: ${names.join(', ')}.`;
  return [
    `File translation is available for: ${names.join(', ')}.`,
    `${selectionInstruction} Explicitly named files may include historical files. Use all_files=true only when the user explicitly requests every available file. Also provide source_locale for IDML, JSON, Markdown, XML, SVG, and every glossary-backed request. Pass product, brand, or technical names the user says not to translate in preserve_terms with their exact source-document spelling and casing.`,
    'The call may finish inline or return a durable job_id. Use translation_status later to check or cancel that job.',
    'Azure Translator returns each completed downloadable file in its original format.',
    'Tell the user that final layout, overflow, and OCR acceptance remains a human review.',
  ].join('\n');
}

function createFileTranslateTool({ req, signal }) {
  if (!isFileTranslationConfigured()) {
    throw new IdmlError('File translation is not enabled', 'file_translation_disabled', 503);
  }
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
        const result = await enqueueTranslationFiles({ req, args, signal });
        logger.info('[translate_file] accepted', {
          userId: req?.user?.id,
          conversationId: req?.body?.conversationId,
          targetLocale: result.report.targetLocale,
          status: result.report.status,
          outputs: result.files.length,
        });
        return [
          JSON.stringify(result.report),
          { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: result.files } },
        ];
      } catch (error) {
        const payload = publicError(error);
        if (payload.code === 'translation_user_limit') {
          recordFileTranslationOutcome('user_limited');
        } else if (payload.code === 'translation_capacity_full') {
          recordFileTranslationOutcome('capacity_limited');
        }
        logger.warn('[translate_file] failed', {
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

function createTranslationStatusTool({ req }) {
  if (!isFileTranslationConfigured()) {
    throw new IdmlError('File translation is not enabled', 'file_translation_disabled', 503);
  }
  const definition = getToolDefinition(STATUS_TOOL_NAME);
  if (!definition) throw new Error(`${STATUS_TOOL_NAME} definition is missing`);
  return new DynamicStructuredTool({
    name: STATUS_TOOL_NAME,
    description: definition.description,
    schema: definition.schema,
    responseFormat: 'content_and_artifact',
    func: async (args) => {
      try {
        const result = await translationJobAction({ req, args });
        return [
          JSON.stringify(result.report),
          { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: result.files } },
        ];
      } catch (error) {
        const payload = publicError(error);
        return [
          JSON.stringify({ status: 'failed', ...payload }),
          { [FILE_TRANSLATION_ARTIFACT_KEY]: { files: [] } },
        ];
      }
    },
  });
}

module.exports = {
  buildTranslationStorageLocator,
  FILE_TRANSLATION_ARTIFACT_KEY,
  STATUS_TOOL_NAME,
  TOOL_NAME,
  buildFileToolContext,
  createFileTranslateTool,
  createTranslationStatusTool,
  enqueueTranslationFiles,
  formatForFile,
  isFileTranslationConfigured,
  isTranslatableFile,
  jsonAdapter,
  markdownAdapter,
  normalizePreserveTerms,
  persistOutput,
  readFileBuffer,
  requestToolFiles,
  resolveInputFileResults,
  resolveInputFiles,
  selectTranslationFiles,
  sourceLocaleRequired,
  translationJobAction,
  svgAdapter,
  translateFiles,
  xmlAdapter,
};

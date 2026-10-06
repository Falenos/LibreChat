'use strict';

const crypto = require('crypto');
const { findAllArtifacts, getToolDefinition } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  validateReactArtifactSource,
  validateSvgArtifactSource,
} = require('@knauf/knauf/server/validateArtifactSource');

const TOOL_NAME = 'edit_artifact';
const MAX_REPLACEMENTS = 25;
const MAX_REPLACEMENT_BYTES = 512 * 1024;
const MAX_CONTEXT_ARTIFACTS = 10;
const MAX_ARTIFACT_REVISIONS = 10_000;

class ArtifactEditError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ArtifactEditError';
    this.code = code;
    this.status = status;
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const readIdentifier = (boundary) => {
  const openingLine = boundary.text.slice(
    boundary.start,
    boundary.text.indexOf('\n', boundary.start),
  );
  return openingLine.match(/\bidentifier\s*=\s*(["'])(.*?)\1/)?.[2] ?? '';
};

const readAttribute = (boundary, name) => {
  const openingLine = boundary.text.slice(
    boundary.start,
    boundary.text.indexOf('\n', boundary.start),
  );
  return openingLine.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? '';
};

const readVersion = (boundary) => {
  const version = Number.parseInt(readAttribute(boundary, 'version'), 10);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
};

const readArtifactContent = (boundary) => {
  const raw = boundary.text.slice(boundary.start, boundary.end);
  const openingLineEnd = raw.indexOf('\n');
  if (openingLineEnd === -1) {
    throw new ArtifactEditError('Artifact has no editable content', 'invalid_artifact');
  }

  const closingLineStart = raw.lastIndexOf('\n');
  const contentEnd =
    raw.slice(closingLineStart + 1).trim() === ':::' ? closingLineStart : raw.length;
  const content = raw.slice(openingLineEnd + 1, contentEnd).replace(/\n$/, '');
  const fenced = content.match(/^[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/);
  return fenced?.[2] ?? content;
};

const findLatestArtifact = (messages, identifier) => {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const artifacts = findAllArtifacts(message);
    for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
      if (readIdentifier(artifacts[artifactIndex]) === identifier) {
        return { message, artifactIndex, boundary: artifacts[artifactIndex] };
      }
    }
  }
  return null;
};

const countOccurrences = (source, value) => {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
};

const validateInput = ({ userId, conversationId, identifier, expectedSha256, replacements }) => {
  if (!userId || !conversationId) {
    throw new ArtifactEditError(
      'Authenticated conversation context is required',
      'missing_context',
    );
  }
  if (
    typeof identifier !== 'string' ||
    identifier.length === 0 ||
    identifier.length > 160 ||
    /[\r\n\0]/.test(identifier)
  ) {
    throw new ArtifactEditError('A valid artifact identifier is required', 'invalid_identifier');
  }
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new ArtifactEditError('The artifact revision token is required', 'missing_revision');
  }
  if (
    !Array.isArray(replacements) ||
    replacements.length === 0 ||
    replacements.length > MAX_REPLACEMENTS
  ) {
    throw new ArtifactEditError('Provide between 1 and 25 replacements', 'invalid_replacements');
  }

  for (const replacement of replacements) {
    if (
      !replacement ||
      typeof replacement.old !== 'string' ||
      typeof replacement.new !== 'string' ||
      replacement.old.length === 0 ||
      replacement.old === replacement.new ||
      replacement.old.endsWith('\n') ||
      Buffer.byteLength(replacement.old, 'utf8') + Buffer.byteLength(replacement.new, 'utf8') >
        MAX_REPLACEMENT_BYTES
    ) {
      throw new ArtifactEditError(
        'Each replacement needs distinct old/new text; old must be non-empty and omit a trailing newline',
        'invalid_replacement',
      );
    }
  }
};

const withUpdatedText = (message, boundary, updatedText) => {
  if (boundary.source === 'content') {
    return {
      ...message,
      content: message.content.map((part, index) =>
        index === boundary.partIndex ? { ...part, text: updatedText } : part,
      ),
    };
  }
  return { ...message, text: updatedText };
};

const withVersion = (message, boundary, version) => {
  const openingLineEnd = boundary.text.indexOf('\n', boundary.start);
  const openingLine = boundary.text.slice(boundary.start, openingLineEnd);
  const updatedOpeningLine = /\bversion\s*=\s*(["']).*?\1/.test(openingLine)
    ? openingLine.replace(/\bversion\s*=\s*(["']).*?\1/, `version="${version}"`)
    : openingLine.replace(/}\s*$/, ` version="${version}"}`);
  if (openingLineEnd === -1 || updatedOpeningLine === openingLine) {
    throw new ArtifactEditError('Artifact metadata cannot be versioned', 'invalid_artifact');
  }
  return withUpdatedText(
    message,
    boundary,
    boundary.text.slice(0, boundary.start) +
      updatedOpeningLine +
      boundary.text.slice(openingLineEnd),
  );
};

const replaceExactInBoundary = (boundary, editableContent, oldValue, newValue) => {
  const raw = boundary.text.slice(boundary.start, boundary.end);
  const openingLineEnd = raw.indexOf('\n');
  const editableStart = raw.indexOf(editableContent, openingLineEnd + 1);
  if (editableStart === -1) {
    return null;
  }
  const relativeMatch = editableContent.indexOf(oldValue);
  const absoluteMatch = boundary.start + editableStart + relativeMatch;
  return (
    boundary.text.slice(0, absoluteMatch) +
    newValue +
    boundary.text.slice(absoluteMatch + oldValue.length)
  );
};

async function applyArtifactEdit(input, deps) {
  validateInput(input);
  const { userId, conversationId, identifier, expectedSha256, replacements } = input;
  const messages = await deps.getMessages({ user: userId, conversationId });
  const target = findLatestArtifact(messages, identifier);
  if (!target) {
    throw new ArtifactEditError(
      'Artifact not found in this conversation',
      'artifact_not_found',
      404,
    );
  }

  const currentContent = readArtifactContent(target.boundary);
  const baseSha256 = sha256(currentContent);
  if (sha256(currentContent) !== expectedSha256) {
    throw new ArtifactEditError(
      'Artifact changed since this request started; read the current revision and retry',
      'stale_revision',
      409,
    );
  }

  if (replacements.some((replacement) => replacement.old === currentContent)) {
    throw new ArtifactEditError(
      'Do not replace the complete artifact source; use localized exact replacements instead',
      'full_source_replacement',
    );
  }

  let workingMessage = target.message;
  const inversePatches = [];
  for (const replacement of replacements) {
    const boundary = findAllArtifacts(workingMessage)[target.artifactIndex];
    const editableContent = readArtifactContent(boundary);
    if (countOccurrences(editableContent, replacement.old) !== 1) {
      throw new ArtifactEditError(
        'Each old value must match exactly once in the current artifact',
        'non_unique_match',
        409,
      );
    }

    inversePatches.push({
      start: editableContent.indexOf(replacement.old),
      old: replacement.old,
      newLength: replacement.new.length,
    });

    const updatedText = replaceExactInBoundary(
      boundary,
      editableContent,
      replacement.old,
      replacement.new,
    );
    if (!updatedText) {
      throw new ArtifactEditError(
        'Exact replacement could not be applied',
        'replacement_failed',
        409,
      );
    }
    workingMessage = withUpdatedText(workingMessage, boundary, updatedText);
  }

  const editedBoundary = findAllArtifacts(workingMessage)[target.artifactIndex];
  if (readAttribute(editedBoundary, 'type') === 'application/vnd.react') {
    const syntaxError = validateReactArtifactSource(readArtifactContent(editedBoundary));
    if (syntaxError) {
      const location = syntaxError.line
        ? ` at line ${syntaxError.line}, column ${syntaxError.column ?? 0}`
        : '';
      throw new ArtifactEditError(
        `Updated React artifact has invalid syntax${location}; use localized replacements and retry`,
        'invalid_artifact_syntax',
      );
    }
  }
  // [knauf] NO-TICKET — keep edited native SVG revisions inside the upload safety contract.
  if (readAttribute(editedBoundary, 'type') === 'image/svg+xml') {
    const syntaxError = validateSvgArtifactSource(readArtifactContent(editedBoundary));
    if (syntaxError) {
      throw new ArtifactEditError(
        `Updated SVG artifact is invalid: ${syntaxError.message}`,
        'invalid_artifact_syntax',
      );
    }
  }
  // End [knauf]

  const currentVersion = readVersion(target.boundary);
  if (currentVersion >= MAX_ARTIFACT_REVISIONS) {
    throw new ArtifactEditError('Artifact revision limit reached', 'revision_limit_reached', 409);
  }
  const version = currentVersion + 1;
  workingMessage = withVersion(
    workingMessage,
    findAllArtifacts(workingMessage)[target.artifactIndex],
    version,
  );
  const finalBoundary = findAllArtifacts(workingMessage)[target.artifactIndex];
  const original = target.boundary.text;
  const updated = finalBoundary.text;
  const swapped = await deps.compareAndSwap({
    userId,
    conversationId,
    messageId: target.message.messageId,
    source: target.boundary.source,
    partIndex: target.boundary.partIndex,
    original,
    updated,
  });
  if (!swapped) {
    throw new ArtifactEditError(
      'Artifact changed while the edit was being applied; retry with the current revision',
      'concurrent_edit',
      409,
    );
  }

  return {
    status: 'updated',
    identifier,
    messageId: target.message.messageId,
    title: readAttribute(target.boundary, 'title') || identifier,
    version,
    replacements: replacements.length,
    baseSha256,
    inversePatches,
    contentSha256: sha256(readArtifactContent(finalBoundary)),
  };
}

const parseStoredRevision = (output) => {
  if (typeof output !== 'string') {
    return null;
  }
  try {
    const value = JSON.parse(output);
    if (
      value?.status !== 'updated' ||
      typeof value.identifier !== 'string' ||
      typeof value.messageId !== 'string' ||
      !Number.isSafeInteger(value.version) ||
      value.version < 2 ||
      typeof value.base_sha256 !== 'string' ||
      typeof value.content_sha256 !== 'string' ||
      !Array.isArray(value.inverse_patches) ||
      value.inverse_patches.some(
        (patch) =>
          !Number.isSafeInteger(patch?.start) ||
          patch.start < 0 ||
          typeof patch.old !== 'string' ||
          !Number.isSafeInteger(patch.new_length) ||
          patch.new_length < 0,
      )
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const readStoredRevisions = (messages, messageId, identifier) => {
  const revisions = new Map();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      const toolCall = part?.type === 'tool_call' ? part.tool_call : null;
      if (toolCall?.name !== TOOL_NAME) {
        continue;
      }
      const revision = parseStoredRevision(toolCall.output);
      if (revision?.messageId === messageId && revision.identifier === identifier) {
        revisions.set(revision.version, revision);
      }
    }
  }
  return revisions;
};

const readRevisionTitle = (revisions, version, fallback) => {
  const storedTitle =
    revisions.get(version)?.title ?? (version === 1 ? revisions.get(2)?.title : undefined);
  return typeof storedTitle === 'string' && storedTitle.length > 0 ? storedTitle : fallback;
};

function getArtifactRevisionSnapshot(messages, { messageId, identifier, version }) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ArtifactEditError('A valid artifact version is required', 'invalid_version');
  }
  const sourceMessage = messages.find((message) => message.messageId === messageId);
  const target = sourceMessage ? findLatestArtifact([sourceMessage], identifier) : null;
  if (!target) {
    throw new ArtifactEditError('Artifact not found', 'artifact_not_found', 404);
  }

  const currentVersion = readVersion(target.boundary);
  if (currentVersion > MAX_ARTIFACT_REVISIONS) {
    throw new ArtifactEditError(
      'Artifact version history is too large',
      'revision_history_too_large',
      413,
    );
  }
  if (version > currentVersion) {
    throw new ArtifactEditError('Artifact version not found', 'revision_not_found', 404);
  }

  let content = readArtifactContent(target.boundary);
  const revisions = readStoredRevisions(messages, messageId, identifier);
  for (let candidateVersion = currentVersion; candidateVersion > version; candidateVersion -= 1) {
    const revision = revisions.get(candidateVersion);
    if (!revision || sha256(content) !== revision.content_sha256) {
      throw new ArtifactEditError(
        'This artifact version predates immutable revision history',
        'revision_unavailable',
        409,
      );
    }
    for (let patchIndex = revision.inverse_patches.length - 1; patchIndex >= 0; patchIndex -= 1) {
      const patch = revision.inverse_patches[patchIndex];
      if (patch.start + patch.new_length > content.length) {
        throw new ArtifactEditError('Artifact revision is invalid', 'invalid_revision', 409);
      }
      content =
        content.slice(0, patch.start) + patch.old + content.slice(patch.start + patch.new_length);
    }
    if (sha256(content) !== revision.base_sha256) {
      throw new ArtifactEditError('Artifact revision is invalid', 'invalid_revision', 409);
    }
  }

  return {
    title: readRevisionTitle(
      revisions,
      version,
      readAttribute(target.boundary, 'title') || identifier,
    ),
    type: readAttribute(target.boundary, 'type'),
    content,
    version,
    ...(readAttribute(target.boundary, 'language')
      ? { language: readAttribute(target.boundary, 'language') }
      : {}),
  };
}

function getArtifactRevisionHistory(messages, { messageId, identifier }) {
  const sourceMessage = messages.find((message) => message.messageId === messageId);
  const target = sourceMessage ? findLatestArtifact([sourceMessage], identifier) : null;
  if (!target) {
    throw new ArtifactEditError('Artifact not found', 'artifact_not_found', 404);
  }

  const latestTitle = readAttribute(target.boundary, 'title') || identifier;
  const type = readAttribute(target.boundary, 'type');
  const language = readAttribute(target.boundary, 'language');
  const currentVersion = readVersion(target.boundary);
  if (currentVersion > MAX_ARTIFACT_REVISIONS) {
    throw new ArtifactEditError(
      'Artifact version history is too large',
      'revision_history_too_large',
      413,
    );
  }
  const revisions = readStoredRevisions(messages, messageId, identifier);
  const snapshots = [];
  let content = readArtifactContent(target.boundary);
  let historyAvailable = true;

  for (let version = currentVersion; version >= 1; version -= 1) {
    snapshots.unshift(
      historyAvailable
        ? {
            title: readRevisionTitle(revisions, version, latestTitle),
            type,
            version,
            available: true,
            ...(language ? { language } : {}),
          }
        : { version, available: false },
    );
    if (version === 1 || !historyAvailable) {
      continue;
    }

    const revision = revisions.get(version);
    if (!revision || sha256(content) !== revision.content_sha256) {
      historyAvailable = false;
      continue;
    }
    for (let patchIndex = revision.inverse_patches.length - 1; patchIndex >= 0; patchIndex -= 1) {
      const patch = revision.inverse_patches[patchIndex];
      if (patch.start + patch.new_length > content.length) {
        historyAvailable = false;
        break;
      }
      content =
        content.slice(0, patch.start) + patch.old + content.slice(patch.start + patch.new_length);
    }
    if (historyAvailable && sha256(content) !== revision.base_sha256) {
      historyAvailable = false;
    }
  }

  return { currentVersion, revisions: snapshots };
}

const defaultGetMessages = (...args) => require('~/models').getMessages(...args);

const compareAndSwapMessage = async (
  { userId, conversationId, messageId, source, partIndex, original, updated },
  Message,
) => {
  const path = source === 'content' ? `content.${partIndex}.text` : 'text';
  // Use the native collection so search indexing cannot hold the chat stream open; flag it to retry.
  const result = await Message.collection.updateOne(
    { user: userId, conversationId, messageId, [path]: original },
    { $set: { [path]: updated, updatedAt: new Date(), _meiliIndex: false } },
  );
  return result.modifiedCount === 1;
};

const defaultCompareAndSwap = (args) =>
  compareAndSwapMessage(args, require('mongoose').models.Message);

async function buildArtifactEditContext(
  { userId, conversationId },
  { getMessages = defaultGetMessages } = {},
) {
  if (!userId || !conversationId) {
    return '';
  }
  const messages = await getMessages({ user: userId, conversationId });
  const revisions = [];
  const seen = new Set();

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const artifacts = findAllArtifacts(messages[messageIndex]);
    for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
      const boundary = artifacts[artifactIndex];
      const identifier = readIdentifier(boundary);
      if (!identifier || seen.has(identifier)) {
        continue;
      }
      seen.add(identifier);
      revisions.push({ identifier, hash: sha256(readArtifactContent(boundary)) });
      if (revisions.length === MAX_CONTEXT_ARTIFACTS) {
        break;
      }
    }
    if (revisions.length === MAX_CONTEXT_ARTIFACTS) {
      break;
    }
  }

  if (revisions.length === 0) {
    return '';
  }
  return [
    'Current editable artifact revisions (pass the token unchanged to edit_artifact):',
    ...revisions.map(
      ({ identifier, hash }) => `- identifier="${identifier}" expected_sha256="${hash}"`,
    ),
  ].join('\n');
}

function createEditArtifactTool({
  req,
  getMessages = defaultGetMessages,
  compareAndSwap = defaultCompareAndSwap,
}) {
  const { DynamicStructuredTool } = require('@langchain/core/tools');
  const definition = getToolDefinition(TOOL_NAME);

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: definition.description,
    schema: definition.schema,
    returnDirect: true,
    func: async (args) => {
      try {
        const result = await applyArtifactEdit(
          {
            userId: req?.user?.id,
            conversationId: req?.body?.conversationId,
            identifier: args?.identifier,
            expectedSha256: args?.expected_sha256,
            replacements: args?.replacements,
          },
          { getMessages, compareAndSwap },
        );
        logger.info(
          `[edit_artifact] updated identifier=${result.identifier} replacements=${result.replacements}`,
        );
        const { contentSha256, baseSha256, inversePatches, ...payload } = result;
        return JSON.stringify({
          ...payload,
          base_sha256: baseSha256,
          content_sha256: contentSha256,
          inverse_patches: inversePatches.map(({ start, old, newLength }) => ({
            start,
            old,
            new_length: newLength,
          })),
        });
      } catch (error) {
        const payload =
          error instanceof ArtifactEditError
            ? { status: 'error', code: error.code, error: error.message }
            : { status: 'error', code: 'internal_error', error: 'Artifact edit failed' };
        logger.warn(`[edit_artifact] failed code=${payload.code}`);
        return JSON.stringify(payload);
      }
    },
  });
}

module.exports = {
  TOOL_NAME,
  ArtifactEditError,
  applyArtifactEdit,
  buildArtifactEditContext,
  compareAndSwapMessage,
  createEditArtifactTool,
  getArtifactRevisionHistory,
  getArtifactRevisionSnapshot,
  sha256,
};

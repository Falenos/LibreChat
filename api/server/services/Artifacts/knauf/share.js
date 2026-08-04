const { nanoid } = require('nanoid');
const { findAllArtifacts } = require('@librechat/api');
const { getArtifactRevisionSnapshot } = require('./edit');

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 240;
const SINGLE_FILE_ARTIFACT_TYPES = new Set([
  'application/vnd.react',
  'application/vnd.ant.react',
  'text/html',
  'application/vnd.code-html',
  'application/vnd.mermaid',
]);
const FENCED_SOURCE_PATTERN =
  /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/;

const ALLOWED_ARTIFACT_TYPES = new Set([
  'text/html',
  'text/markdown',
  'text/md',
  'text/plain',
  'application/vnd.react',
  'application/vnd.ant.react',
  'application/vnd.mermaid',
  'application/vnd.code-html',
  'application/vnd.code',
  'application/vnd.librechat.docx-preview',
  'application/vnd.librechat.spreadsheet-preview',
  'application/vnd.librechat.presentation-preview',
]);

class ArtifactShareError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ArtifactShareError';
    this.status = status;
  }
}

const readDirectiveAttributes = (openingLine) => {
  const attributes = {};
  const attributePattern = /([A-Za-z][\w-]*)\s*=\s*(["'])(.*?)\2/g;
  let match = attributePattern.exec(openingLine);
  while (match) {
    attributes[match[1]] = match[3];
    match = attributePattern.exec(openingLine);
  }
  return attributes;
};

const extractDirectiveContent = (content, type) => {
  if (!SINGLE_FILE_ARTIFACT_TYPES.has(type)) {
    return content;
  }
  return content.match(FENCED_SOURCE_PATTERN)?.[2] ?? content;
};

const extractDirectiveSnapshot = (message, index) => {
  if (!Number.isInteger(index) || index < 0) {
    throw new ArtifactShareError('Artifact index must be a non-negative integer');
  }

  const artifact = findAllArtifacts(message)[index];
  if (!artifact) {
    throw new ArtifactShareError('Artifact not found', 404);
  }

  const raw = artifact.text.slice(artifact.start, artifact.end);
  const openingLineEnd = raw.indexOf('\n');
  if (openingLineEnd === -1) {
    throw new ArtifactShareError('Artifact has no content');
  }

  const attributes = readDirectiveAttributes(raw.slice(0, openingLineEnd));
  const closingLineStart = raw.lastIndexOf('\n');
  const hasClosingMarker =
    closingLineStart >= openingLineEnd && raw.slice(closingLineStart + 1).trim() === ':::';
  const contentEnd = hasClosingMarker ? closingLineStart : raw.length;
  const content = extractDirectiveContent(
    raw.slice(openingLineEnd + 1, contentEnd).replace(/\n$/, ''),
    attributes.type,
  );

  return {
    title: attributes.title || 'Generated artifact',
    type: attributes.type,
    content,
  };
};

const extractFileSnapshot = (message, locator) => {
  if (typeof locator.fileId !== 'string' || locator.fileId.length === 0) {
    throw new ArtifactShareError('Artifact file ID is required');
  }

  const files = [...(message.attachments ?? []), ...(message.files ?? [])];
  const file = files.find((candidate) => candidate?.file_id === locator.fileId);
  if (!file) {
    throw new ArtifactShareError('Artifact file not found in message', 404);
  }
  if (typeof file.text !== 'string') {
    throw new ArtifactShareError('Artifact preview is not ready', 409);
  }

  return {
    title: file.filename || 'Generated artifact',
    type: locator.type,
    content: file.text,
    language: locator.language,
  };
};

const validateSnapshot = (snapshot) => {
  if (!ALLOWED_ARTIFACT_TYPES.has(snapshot.type)) {
    throw new ArtifactShareError('Unsupported artifact type');
  }
  if (typeof snapshot.content !== 'string') {
    throw new ArtifactShareError('Artifact content is required');
  }
  if (Buffer.byteLength(snapshot.content, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new ArtifactShareError('Artifact is too large to share', 413);
  }

  return {
    title: String(snapshot.title || 'Generated artifact').slice(0, MAX_TITLE_LENGTH),
    type: snapshot.type,
    content: snapshot.content,
    ...(typeof snapshot.language === 'string' && snapshot.language
      ? { language: snapshot.language.slice(0, 80) }
      : {}),
  };
};

const createArtifactShare = async ({
  mongoose,
  user,
  conversationId,
  messageId,
  locator,
  expiredAt,
}) => {
  if (!user || !conversationId || !messageId || !locator || typeof locator !== 'object') {
    throw new ArtifactShareError('Missing required artifact share fields');
  }

  const Message = mongoose.models.Message;
  const SharedLink = mongoose.models.SharedLink;
  const message = await Message.findOne({ user, conversationId, messageId }).lean();
  if (!message) {
    throw new ArtifactShareError('Message not found or access denied', 404);
  }
  if (locator.kind !== 'file' && locator.kind !== 'directive' && locator.kind !== 'revision') {
    throw new ArtifactShareError('Unsupported artifact locator');
  }

  let sourceSnapshot;
  if (locator.kind === 'revision') {
    const messages = await Message.find({ user, conversationId }).lean();
    sourceSnapshot = getArtifactRevisionSnapshot(messages, {
      messageId,
      identifier: locator.identifier,
      version: locator.version,
    });
  } else {
    sourceSnapshot =
      locator.kind === 'file'
        ? extractFileSnapshot(message, locator)
        : extractDirectiveSnapshot(message, locator.index);
  }
  const snapshot = validateSnapshot(sourceSnapshot);
  const shareId = nanoid();
  const created = await SharedLink.create({
    shareId,
    conversationId,
    messages: [],
    title: snapshot.title,
    user,
    snapshotFiles: false,
    knauf_artifact: snapshot,
    ...(expiredAt ? { expiredAt } : {}),
  });

  return {
    _id: created._id.toString(),
    shareId,
    conversationId,
  };
};

module.exports = {
  ALLOWED_ARTIFACT_TYPES,
  ArtifactShareError,
  MAX_ARTIFACT_BYTES,
  createArtifactShare,
  extractDirectiveSnapshot,
  extractDirectiveContent,
};

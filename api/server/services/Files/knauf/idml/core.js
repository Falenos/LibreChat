'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const yauzl = require('yauzl');
const { TextDecoder } = require('util');
const { DOMParser } = require('@xmldom/xmldom');
const { assertSafeZipSize } = require('@librechat/api');
const { SaxesParser } = require('@knauf/knauf/server/saxes');

const IDML_MIME = 'application/vnd.adobe.indesign-idml-package';
const MAX_IDML_BYTES = 25 * 1024 * 1024;
const MAX_IDML_ENTRIES = 5000;
const MAX_STORIES = 2000;
const MAX_SEGMENTS = 10000;
const MAX_SOURCE_CHARACTERS = 500000;
const MAX_CONTENT_NODES = 50000;
const MAX_STORY_XML_CHARACTERS = 20 * 1024 * 1024;
const MAX_XML_ATTRIBUTES = 50000;
const MAX_XML_ATTRIBUTE_CHARACTERS = 2 * 1024 * 1024;

class IdmlError extends Error {
  constructor(message, code, status = 422) {
    super(message);
    this.name = 'IdmlError';
    this.code = code;
    this.status = status;
  }
}

function decodeXmlBuffer(buffer, label = 'XML') {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new IdmlError(`${label} must be UTF-8 encoded`, 'unsupported_xml_encoding', 400);
  }
  const declaration = source.match(/^\s*<\?xml[\s\S]*?\?>/i)?.[0] ?? '';
  const encoding = declaration.match(/\bencoding\s*=\s*(["'])([^"']+)\1/i)?.[2];
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new IdmlError(`${label} must be UTF-8 encoded`, 'unsupported_xml_encoding', 400);
  }
  return source;
}

function assertValidXmlCharacters(value, label = 'XML edit') {
  // XML 1.0 explicitly permits tab, line feed, and carriage return.
  // eslint-disable-next-line no-control-regex
  if (!/^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u.test(value)) {
    throw new IdmlError(`${label} contains characters forbidden by XML 1.0`, 'invalid_edit', 400);
  }
}

function validateXmlStructure(
  source,
  label,
  {
    maxNodes = 100000,
    maxDepth = 256,
    maxAttributes = MAX_XML_ATTRIBUTES,
    maxAttributeCharacters = MAX_XML_ATTRIBUTE_CHARACTERS,
  } = {},
) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new IdmlError(`${label} contains a forbidden DTD or entity`, 'unsafe_xml', 400);
  }
  let nodes = 0;
  let depth = 0;
  let attributes = 0;
  let attributeCharacters = 0;
  const countNode = () => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new IdmlError(`${label} contains too many nodes`, 'too_many_nodes', 400);
    }
  };
  try {
    const parser = new SaxesParser();
    parser.on('error', (error) => {
      throw error;
    });
    parser.on('opentag', (tag) => {
      countNode();
      depth += 1;
      if (depth > maxDepth) {
        throw new IdmlError(`${label} is nested too deeply`, 'too_deep', 400);
      }
      for (const [name, value] of Object.entries(tag.attributes)) {
        attributes += 1;
        attributeCharacters += name.length + String(value).length;
      }
      if (attributes > maxAttributes || attributeCharacters > maxAttributeCharacters) {
        throw new IdmlError(
          `${label} contains too much attribute data`,
          'too_many_attributes',
          400,
        );
      }
    });
    parser.on('closetag', () => {
      depth -= 1;
    });
    for (const event of ['text', 'cdata', 'comment', 'processinginstruction']) {
      parser.on(event, countNode);
    }
    parser.write(source).close();
  } catch (error) {
    if (error instanceof IdmlError) {
      throw error;
    }
    throw new IdmlError(`${label} is malformed XML`, 'invalid_xml', 400);
  }
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function assertIdmlLocalHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30 || buffer.length > MAX_IDML_BYTES) {
    throw new IdmlError(
      'IDML file is empty or exceeds the 25 MB translation limit',
      'invalid_size',
    );
  }
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new IdmlError('IDML is not a ZIP package', 'invalid_zip');
  }
  const compressionMethod = buffer.readUInt16LE(8);
  const fileNameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const fileNameEnd = 30 + fileNameLength;
  const dataStart = fileNameEnd + extraLength;
  const compressedSize = buffer.readUInt32LE(18);
  if (fileNameEnd > buffer.length || dataStart + compressedSize > buffer.length) {
    throw new IdmlError('IDML first ZIP entry is truncated', 'invalid_zip');
  }
  const firstName = buffer.subarray(30, fileNameEnd).toString('utf8');
  const firstContent = buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8');
  if (firstName !== 'mimetype' || compressionMethod !== 0 || firstContent !== IDML_MIME) {
    throw new IdmlError(
      'IDML must start with an uncompressed mimetype entry',
      'invalid_idml_mimetype',
    );
  }
}

function assertSafeEntryNames(entries) {
  if (entries.length > MAX_IDML_ENTRIES) {
    throw new IdmlError('IDML contains too many package entries', 'too_many_entries');
  }
  const seen = new Set();
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    const normalized = original.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (
      original.includes('\0') ||
      original.includes('\\') ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      parts.includes('..') ||
      original !== entry.name
    ) {
      throw new IdmlError('IDML contains an unsafe package path', 'unsafe_zip_path');
    }
    const folded = normalized.toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      throw new IdmlError('IDML contains duplicate package paths', 'duplicate_zip_path');
    }
    seen.add(folded);
  }
}

function assertUniqueRawEntryNames(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, strictFileNames: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(error ?? new Error('Unable to inspect IDML central directory'));
          return;
        }
        let settled = false;
        let count = 0;
        const seen = new Set();
        const finish = (failure) => {
          if (settled) return;
          settled = true;
          try {
            zipfile.close();
          } catch {
            // Best effort; the validation result is already decided.
          }
          failure ? reject(failure) : resolve();
        };
        zipfile.on('entry', (entry) => {
          count += 1;
          const original = entry.fileName;
          const normalized = original.replaceAll('\\', '/');
          const parts = normalized.split('/');
          if (
            count > MAX_IDML_ENTRIES ||
            original.includes('\0') ||
            original.includes('\\') ||
            normalized.startsWith('/') ||
            /^[A-Za-z]:/.test(normalized) ||
            parts.includes('..')
          ) {
            finish(new IdmlError('IDML contains an unsafe package path', 'unsafe_zip_path'));
            return;
          }
          const folded = normalized.toLocaleLowerCase('en-US');
          if (seen.has(folded)) {
            finish(new IdmlError('IDML contains duplicate package paths', 'duplicate_zip_path'));
            return;
          }
          seen.add(folded);
          zipfile.readEntry();
        });
        zipfile.on('end', () => finish());
        zipfile.on('error', finish);
        zipfile.readEntry();
      },
    );
  });
}

function parseXml(xml, label) {
  validateXmlStructure(xml, label);
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, 'application/xml');
  if (errors.length > 0 || document.getElementsByTagName('parsererror').length > 0) {
    throw new IdmlError(`${label} is malformed XML`, 'invalid_xml');
  }
  return document;
}

function decodeXmlTextPart(raw, label) {
  const root = parseXml(`<root>${raw}</root>`, label).documentElement;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (![3, 4].includes(child.nodeType)) {
      throw new IdmlError(`${label} contains unsupported nested markup`, 'unsupported_content');
    }
  }
  return root.textContent ?? '';
}

function decodeXmlContent(raw, label) {
  parseXml(`<root>${raw}</root>`, label);
  const parts = [];
  let sawMeaningfulText = false;
  let cursor = 0;
  let textStart = 0;

  const retainText = (end) => {
    if (end <= textStart) return;
    const textRaw = raw.slice(textStart, end);
    const text = decodeXmlTextPart(textRaw, label);
    parts.push({ type: 'text', raw: textRaw, text });
    sawMeaningfulText ||= /\S/u.test(text);
  };

  while (cursor < raw.length) {
    if (raw.startsWith('<![CDATA[', cursor)) {
      const end = raw.indexOf(']]>', cursor + 9);
      if (end < 0) {
        throw new IdmlError(`${label} is malformed XML`, 'invalid_xml');
      }
      cursor = end + 3;
      continue;
    }
    if (raw.startsWith('<?', cursor)) {
      const end = raw.indexOf('?>', cursor + 2);
      if (end < 0) {
        throw new IdmlError(`${label} is malformed XML`, 'invalid_xml');
      }
      retainText(cursor);
      const markup = raw.slice(cursor, end + 2);
      const target = markup.slice(2).match(/^([^\s?]+)/u)?.[1];
      if (sawMeaningfulText && target !== 'ACE') {
        throw new IdmlError(`${label} contains unsupported nested markup`, 'unsupported_content');
      }
      parts.push({ type: 'markup', raw: markup });
      cursor = end + 2;
      textStart = cursor;
      continue;
    }
    if (raw[cursor] === '<') {
      throw new IdmlError(`${label} contains unsupported nested markup`, 'unsupported_content');
    }
    cursor += 1;
  }
  retainText(raw.length);
  return parts;
}

function splitOuterWhitespace(value) {
  const match = value.match(/^(\s*)([\s\S]*?)(\s*)$/u);
  return {
    prefix: match?.[1] ?? '',
    text: match?.[2] ?? value,
    suffix: match?.[3] ?? '',
  };
}

function shouldTranslate(value) {
  const text = value.trim();
  if (!text || !/[\p{L}]/u.test(text)) {
    return false;
  }
  if (/^(?:https?:\/\/|www\.|mailto:|[^\s@]+@[^\s@]+\.[^\s@]+)\S*$/iu.test(text)) {
    return false;
  }
  return true;
}

function contentRanges(xml, label) {
  const ranges = [];
  let active;
  try {
    const parser = new SaxesParser();
    parser.on('error', (error) => {
      throw error;
    });
    parser.on('opentag', (tag) => {
      if (tag.name.split(':').at(-1) !== 'Content') return;
      if (active) {
        throw new IdmlError(`${label} contains nested Content elements`, 'unsupported_content');
      }
      const openingEnd = parser.position;
      const openingStart = xml.lastIndexOf('<', openingEnd - 1);
      active = { openingStart, openingEnd };
      if (tag.isSelfClosing) {
        ranges.push({
          start: openingStart,
          end: openingEnd,
          opening: xml.slice(openingStart, openingEnd),
          raw: '',
          closing: '',
        });
        active = undefined;
      }
    });
    parser.on('closetag', (tag) => {
      if (tag.name.split(':').at(-1) !== 'Content' || !active) return;
      const closingEnd = parser.position;
      const closingStart = xml.lastIndexOf('</', closingEnd - 1);
      if (closingStart < active.openingEnd) {
        throw new IdmlError(`${label} has invalid Content offsets`, 'invalid_xml');
      }
      ranges.push({
        start: active.openingStart,
        end: closingEnd,
        opening: xml.slice(active.openingStart, active.openingEnd),
        raw: xml.slice(active.openingEnd, closingStart),
        closing: xml.slice(closingStart, closingEnd),
      });
      active = undefined;
    });
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof IdmlError) throw error;
    throw new IdmlError(`${label} is malformed XML`, 'invalid_xml');
  }
  return ranges;
}

function extractStory(entryName, xml, storyIndex, budget) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new IdmlError(`${entryName} contains a forbidden DTD or entity`, 'unsafe_xml', 400);
  }
  const contents = contentRanges(xml, entryName);
  budget.contentNodes += contents.length;
  if (budget.contentNodes > MAX_CONTENT_NODES) {
    throw new IdmlError('IDML contains too many text nodes', 'too_many_content_nodes');
  }
  parseXml(xml, entryName);
  const segments = [];
  for (let contentIndex = 0; contentIndex < contents.length; contentIndex += 1) {
    const parts = decodeXmlContent(
      contents[contentIndex].raw,
      `${entryName} Content ${contentIndex}`,
    );
    contents[contentIndex].parts = parts;
    const candidates = parts
      .map((part, partIndex) => ({ part, partIndex }))
      .filter(({ part }) => part.type === 'text')
      .map(({ part, partIndex }) => ({
        partIndex,
        whitespace: splitOuterWhitespace(part.text),
      }))
      .filter(({ whitespace }) => shouldTranslate(whitespace.text));
    for (let segmentIndex = 0; segmentIndex < candidates.length; segmentIndex += 1) {
      const { partIndex, whitespace } = candidates[segmentIndex];
      budget.segments += 1;
      budget.characters += whitespace.text.length;
      if (budget.segments > MAX_SEGMENTS || budget.characters > MAX_SOURCE_CHARACTERS) {
        throw new IdmlError('IDML text exceeds the translation limit', 'translation_too_large');
      }
      segments.push({
        id:
          candidates.length === 1
            ? `s${storyIndex}-c${contentIndex}`
            : `s${storyIndex}-c${contentIndex}-p${segmentIndex}`,
        entryName,
        contentIndex,
        partIndex,
        partCount: parts.length,
        source: whitespace.text,
        prefix: whitespace.prefix,
        suffix: whitespace.suffix,
      });
    }
  }
  return { entryName, xml, segments, contents, contentCount: contents.length };
}

async function parseIdml(buffer) {
  assertIdmlLocalHeader(buffer);
  try {
    await assertSafeZipSize(buffer, {
      name: 'IDML',
      maxEntryBytes: 25 * 1024 * 1024,
      maxTotalBytes: 150 * 1024 * 1024,
    });
    await assertUniqueRawEntryNames(buffer);
  } catch (error) {
    if (error instanceof IdmlError) {
      throw error;
    }
    throw new IdmlError(`Unsafe or malformed IDML ZIP: ${error.message}`, 'invalid_zip');
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new IdmlError(`Unable to open IDML package: ${error.message}`, 'invalid_zip');
  }
  const entries = Object.values(zip.files);
  assertSafeEntryNames(entries);
  if (!zip.file('designmap.xml')) {
    throw new IdmlError('IDML designmap.xml is missing', 'missing_designmap');
  }
  const designMap = await zip.file('designmap.xml').async('string');
  parseXml(designMap, 'designmap.xml');

  const storyEntries = entries
    .filter((entry) => !entry.dir && /^Stories\/Story_.+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (storyEntries.length === 0 || storyEntries.length > MAX_STORIES) {
    throw new IdmlError('IDML has no stories or exceeds the story limit', 'invalid_story_count');
  }

  const stories = [];
  const budget = { contentNodes: 0, segments: 0, characters: 0, storyXmlCharacters: 0 };
  for (let index = 0; index < storyEntries.length; index += 1) {
    const entry = storyEntries[index];
    const xml = await entry.async('string');
    budget.storyXmlCharacters += xml.length;
    if (budget.storyXmlCharacters > MAX_STORY_XML_CHARACTERS) {
      throw new IdmlError('IDML story XML exceeds the translation limit', 'translation_too_large');
    }
    stories.push(extractStory(entry.name, xml, index, budget));
  }
  const segments = stories.flatMap((story) => story.segments);
  if (segments.length === 0) {
    throw new IdmlError('IDML contains no translatable text', 'no_translatable_text');
  }

  const immutableHashes = new Map();
  for (const entry of entries) {
    if (entry.dir || entry.name === 'mimetype' || /^Stories\/Story_.+\.xml$/i.test(entry.name)) {
      continue;
    }
    immutableHashes.set(entry.name, sha256(await entry.async('nodebuffer')));
  }

  return {
    zip,
    entries,
    stories,
    segments,
    sourceSha256: sha256(buffer),
    immutableHashes,
  };
}

function escapeXmlText(value) {
  assertValidXmlCharacters(value, 'IDML replacement');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function replaceStoryContent(story, translations, { allowEmpty = false } = {}) {
  const byIndex = new Map();
  for (const segment of story.segments) {
    if (!byIndex.has(segment.contentIndex)) {
      byIndex.set(segment.contentIndex, new Map());
    }
    byIndex.get(segment.contentIndex).set(segment.partIndex, segment);
  }
  const output = [];
  let cursor = 0;
  for (let contentIndex = 0; contentIndex < story.contents.length; contentIndex += 1) {
    const content = story.contents[contentIndex];
    output.push(story.xml.slice(cursor, content.start));
    const segments = byIndex.get(contentIndex);
    if (!segments) {
      output.push(story.xml.slice(content.start, content.end));
      cursor = content.end;
      continue;
    }
    const rebuilt = content.parts.map((part, partIndex) => {
      const segment = segments.get(partIndex);
      if (!segment) return part.raw;
      const translated = translations.get(segment.id);
      if (typeof translated !== 'string' || (!allowEmpty && translated.trim() === '')) {
        throw new IdmlError(`Translation is missing for ${segment.id}`, 'missing_translation');
      }
      return escapeXmlText(segment.prefix + translated.trim() + segment.suffix);
    });
    output.push(`${content.opening}${rebuilt.join('')}${content.closing}`);
    cursor = content.end;
  }
  output.push(story.xml.slice(cursor));
  const xml = output.join('');
  parseXml(xml, story.entryName);
  return xml;
}

async function buildIdml(parsed, translations, options) {
  const expectedIds = new Set(parsed.segments.map((segment) => segment.id));
  if (translations.size !== expectedIds.size) {
    throw new IdmlError('Translation result has a different segment count', 'segment_mismatch');
  }
  for (const id of translations.keys()) {
    if (!expectedIds.has(id)) {
      throw new IdmlError(`Translation returned an unknown segment ${id}`, 'segment_mismatch');
    }
  }

  const storyXml = new Map(
    parsed.stories.map((story) => [
      story.entryName,
      replaceStoryContent(story, translations, options),
    ]),
  );
  const output = new JSZip();
  output.file('mimetype', IDML_MIME, { compression: 'STORE', createFolders: false });

  for (const entry of parsed.entries) {
    if (entry.name === 'mimetype') {
      continue;
    }
    if (entry.dir) {
      output.folder(entry.name.replace(/\/$/, ''));
      continue;
    }
    const content = storyXml.has(entry.name)
      ? Buffer.from(storyXml.get(entry.name), 'utf8')
      : await entry.async('nodebuffer');
    output.file(entry.name, content, {
      compression: entry._data?.compression?.magic === '\x00\x00' ? 'STORE' : 'DEFLATE',
      createFolders: false,
      date: entry.date,
      unixPermissions: entry.unixPermissions,
      dosPermissions: entry.dosPermissions,
    });
  }

  const buffer = await output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: IDML_MIME,
    platform: 'UNIX',
  });
  assertIdmlLocalHeader(buffer);
  const verified = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  for (const [entryName, sourceHash] of parsed.immutableHashes) {
    const entry = verified.file(entryName);
    if (!entry || sha256(await entry.async('nodebuffer')) !== sourceHash) {
      throw new IdmlError(`IDML changed non-story entry ${entryName}`, 'fidelity_check_failed');
    }
  }
  for (const story of parsed.stories) {
    const entry = verified.file(story.entryName);
    if (!entry) {
      throw new IdmlError(`IDML lost story ${story.entryName}`, 'fidelity_check_failed');
    }
    parseXml(await entry.async('string'), story.entryName);
  }
  return { buffer, sha256: sha256(buffer) };
}

function normalizeLocale(value, field = 'locale') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new IdmlError(`${field} must be a BCP-47 locale`, 'invalid_locale', 400);
  }
  try {
    return new Intl.Locale(value.replaceAll('_', '-')).toString();
  } catch {
    throw new IdmlError(`${field} must be a BCP-47 locale`, 'invalid_locale', 400);
  }
}

module.exports = {
  IDML_MIME,
  IdmlError,
  assertValidXmlCharacters,
  buildIdml,
  decodeXmlBuffer,
  normalizeLocale,
  parseIdml,
  validateXmlStructure,
};

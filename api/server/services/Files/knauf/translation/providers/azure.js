'use strict';

const fs = require('fs').promises;
const { createHash, randomUUID } = require('crypto');
const path = require('path');
const { TextDecoder } = require('util');
const XLSX = require('xlsx');
const { DOMParser } = require('@xmldom/xmldom');
const { logger } = require('@librechat/data-schemas');
const {
  BlobServiceClient,
  BlobSASPermissions,
  ContainerSASPermissions,
  SASProtocol,
} = require('@azure/storage-blob');
const { IdmlError } = require('../../idml/core');

const AZURE_TRANSLATOR_API_VERSION = '2026-03-01';
const AZURE_SYNC_GLOSSARY_MAX_BYTES = 900 * 1024;
const AZURE_BATCH_GLOSSARY_MAX_BYTES = 9 * 1024 * 1024;
const AZURE_XLIFF_BATCH_BYTES = 7 * 1024 * 1024;
const AZURE_SYNC_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;
const AZURE_BATCH_TIMEOUT_MS = 10 * 60 * 1000;
const AZURE_CANCEL_TIMEOUT_MS = 30 * 1000;
const GLOSSARY_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const LANGUAGE_2_TO_3 = {
  ar: 'ara',
  az: 'aze',
  bg: 'bul',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  et: 'est',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hr: 'hrv',
  hu: 'hun',
  hy: 'hye',
  id: 'ind',
  it: 'ita',
  ja: 'jpn',
  ka: 'kat',
  kk: 'kaz',
  ko: 'kor',
  ky: 'kir',
  lt: 'lit',
  lv: 'lav',
  mk: 'mkd',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sk: 'slk',
  sl: 'slv',
  sq: 'sqi',
  sr: 'srp',
  sv: 'swe',
  sw: 'swa',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  uz: 'uzb',
  vi: 'vie',
  zh: 'zho',
};
const REGION_2_TO_3 = {
  AL: 'ALB',
  AM: 'ARM',
  AR: 'ARG',
  AT: 'AUT',
  AZ: 'AZE',
  BE: 'BEL',
  BG: 'BGR',
  BR: 'BRA',
  CH: 'CHE',
  CL: 'CHL',
  CN: 'CHN',
  CO: 'COL',
  CZ: 'CZE',
  DE: 'DEU',
  DK: 'DNK',
  EE: 'EST',
  ES: 'ESP',
  FI: 'FIN',
  FR: 'FRA',
  GB: 'GBR',
  GE: 'GEO',
  GR: 'GRC',
  HN: 'HND',
  HR: 'HRV',
  HU: 'HUN',
  ID: 'IDN',
  IL: 'ISR',
  IT: 'ITA',
  JP: 'JPN',
  KG: 'KGZ',
  KR: 'KOR',
  KZ: 'KAZ',
  LT: 'LTU',
  LV: 'LVA',
  ME: 'MNE',
  MK: 'MKD',
  NL: 'NLD',
  NO: 'NOR',
  PL: 'POL',
  PT: 'PRT',
  RO: 'ROU',
  RS: 'SRB',
  RU: 'RUS',
  SA: 'SAU',
  SE: 'SWE',
  SI: 'SVN',
  SK: 'SVK',
  TH: 'THA',
  TR: 'TUR',
  TZ: 'TZA',
  UA: 'UKR',
  UZ: 'UZB',
  VN: 'VNM',
};

let glossaryTableCache;
let azureLanguageCache;

function configuredGlossaryRevision() {
  const revision = process.env.KNAUF_TRANSLATION_GLOSSARY_REVISION;
  if (!revision || revision === 'none') return null;
  if (!/^[a-f\d]{64}$/i.test(revision)) {
    throw new IdmlError(
      'Configured glossary revision must be a SHA-256 digest',
      'invalid_glossary_revision',
      503,
    );
  }
  return revision.toLowerCase();
}

function decodeGlossaryBuffer(buffer) {
  const expected = configuredGlossaryRevision();
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (expected && actual !== expected) {
    throw new IdmlError(
      'Configured glossary content does not match its pinned revision',
      'glossary_revision_mismatch',
      503,
    );
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseXml(value, label) {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) {
    throw new IdmlError(`${label} contains a forbidden DTD or entity`, 'unsafe_xml');
  }
  const errors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(value, 'application/xml');
  if (errors.length > 0 || document.getElementsByTagName('parsererror').length > 0) {
    throw new IdmlError(`${label} is malformed XML`, 'invalid_xml');
  }
  return document;
}

function buildXliff(segments, sourceLocale, targetLocale) {
  const units = segments
    .map(
      (segment) =>
        `<trans-unit id="${xmlEscape(segment.id)}"><source xml:space="preserve">${xmlEscape(segment.source)}</source></trans-unit>`,
    )
    .join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><xliff version="1.2"><file original="source.idml" datatype="plaintext" source-language="${xmlEscape(sourceLocale)}" target-language="${xmlEscape(targetLocale)}"><body>${units}</body></file></xliff>`,
    'utf8',
  );
}

function parseTranslatedXliff(buffer, segments) {
  const document = parseXml(buffer.toString('utf8'), 'Translated XLIFF');
  const expected = new Set(segments.map((segment) => segment.id));
  const translations = new Map();
  const units = Array.from(document.getElementsByTagName('trans-unit'));
  for (const unit of units) {
    const id = unit.getAttribute('id');
    if (!id || !expected.has(id) || translations.has(id)) {
      throw new IdmlError('Translated XLIFF changed segment identifiers', 'segment_mismatch');
    }
    const targets = Array.from(unit.childNodes).filter(
      (node) => node.nodeType === 1 && node.localName === 'target',
    );
    const text = targets[0]?.textContent;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new IdmlError(`Translated XLIFF has no target for ${id}`, 'missing_translation');
    }
    translations.set(id, text);
  }
  if (translations.size !== expected.size) {
    throw new IdmlError('Translated XLIFF omitted one or more segments', 'segment_mismatch');
  }
  return translations;
}

function localeParts(locale) {
  const parsed = new Intl.Locale(locale);
  return { language: parsed.language.toLowerCase(), region: parsed.region?.toUpperCase() };
}

function findGlossaryColumn(headers, locale, { source = false } = {}) {
  const { language, region } = localeParts(locale);
  const language3 = LANGUAGE_2_TO_3[language] ?? language.toLowerCase();
  const candidates = [];
  if (region && REGION_2_TO_3[region]) {
    candidates.push(`${language3}_${REGION_2_TO_3[region]}`);
  }
  if (source && language === 'en') {
    candidates.push('eng_GLO');
  }
  candidates.push(`${language3}_GLO`);
  const normalized = new Map(headers.map((header, index) => [String(header).toLowerCase(), index]));
  for (const candidate of candidates) {
    const index = normalized.get(candidate.toLowerCase());
    if (index != null) {
      return index;
    }
  }
  return headers.findIndex((header) => String(header).toLowerCase().startsWith(`${language3}_`));
}

async function readGlossarySource(glossaryRef) {
  const revision = configuredGlossaryRevision() ?? 'unversioned';
  if (!glossaryRef.startsWith('azure://')) {
    const stats = await fs.stat(glossaryRef);
    if (stats.size > GLOSSARY_SOURCE_MAX_BYTES) {
      throw new IdmlError('Configured glossary source exceeds 20 MB', 'invalid_glossary');
    }
    const cacheKey = `${glossaryRef}:${stats.mtimeMs}:${revision}`;
    if (glossaryTableCache?.cacheKey === cacheKey) {
      return { cacheKey };
    }
    return { cacheKey, text: decodeGlossaryBuffer(await fs.readFile(glossaryRef)) };
  }
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new IdmlError(
      'Glossary Blob storage is not configured',
      'azure_storage_unconfigured',
      503,
    );
  }
  const [container, ...pathParts] = glossaryRef.slice('azure://'.length).split('/');
  const blobName = pathParts.join('/');
  if (!container || !blobName) {
    throw new IdmlError('Configured glossary Blob reference is invalid', 'invalid_glossary', 503);
  }
  const blob = BlobServiceClient.fromConnectionString(connectionString)
    .getContainerClient(container)
    .getBlockBlobClient(blobName);
  const properties = await blob.getProperties();
  if (!properties.contentLength || properties.contentLength > GLOSSARY_SOURCE_MAX_BYTES) {
    throw new IdmlError('Configured glossary source is empty or exceeds 20 MB', 'invalid_glossary');
  }
  const cacheKey = `${glossaryRef}:${properties.etag}:${revision}`;
  if (glossaryTableCache?.cacheKey === cacheKey) {
    return { cacheKey };
  }
  const buffer = await blob.downloadToBuffer(0, properties.contentLength);
  return {
    cacheKey,
    text: decodeGlossaryBuffer(buffer),
  };
}

async function readGlossaryTable(glossaryRef) {
  const source = await readGlossarySource(glossaryRef);
  if (glossaryTableCache?.cacheKey === source.cacheKey) {
    return glossaryTableCache;
  }
  // Read CSV as decoded UTF-8 text. Passing the raw buffer makes SheetJS use
  // legacy code-page detection and corrupt non-ASCII translations.
  const workbook = XLSX.read(source.text, {
    type: 'string',
    raw: true,
  });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  const headers = (rows.shift() ?? []).map((value) => String(value).trim());
  while (headers.at(-1) === '') {
    headers.pop();
  }
  if (headers.length < 5 || !headers.includes('eng_GLO')) {
    throw new IdmlError('Configured glossary has an unsupported header', 'invalid_glossary');
  }
  glossaryTableCache = { cacheKey: source.cacheKey, headers, rows };
  return glossaryTableCache;
}

function termPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

async function resolveGlossary({
  glossaryPath,
  sourceLocale,
  targetLocale,
  segments,
  filterToDocument = true,
  maxBytes = AZURE_SYNC_GLOSSARY_MAX_BYTES,
}) {
  if (!glossaryPath) {
    return { entries: [], stats: { configured: false, applied: 0 } };
  }
  const table = await readGlossaryTable(glossaryPath);
  const sourceIndex = findGlossaryColumn(table.headers, sourceLocale, { source: true });
  const targetIndex = findGlossaryColumn(table.headers, targetLocale);
  if (sourceIndex < 0 || targetIndex < 0) {
    return {
      entries: [],
      stats: { configured: true, applied: 0, reason: 'locale_column_missing' },
    };
  }

  const documentText = segments.map((segment) => segment.source).join('\n');
  const foldedDocumentText = documentText.normalize('NFKC').toLocaleLowerCase('en-US');
  const terms = new Map();
  let malformedRows = 0;
  let emptyTargets = 0;
  for (const row of table.rows) {
    if (!Array.isArray(row)) {
      malformedRows += 1;
      continue;
    }
    const source = String(row[sourceIndex] ?? '').trim();
    const target = String(row[targetIndex] ?? '').trim();
    const key = source.normalize('NFKC').toLocaleLowerCase('en-US');
    if (
      !source ||
      (filterToDocument &&
        (!foldedDocumentText.includes(key) || !termPattern(source).test(documentText)))
    ) {
      continue;
    }
    if (!target) {
      emptyTargets += 1;
      continue;
    }
    const current = terms.get(key) ?? { source, targets: new Set(), categories: new Set() };
    current.targets.add(target);
    if (row[1]) {
      current.categories.add(String(row[1]));
    }
    terms.set(key, current);
  }

  const entries = [];
  let ambiguous = 0;
  let bytes = 0;
  let truncated = 0;
  const candidates = Array.from(terms.values()).sort(
    (left, right) => right.source.length - left.source.length,
  );
  for (const term of candidates) {
    if (term.targets.size !== 1) {
      ambiguous += 1;
      continue;
    }
    const target = Array.from(term.targets)[0];
    if (/[\t\r\n]/.test(term.source) || /[\t\r\n]/.test(target)) {
      malformedRows += 1;
      continue;
    }
    const lineBytes = Buffer.byteLength(`${term.source}\t${target}\n`, 'utf8');
    if (bytes + lineBytes > maxBytes) {
      throw new IdmlError(
        'Applicable glossary terms exceed the Azure Translator glossary limit',
        'glossary_too_large',
        400,
      );
    }
    entries.push({ source: term.source, target });
    bytes += lineBytes;
  }
  return {
    entries,
    stats: {
      configured: true,
      sourceColumn: table.headers[sourceIndex],
      targetColumn: table.headers[targetIndex],
      applied: entries.length,
      ambiguous,
      emptyTargets,
      malformedRows,
      truncated,
      bytes,
      filteredToDocument: filterToDocument,
    },
  };
}

async function getAzureSupportedLocales(signal) {
  if (azureLanguageCache?.expiresAt > Date.now()) {
    return azureLanguageCache.locales;
  }
  const response = await fetch(
    'https://api.cognitive.microsofttranslator.com/languages?api-version=3.0&scope=translation',
    {
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(10000)]),
    },
  );
  if (!response.ok) {
    throw new Error(`languages endpoint returned ${response.status}`);
  }
  const body = await response.json();
  const locales = new Set(Object.keys(body.translation ?? {}).map((value) => value.toLowerCase()));
  azureLanguageCache = { expiresAt: Date.now() + 24 * 60 * 60 * 1000, locales };
  return locales;
}

async function resolveAzureLocale(locale, signal) {
  try {
    const supported = await getAzureSupportedLocales(signal);
    const lower = locale.toLowerCase();
    if (supported.has(lower)) {
      return locale;
    }
    const primary = new Intl.Locale(locale).language.toLowerCase();
    if (supported.has(primary)) {
      return primary;
    }
    throw new IdmlError(`Azure Translator does not support ${locale}`, 'unsupported_locale', 400);
  } catch (error) {
    if (error instanceof IdmlError) {
      throw error;
    }
    return locale;
  }
}

function translatorConfig() {
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  const key = process.env.AZURE_TRANSLATOR_KEY;
  if (!endpoint || !key) {
    throw new IdmlError('Azure Translator is not configured', 'azure_translator_unconfigured', 503);
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new IdmlError('Azure Translator endpoint is invalid', 'invalid_translator_config', 503);
  }
  if (url.protocol !== 'https:') {
    throw new IdmlError(
      'Azure Translator endpoint must use HTTPS',
      'invalid_translator_config',
      503,
    );
  }
  return {
    endpoint: url.toString().replace(/\/$/, ''),
    key,
    region: process.env.AZURE_TRANSLATOR_REGION,
  };
}

function translatorHeaders(config, contentType) {
  const headers = { 'Ocp-Apim-Subscription-Key': config.key };
  if (config.region) {
    headers['Ocp-Apim-Subscription-Region'] = config.region;
  }
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return headers;
}

function glossaryBuffer(glossary) {
  if (!glossary?.entries?.length) {
    return null;
  }
  return Buffer.from(
    glossary.entries.map((entry) => `${entry.source}\t${entry.target}`).join('\n') + '\n',
    'utf8',
  );
}

function azureError(response, operation) {
  const code =
    response.status === 429
      ? 'translator_rate_limited'
      : [401, 403].includes(response.status)
        ? 'translator_auth_failed'
        : response.status === 408
          ? 'translator_timeout'
          : response.status >= 500
            ? 'translator_failed'
            : 'translator_rejected';
  const error = new IdmlError(
    `Azure Translator ${operation} returned ${response.status}`,
    code,
    response.status,
  );
  error.retryAfter = response.headers.get('retry-after');
  return error;
}

async function translateDocumentWithAzure({
  buffer,
  filename,
  mimeType,
  sourceLocale,
  targetLocale,
  glossary,
  translateTextWithinImage = false,
  signal,
}) {
  const config = translatorConfig();
  const providerSourceLocale = sourceLocale ? await resolveAzureLocale(sourceLocale, signal) : null;
  const providerTargetLocale = await resolveAzureLocale(targetLocale, signal);
  const form = new FormData();
  form.append('document', new Blob([buffer], { type: mimeType }), filename);
  const glossaryTsv = glossaryBuffer(glossary);
  if (glossaryTsv) {
    form.append(
      'glossary',
      new Blob([glossaryTsv], { type: 'text/tab-separated-values' }),
      'glossary.tsv',
    );
  }
  const query = new URLSearchParams({
    targetLanguage: providerTargetLocale,
    'api-version': AZURE_TRANSLATOR_API_VERSION,
  });
  if (providerSourceLocale) query.set('sourceLanguage', providerSourceLocale);
  if (translateTextWithinImage) {
    query.set('translateTextWithinImage', 'true');
  }
  const response = await fetch(`${config.endpoint}/translator/document:translate?${query}`, {
    method: 'POST',
    headers: translatorHeaders(config),
    body: form,
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120000)]),
  });
  if (!response.ok) {
    throw azureError(response, 'synchronous request');
  }
  const output = Buffer.from(await response.arrayBuffer());
  if (output.length === 0 || output.length > AZURE_SYNC_OUTPUT_MAX_BYTES) {
    throw new IdmlError('Azure Translator returned an invalid file size', 'translator_failed', 502);
  }
  return { buffer: output, providerLocale: providerTargetLocale, batches: 1 };
}

function makeAzureXliffBatches(segments) {
  const batches = [];
  let batch = [];
  let bytes = 512;
  for (const segment of segments) {
    const segmentBytes =
      Buffer.byteLength(segment.id, 'utf8') + Buffer.byteLength(segment.source, 'utf8') + 128;
    if (segmentBytes > AZURE_XLIFF_BATCH_BYTES) {
      throw new IdmlError(
        'A text segment exceeds the Azure 7 MB translation limit',
        'invalid_size',
      );
    }
    if (batch.length && bytes + segmentBytes > AZURE_XLIFF_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 512;
    }
    batch.push(segment);
    bytes += segmentBytes;
  }
  if (batch.length) {
    batches.push(batch);
  }
  return batches;
}

async function translateWithAzure({ segments, sourceLocale, targetLocale, glossary, signal }) {
  if (!sourceLocale) {
    throw new IdmlError(
      'source_locale is required for structured-text translation',
      'source_locale_required',
      400,
    );
  }
  const translations = new Map();
  const batches = makeAzureXliffBatches(segments);
  let providerLocale = targetLocale;
  for (const batch of batches) {
    const result = await translateDocumentWithAzure({
      buffer: buildXliff(batch, sourceLocale, targetLocale),
      filename: 'source.xlf',
      mimeType: 'application/xliff+xml',
      sourceLocale,
      targetLocale,
      glossary,
      signal,
    });
    providerLocale = result.providerLocale;
    for (const [id, text] of parseTranslatedXliff(result.buffer, batch)) {
      translations.set(id, text);
    }
  }
  return {
    translations,
    providerLocale,
    batches: batches.length,
  };
}

async function pollBatch({ operationLocation, config, signal }) {
  const operationUrl = new URL(operationLocation);
  if (operationUrl.origin !== new URL(config.endpoint).origin) {
    throw new IdmlError(
      'Azure Translator returned an invalid status URL',
      'translator_failed',
      502,
    );
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < AZURE_BATCH_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Translation aborted');
    }
    const response = await fetch(operationUrl, {
      headers: translatorHeaders(config),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) {
      throw azureError(response, 'batch status request');
    }
    const status = await response.json();
    if (status.status === 'Succeeded') {
      return;
    }
    if (status.status === 'ValidationFailed') {
      throw new IdmlError(
        'Azure Translator rejected the document during batch validation',
        'translator_rejected',
        400,
      );
    }
    if (['Failed', 'Cancelled', 'Canceling'].includes(status.status)) {
      throw new IdmlError(
        `Azure Translator batch ended with ${status.status}`,
        'translator_failed',
        502,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new IdmlError('Azure Translator batch timed out', 'translator_timeout', 504);
}

async function cancelBatch({ operationLocation, config }) {
  const operationUrl = new URL(operationLocation);
  if (operationUrl.origin !== new URL(config.endpoint).origin) {
    return false;
  }
  try {
    const cancellation = await fetch(operationUrl, {
      method: 'DELETE',
      headers: translatorHeaders(config),
      signal: AbortSignal.timeout(10000),
    });
    if (cancellation.status === 404) {
      return true;
    }
    if (![200, 202, 204].includes(cancellation.status)) {
      return false;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < AZURE_CANCEL_TIMEOUT_MS) {
      const response = await fetch(operationUrl, {
        headers: translatorHeaders(config),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404) {
        return true;
      }
      if (!response.ok) {
        return false;
      }
      const { status } = await response.json();
      if (['Succeeded', 'Failed', 'ValidationFailed', 'Cancelled'].includes(status)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    return false;
  }
  return false;
}

async function translateBatchWithAzure({
  buffer,
  filename,
  mimeType,
  sourceLocale,
  targetLocale,
  glossary,
  translateTextWithinImage = false,
  signal,
}) {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new IdmlError(
      'Azure batch translation requires AZURE_STORAGE_CONNECTION_STRING',
      'azure_storage_unconfigured',
      503,
    );
  }
  const config = translatorConfig();
  const providerSourceLocale = sourceLocale ? await resolveAzureLocale(sourceLocale, signal) : null;
  const providerTargetLocale = await resolveAzureLocale(targetLocale, signal);
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const sourceContainer = service.getContainerClient(
    process.env.AZURE_TRANSLATION_SOURCE_CONTAINER || 'translation-source',
  );
  const targetContainer = service.getContainerClient(
    process.env.AZURE_TRANSLATION_TARGET_CONTAINER || 'translation-target',
  );
  await Promise.all([sourceContainer.createIfNotExists(), targetContainer.createIfNotExists()]);

  const jobId = randomUUID();
  const safeName = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const sourceBlob = sourceContainer.getBlockBlobClient(`${jobId}/${safeName}`);
  const targetBlob = targetContainer.getBlockBlobClient(`${jobId}/${safeName}`);
  const glossaryTsv = glossaryBuffer(glossary);
  const glossaryBlob = glossaryTsv
    ? sourceContainer.getBlockBlobClient(`${jobId}/glossary.tsv`)
    : null;
  let operationLocation;
  let safeToDeleteScratch = true;
  try {
    await sourceBlob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mimeType } });
    if (glossaryBlob) {
      await glossaryBlob.uploadData(glossaryTsv, {
        blobHTTPHeaders: { blobContentType: 'text/tab-separated-values' },
      });
    }
    const now = Date.now();
    const sasOptions = {
      protocol: SASProtocol.Https,
      startsOn: new Date(now - 5 * 60 * 1000),
      expiresOn: new Date(now + 30 * 60 * 1000),
    };
    const sourceSasUrl = await sourceBlob.generateSasUrl({
      ...sasOptions,
      permissions: BlobSASPermissions.parse('r'),
    });
    const targetContainerSasUrl = await targetContainer.generateSasUrl({
      ...sasOptions,
      permissions: ContainerSASPermissions.parse('cwl'),
    });
    const targetSasUrl = new URL(targetBlob.url);
    targetSasUrl.search = new URL(targetContainerSasUrl).search;
    const target = {
      targetUrl: targetSasUrl.toString(),
      language: providerTargetLocale,
    };
    if (glossaryBlob) {
      target.glossaries = [
        {
          glossaryUrl: await glossaryBlob.generateSasUrl({
            ...sasOptions,
            permissions: BlobSASPermissions.parse('r'),
          }),
          format: 'TSV',
        },
      ];
    }
    safeToDeleteScratch = false;
    const response = await fetch(
      `${config.endpoint}/translator/document/batches?api-version=${AZURE_TRANSLATOR_API_VERSION}`,
      {
        method: 'POST',
        headers: translatorHeaders(config, 'application/json'),
        body: JSON.stringify({
          inputs: [
            {
              storageType: 'File',
              source: {
                sourceUrl: sourceSasUrl,
                ...(providerSourceLocale ? { language: providerSourceLocale } : {}),
              },
              targets: [target],
            },
          ],
          ...(translateTextWithinImage ? { options: { translateTextWithinImage: true } } : {}),
        }),
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(30000),
        ]),
      },
    );
    if (response.status !== 202) {
      safeToDeleteScratch = true;
      throw azureError(response, 'batch request');
    }
    operationLocation = response.headers.get('operation-location');
    if (!operationLocation) {
      throw new IdmlError('Azure Translator omitted batch status URL', 'translator_failed', 502);
    }
    await pollBatch({ operationLocation, config, signal });
    safeToDeleteScratch = true;
    const download = await targetBlob.downloadToBuffer();
    if (!download.length || download.length > AZURE_SYNC_OUTPUT_MAX_BYTES) {
      throw new IdmlError(
        'Azure Translator returned an invalid file size',
        'translator_failed',
        502,
      );
    }
    return { buffer: download, providerLocale: providerTargetLocale, batches: 1 };
  } catch (error) {
    if (operationLocation && !safeToDeleteScratch) {
      safeToDeleteScratch = await cancelBatch({ operationLocation, config });
      if (!safeToDeleteScratch) {
        logger.warn('[translate_file] scratch cleanup deferred to storage lifecycle', { jobId });
      }
    }
    throw error;
  } finally {
    if (safeToDeleteScratch) {
      await Promise.allSettled([
        sourceBlob.deleteIfExists(),
        targetBlob.deleteIfExists(),
        glossaryBlob?.deleteIfExists(),
      ]);
    }
  }
}

async function glossaryForRequest({
  sourceLocale,
  targetLocale,
  segments,
  filterToDocument = true,
  maxBytes = AZURE_SYNC_GLOSSARY_MAX_BYTES,
}) {
  const blobName = process.env.KNAUF_TRANSLATION_GLOSSARY_BLOB;
  const glossaryPath =
    process.env.KNAUF_IDML_GLOSSARY_PATH ||
    (blobName
      ? `azure://${process.env.AZURE_TRANSLATION_GLOSSARY_CONTAINER || 'translation-glossary'}/${blobName}`
      : '');
  if (!glossaryPath && process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED === 'true') {
    throw new IdmlError(
      'A required translation glossary is not configured',
      'glossary_not_found',
      503,
    );
  }
  if (
    glossaryPath &&
    process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED === 'true' &&
    !configuredGlossaryRevision()
  ) {
    throw new IdmlError(
      'A required translation glossary must have a pinned SHA-256 revision',
      'glossary_revision_required',
      503,
    );
  }
  if (glossaryPath && !sourceLocale) {
    throw new IdmlError(
      'source_locale is required when the Knauf glossary is enabled',
      'source_locale_required',
      400,
    );
  }
  try {
    const glossary = await resolveGlossary({
      glossaryPath,
      sourceLocale,
      targetLocale,
      segments,
      filterToDocument,
      maxBytes,
    });
    if (
      process.env.KNAUF_TRANSLATION_GLOSSARY_REQUIRED === 'true' &&
      glossary.stats.reason === 'locale_column_missing'
    ) {
      throw new IdmlError(
        'The required glossary does not support this language pair',
        'glossary_locale_unsupported',
        400,
      );
    }
    return glossary;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.statusCode === 404) {
      throw new IdmlError(
        `Configured glossary was not found: ${path.basename(glossaryPath)}`,
        'glossary_not_found',
        503,
      );
    }
    if (error instanceof TypeError && error.message.includes('encoded data')) {
      throw new IdmlError('Configured glossary must be UTF-8 encoded', 'invalid_glossary', 400);
    }
    throw error;
  }
}

module.exports = {
  AZURE_BATCH_GLOSSARY_MAX_BYTES,
  AZURE_SYNC_GLOSSARY_MAX_BYTES,
  glossaryForRequest,
  translateBatchWithAzure,
  translateDocumentWithAzure,
  translateWithAzure,
};

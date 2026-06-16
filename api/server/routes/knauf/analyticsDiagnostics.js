const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const MAX_STRING_LENGTH = 160;
const VALID_EVENTS = new Set([
  'config_invalid',
  'onetrust_script_load_failed',
  'adobe_launch_script_load_failed',
  'adobe_app_interaction_rejected',
  'adobe_data_layer_push_failed',
]);
const STRING_FIELDS = [
  'appName',
  'scriptId',
  'scriptHost',
  'scriptPath',
  'pagePath',
  'pageSection',
  'action',
  'component',
  'eventSpecification',
  'reason',
];
const BOOLEAN_FIELDS = ['analyticsEnabled', 'adobeReady'];

function normalizeString(value, maxLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

function sanitizePagePath(pagePath) {
  const normalized = normalizeString(pagePath);
  if (!normalized) {
    return undefined;
  }

  if (normalized === '/' || normalized === '/c/new' || normalized === '/prompts/new') {
    return normalized;
  }

  if (/^\/c\/[^/]+/.test(normalized)) {
    return '/c/:conversationId';
  }

  if (/^\/prompts\/[^/]+/.test(normalized)) {
    return '/prompts/:promptId';
  }

  if (normalized === '/agents') {
    return normalized;
  }

  if (/^\/agents\/[^/]+/.test(normalized)) {
    return '/agents/:category';
  }

  return normalized.split('?')[0].split('#')[0];
}

function sanitizeScriptPath(scriptPath) {
  const normalized = normalizeString(scriptPath);
  if (!normalized) {
    return undefined;
  }

  return normalized.split('?')[0].split('#')[0];
}

function sanitizeStringField(field, value) {
  if (field === 'pagePath') {
    return sanitizePagePath(value);
  }

  if (field === 'scriptPath') {
    return sanitizeScriptPath(value);
  }

  return normalizeString(value);
}

function sanitizeDiagnosticPayload(body = {}) {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const event = normalizeString(body.event, 80);
  if (!event || !VALID_EVENTS.has(event)) {
    return undefined;
  }

  const payload = { event };

  for (const field of STRING_FIELDS) {
    const value = sanitizeStringField(field, body[field]);
    if (value) {
      payload[field] = value;
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === 'boolean') {
      payload[field] = body[field];
    }
  }

  return payload;
}

router.post('/diagnostics', requireJwtAuth, (req, res) => {
  const diagnostic = sanitizeDiagnosticPayload(req.body);
  if (!diagnostic) {
    logger.warn('[knauf analytics diagnostics] Invalid diagnostic payload');
    return res.status(400).json({ message: 'Invalid analytics diagnostics payload.' });
  }

  logger.info(
    { knaufAnalyticsDiagnostic: diagnostic },
    `[knauf analytics diagnostics] ${diagnostic.event}`,
  );
  return res.status(204).send();
});

module.exports = router;
module.exports.sanitizeDiagnosticPayload = sanitizeDiagnosticPayload;

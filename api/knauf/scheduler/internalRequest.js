'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const { logger } = require('@librechat/data-schemas');
const { extractSchedulerAgentSnapshot } = require('./agentSnapshot');

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SIGNATURE_HEADER = 'x-knauf-scheduler-signature';
const TIMESTAMP_HEADER = 'x-knauf-scheduler-timestamp';
const TRIGGER_HEADER = 'x-knauf-scheduler-trigger';
const MAX_CLOCK_SKEW_MS = 60_000;

const signaturePayload = ({ timestamp, userId, trigger, method, path }) =>
  [timestamp, userId, trigger, method.toUpperCase(), path].join('\n');

const signSchedulerRequest = ({ secret, timestamp, userId, trigger, method, path }) =>
  createHmac('sha256', secret)
    .update(signaturePayload({ timestamp, userId, trigger, method, path }))
    .digest('hex');

function createSchedulerRequestHeaders({
  secret,
  userId,
  trigger,
  method,
  path,
  now = () => Date.now(),
}) {
  if (!secret) {
    throw new Error('KNAUF_SCHEDULER_INTERNAL_SECRET is required');
  }
  const timestamp = String(now());
  return {
    'User-Agent': BROWSER_USER_AGENT,
    [TIMESTAMP_HEADER]: timestamp,
    [TRIGGER_HEADER]: trigger,
    [SIGNATURE_HEADER]: signSchedulerRequest({
      secret,
      timestamp,
      userId: String(userId),
      trigger,
      method,
      path,
    }),
  };
}

function hasSchedulerHeaders(req) {
  return Boolean(req.get(SIGNATURE_HEADER) || req.get(TIMESTAMP_HEADER) || req.get(TRIGGER_HEADER));
}

function verifySchedulerRequest(req, { secret, now = () => Date.now() }) {
  if (!secret || !hasSchedulerHeaders(req)) {
    return null;
  }
  const signature = req.get(SIGNATURE_HEADER);
  const timestamp = req.get(TIMESTAMP_HEADER);
  const trigger = req.get(TRIGGER_HEADER);
  const timestampMs = Number(timestamp);
  if (
    !signature ||
    !timestamp ||
    !['automatic', 'manual'].includes(trigger) ||
    !Number.isFinite(timestampMs) ||
    Math.abs(now() - timestampMs) > MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  const expected = signSchedulerRequest({
    secret,
    timestamp,
    userId: String(req.user.id),
    trigger,
    method: req.method,
    path: req.originalUrl,
  });
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  return { trigger };
}

function createSchedulerFireMiddleware({
  getSecret = () => process.env.KNAUF_SCHEDULER_INTERNAL_SECRET,
  admitUserRequest,
} = {}) {
  return async (req, res, next) => {
    if (!hasSchedulerHeaders(req)) {
      return next();
    }
    const schedulerFire = verifySchedulerRequest(req, { secret: getSecret() });
    if (schedulerFire == null) {
      return res.status(401).json({ error: 'Invalid scheduler request signature' });
    }
    req.knaufSchedulerFire = schedulerFire;
    extractSchedulerAgentSnapshot(req);
    if (req.method === 'POST' && req.originalUrl.split('?')[0].endsWith('/chat/agents')) {
      const admit = admitUserRequest ?? require('./userLifecycle').admitSchedulerUserRequest;
      const release = await admit(req.user.id);
      if (release == null) {
        return res.status(410).json({ error: 'Schedule owner is being deleted' });
      }
      req.knaufSchedulerAdmissionRelease = release;
      const releaseOnEnd = () => {
        release().catch((error) => {
          logger.error('[scheduler] Failed to release request admission', error);
        });
      };
      res.once('finish', releaseOnEnd);
      res.once('close', releaseOnEnd);
    }
    return next();
  };
}

function releaseSchedulerAdmission(req) {
  return req.knaufSchedulerAdmissionRelease?.();
}

const exemptSchedulerIpLimiter = (req) => req.knaufSchedulerFire != null;
const exemptSchedulerUserLimiter = (req) => req.knaufSchedulerFire?.trigger === 'automatic';

module.exports = {
  BROWSER_USER_AGENT,
  createSchedulerFireMiddleware,
  createSchedulerRequestHeaders,
  exemptSchedulerIpLimiter,
  exemptSchedulerUserLimiter,
  releaseSchedulerAdmission,
  verifySchedulerRequest,
};

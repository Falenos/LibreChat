'use strict';

const { evaluateReadiness } = require('../../server/services/Files/knauf/workerProbes');

function parsePositiveIntegerSetting(name, value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function getSchedulerReadiness({
  mongoConnected,
  lastProgressAt,
  staleAfterMs,
  stopping = false,
  now = Date.now,
}) {
  const lastProgressAgoMs =
    lastProgressAt == null ? Number.POSITIVE_INFINITY : now() - lastProgressAt.getTime();
  const ready =
    !stopping &&
    evaluateReadiness({
      mongoConnected,
      lastProgressAgoMs,
      staleAfterMs,
    });
  return {
    ready,
    detail: {
      mongo: mongoConnected,
      loopProgress: Number.isFinite(lastProgressAgoMs) && lastProgressAgoMs <= staleAfterMs,
      stopping,
    },
  };
}

module.exports = { getSchedulerReadiness, parsePositiveIntegerSetting };

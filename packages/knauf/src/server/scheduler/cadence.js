'use strict';

const { Cron } = require('croner');

const SCHEDULE_JITTER_WINDOW_MS = 120_000;
const WEEKLY_DEFAULT_DAY = 1;

function cadenceToCron(cadence) {
  const { frequency, hour, minute } = cadence ?? {};
  if (frequency === 'hourly') {
    return `${minute} * * * *`;
  }
  if (frequency === 'daily') {
    return `${minute} ${hour} * * *`;
  }
  if (frequency === 'weekdays') {
    return `${minute} ${hour} * * 1-5`;
  }
  if (frequency === 'weekly') {
    const days = cadence.daysOfWeek?.length ? cadence.daysOfWeek : [WEEKLY_DEFAULT_DAY];
    return `${minute} ${hour} * * ${[...days].sort((a, b) => a - b).join(',')}`;
  }
  throw new TypeError('cadence requires a supported frequency');
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function scheduleJitterMs(scheduleId, windowMs = SCHEDULE_JITTER_WINDOW_MS) {
  let hash = 5381;
  for (let index = 0; index < scheduleId.length; index++) {
    hash = ((hash << 5) + hash + scheduleId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % windowMs;
}

function computeNextRunAt({
  cadence,
  timezone,
  scheduleId,
  after = new Date(),
  disableJitter = false,
}) {
  try {
    const cron = new Cron(cadenceToCron(cadence), { timezone, paused: true });
    const jitter = disableJitter ? 0 : scheduleJitterMs(scheduleId);
    const next = cron.nextRun(new Date(after.getTime() - jitter));
    return next == null ? null : new Date(next.getTime() + jitter);
  } catch {
    return null;
  }
}

module.exports = {
  SCHEDULE_JITTER_WINDOW_MS,
  cadenceToCron,
  computeNextRunAt,
  isValidTimezone,
  scheduleJitterMs,
};

'use strict';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_TIME_MS = 30_000;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function createConversationIntegritySampler({
  conversations,
  metrics,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxTimeMS = DEFAULT_MAX_TIME_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer = null;
  let inFlight = null;

  const sample = () => {
    if (inFlight != null) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const missingChatProjectId = await conversations.countDocuments(
          { chatProjectId: { $exists: false } },
          { maxTimeMS },
        );
        if (!Number.isSafeInteger(missingChatProjectId) || missingChatProjectId < 0) {
          throw new TypeError('Invalid conversation integrity count');
        }
        metrics.setConversationIntegrity({
          missingChatProjectId,
          scanHealthy: true,
        });
        return { healthy: true, missingChatProjectId };
      } catch (error) {
        metrics.setConversationIntegrityScanHealthy(false);
        const candidate = typeof error?.name === 'string' ? error.name : '';
        const errorName = SAFE_ERROR_NAME.test(candidate) ? candidate : 'Error';
        logger.error(`[scheduler] conversation integrity scan failed (${errorName})`);
        return { healthy: false };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  const start = () => {
    if (timer != null) {
      return inFlight ?? Promise.resolve();
    }
    const initialSample = sample();
    timer = setIntervalFn(() => {
      if (timer != null) {
        void sample();
      }
    }, intervalMs);
    timer.unref?.();
    return initialSample;
  };

  const stop = async () => {
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
    await inFlight;
  };

  return { sample, start, stop };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_TIME_MS,
  createConversationIntegritySampler,
};

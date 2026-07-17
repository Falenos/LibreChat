// [knauf] KK20-195 WP3c — admission control for the durable indexing backlog
// (hardened plan §9.3): one browser must not create an unbounded queue. Only
// exercised when async acceptance applies to the request — the synchronous
// path embeds in-request and leaves no backlog behind. Limits are per
// authorization scope (the same scope the reservation will use): chat
// attachments count against the user, agent-library uploads against the
// agent. Rejections are HTTP 429 with the stable code
// `file_indexing_backlog_full`.
//
// Defaults are the §17 assumption-ledger values (20 queued files / 500 MB),
// env-tunable and read at call time like the other async-indexing knobs.

/** @param {string | undefined} raw @param {number} fallback @returns {number} */
const envInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** @returns {{ maxQueuedFiles: number, maxQueuedBytes: number }} */
const getAdmissionLimits = () => ({
  maxQueuedFiles: envInt(process.env.KNAUF_INDEX_MAX_QUEUED_FILES, 20),
  maxQueuedBytes: envInt(process.env.KNAUF_INDEX_MAX_QUEUED_BYTES, 500 * 1024 * 1024),
});

/**
 * Count the scope's non-terminal backlog (uploading | queued | processing)
 * and admit or reject the upload. Byte sums only see blob metadata recorded
 * so far (uploading assets may count 0 bytes) — the file-count cap is the
 * hard backstop.
 *
 * KK20-195 review R7 — TOCTOU-safe usage is reserve-FIRST, then admit with
 * `countIncludesSelf: true`, compensating the reservation on rejection: every
 * contender's reservation is durably counted before any contender decides,
 * so N concurrent uploads can never all read the same pre-reservation count
 * and collectively exceed the cap. (A pure read-then-reserve check raced.)
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (countActiveByScope, sumActiveBytesByScope)
 * @param {'user' | 'agent'} params.scope_type
 * @param {string} params.scope_id
 * @param {number} [params.incomingBytes]
 * @param {boolean} [params.countIncludesSelf] - the caller already reserved; its own row is in the counts
 * @returns {Promise<{ admitted: boolean, reason?: 'queued_files' | 'queued_bytes' }>}
 */
async function checkIndexAdmission({
  db,
  scope_type,
  scope_id,
  incomingBytes = 0,
  countIncludesSelf = false,
}) {
  const { maxQueuedFiles, maxQueuedBytes } = getAdmissionLimits();
  const activeCount = await db.countActiveByScope({ scope_type, scope_id });
  const effectiveCount = countIncludesSelf ? activeCount - 1 : activeCount;
  if (effectiveCount >= maxQueuedFiles) {
    return { admitted: false, reason: 'queued_files' };
  }
  const activeBytes = await db.sumActiveBytesByScope({ scope_type, scope_id });
  if (activeBytes + incomingBytes > maxQueuedBytes) {
    return { admitted: false, reason: 'queued_bytes' };
  }
  return { admitted: true };
}

module.exports = {
  getAdmissionLimits,
  checkIndexAdmission,
};
// End [knauf]

// [knauf] KK20-195 WP3c — admission control for the durable indexing backlog
// (hardened plan §9.3): one browser must not create an unbounded queue. Only
// exercised when async acceptance applies to the request — the synchronous
// path embeds in-request and leaves no backlog behind. Limits are per
// authorization scope (the same scope the reservation will use): chat
// attachments count against the user, agent-library uploads against the
// agent. Rejections are HTTP 429 with the stable code
// `file_indexing_backlog_full`.
//
// The default admits a normal bulk agent build (50 files) while the 500 MB
// byte cap still bounds memory/storage pressure. Both remain env-tunable and
// are read at call time like the other async-indexing knobs.

/** @param {string | undefined} raw @param {number} fallback @returns {number} */
const envInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** @returns {{ maxQueuedFiles: number, maxQueuedBytes: number }} */
const getAdmissionLimits = () => ({
  maxQueuedFiles: envInt(process.env.KNAUF_INDEX_MAX_QUEUED_FILES, 50),
  maxQueuedBytes: envInt(process.env.KNAUF_INDEX_MAX_QUEUED_BYTES, 500 * 1024 * 1024),
});

/**
 * Count the scope's non-terminal backlog (uploading | queued | processing)
 * and admit or reject the upload.
 *
 * KK20-195 review R7/F9 — TOCTOU-safe usage is reserve-FIRST (carrying the
 * expected bytes as `reserved_bytes`), then admit with `countIncludesSelf: true`,
 * compensating the reservation on rejection. Every contender's reservation —
 * both its row AND its reserved bytes — is durably counted before any contender
 * decides, so N concurrent uploads can never all read the same pre-reservation
 * total and collectively exceed either cap. (F9: before reserved_bytes, an
 * 'uploading' row counted 0 bytes, so two concurrent 300 MB uploads both passed
 * a 500 MB cap.)
 *
 * @param {Object} params
 * @param {Object} params.db - createMethods surface (countActiveByScope, sumActiveBytesByScope)
 * @param {'user' | 'agent'} params.scope_type
 * @param {string} params.scope_id
 * @param {number} [params.incomingBytes]
 * @param {boolean} [params.countIncludesSelf] - the caller already reserved; its own row (and reserved_bytes) are in the counts
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
  // When we've already reserved, our own reserved_bytes are IN activeBytes —
  // adding incomingBytes again would double-count. When we haven't (a pure
  // pre-reserve check), our bytes aren't counted yet, so add them.
  const effectiveBytes = countIncludesSelf ? activeBytes : activeBytes + incomingBytes;
  if (effectiveBytes > maxQueuedBytes) {
    return { admitted: false, reason: 'queued_bytes' };
  }
  return { admitted: true };
}

module.exports = {
  getAdmissionLimits,
  checkIndexAdmission,
};
// End [knauf]

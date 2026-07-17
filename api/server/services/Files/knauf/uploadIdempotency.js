// [knauf] KK20-195 WP3a — upload idempotency decisions (plan §6.1 steps 3+5).
//
// The client already generates a file_id per upload; the server used to
// discard it (multer minted its own), which made every retried upload a brand
// new file — the "lost response → duplicate blob + embedding, billed forever"
// failure mode. These helpers make the client id THE logical idempotency key:
// an exact retry resolves to the original row, and the same id with different
// content or a different owner is a hard 409, never an overwrite.
//
// Content equality (KK20-195 review R3): the SHA-256 content hash is
// authoritative whenever both sides have one — same-length different-content
// retries must conflict, not replay. Byte length remains the fallback for
// rows that predate hashing (agent-library rows carry no hash).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only a well-formed UUID may be adopted as the logical file_id — anything
 * else falls back to the server-minted id (today's behavior).
 * @param {unknown} id
 * @returns {boolean}
 */
const isValidClientFileId = (id) => typeof id === 'string' && UUID_RE.test(id);

/**
 * Classify a repeated (owner, file_id) upload.
 * @param {Object} params
 * @param {{ user?: unknown, bytes?: number, knauf_content_hash?: string } | undefined} params.existing - row found by unscoped file_id lookup
 * @param {string} params.userId
 * @param {number | undefined} params.incomingBytes
 * @param {string | undefined} [params.incomingHash] - SHA-256 of the incoming bytes (R3: authoritative when both sides have one)
 * @returns {{ outcome: 'proceed' } | { outcome: 'replay' } | { outcome: 'conflict', reason: 'file_id_taken' | 'different_content' }}
 */
const classifyUploadReplay = ({ existing, userId, incomingBytes, incomingHash }) => {
  if (!existing) {
    return { outcome: 'proceed' };
  }
  if (String(existing.user) !== String(userId)) {
    // The id belongs to someone else — never overwrite, never reveal whose.
    return { outcome: 'conflict', reason: 'file_id_taken' };
  }
  if (existing.knauf_content_hash != null && incomingHash != null) {
    return existing.knauf_content_hash === incomingHash
      ? { outcome: 'replay' }
      : { outcome: 'conflict', reason: 'different_content' };
  }
  if (existing.bytes != null && incomingBytes != null && existing.bytes !== incomingBytes) {
    return { outcome: 'conflict', reason: 'different_content' };
  }
  return { outcome: 'replay' };
};

module.exports = { isValidClientFileId, classifyUploadReplay };
// End [knauf]

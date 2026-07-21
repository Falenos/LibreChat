// [knauf] KK20-195 WP2 — the ONE definition of the physical dedup key.
// Hardened plan §4.2: authorization/isolation scope + content hash, and
// nothing else (the index profile is deliberately excluded — a profile change
// re-indexes the SAME asset through a new generation). Chat-only today; agent
// library uploads stay un-deduplicated. Used by the FileAsset migration and
// by the WP3 upload reservation — they MUST agree, so neither builds its own.

/**
 * @param {{ user: string, contentHash: string }} params
 * @returns {string}
 */
function buildDedupKey({ user, contentHash }) {
  return `u:${user}:h:${contentHash}`;
}

module.exports = { buildDedupKey };
// End [knauf]

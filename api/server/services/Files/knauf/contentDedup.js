// [knauf] KK20-204 — per-user content-hash deduplication helpers.
//
// On a file_search upload, processAgentFileUpload hashes the bytes and looks up
// whether THIS user already has a File whose content matches. On a hit, the new
// upload becomes a lightweight POINTER row that reuses the canonical row's blob +
// embeddings (no re-upload, no re-embed). Per-user only — the lookup is keyed on
// (user, knauf_content_hash) — so content is never shared across users.
// See knauf/docs/proposals/file-dedup-content-hash.md.

const fs = require('fs');
const crypto = require('crypto');
const db = require('~/models');

/**
 * SHA-256 of a file's raw bytes (streamed, so large files don't buffer in memory).
 * Hash the bytes, not extracted text — text varies with OCR/parser config, bytes don't.
 * @param {string} filePath
 * @returns {Promise<string>} hex digest
 */
function computeContentHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Find the canonical File row for (user, content hash) — the row that owns the
 * shared blob + embeddings. A canonical has no knauf_canonical_file_id (pointers
 * set it). Returns null when this content is new for the user.
 *
 * A rare concurrent first-upload race can leave two canonicals for one hash; we
 * return the oldest deterministically so later uploads converge on one, and the
 * delete-time GC cleans every distinct canonical asset in the group regardless.
 * @param {{ user: string, knauf_content_hash: string }} params
 * @returns {Promise<object|null>}
 */
async function findCanonicalForHash({ user, knauf_content_hash }) {
  if (!knauf_content_hash) {
    return null;
  }
  const rows = (await db.getFiles({ user, knauf_content_hash })) ?? [];
  const canonicals = rows.filter((row) => !row.knauf_canonical_file_id);
  if (!canonicals.length) {
    return null;
  }
  canonicals.sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
  return canonicals[0];
}

module.exports = { computeContentHash, findCanonicalForHash };

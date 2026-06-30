// [knauf] KK20-204 — per-user content-hash deduplication helpers.
//
// On a file_search upload, processAgentFileUpload hashes the bytes and looks up
// whether THIS user already has a File whose content matches. On a hit, the new
// upload becomes a lightweight reuse row that points at the existing asset
// (knauf_asset_id) — the shared blob + embeddings — instead of re-uploading and
// re-embedding. Per-user only — the lookup is keyed on (user, knauf_content_hash)
// — so content is never shared across users.
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
 * Find the existing shared asset for (user, content hash) — ANY surviving row for
 * the group works, because every deduped row carries `knauf_asset_id` (the file_id
 * the blob + embeddings physically live under). Returns the representative row
 * (oldest, deterministic) so the caller can reuse its asset_id + storage metadata
 * (filepath / bytes / filename / embedded / source); returns null when this content
 * is new for the user.
 *
 * Resolving via `knauf_asset_id` on any row — rather than requiring a special
 * "canonical" row to still exist — is what makes deletion of the embed owner while
 * other rows survive NOT trigger a redundant re-embed (KK20-204 Issue 2).
 * @param {{ user: string, knauf_content_hash: string }} params
 * @returns {Promise<object|null>}
 */
async function findAssetForHash({ user, knauf_content_hash }) {
  if (!knauf_content_hash) {
    return null;
  }
  // Only rows that carry an asset id are dedup candidates — filter DB-side over the
  // (user, knauf_content_hash) partial index instead of fetching the whole group and
  // dropping the rest in JS.
  const rows =
    (await db.getFiles({ user, knauf_content_hash, knauf_asset_id: { $exists: true } })) ?? [];
  if (!rows.length) {
    return null;
  }
  // Pick the OLDEST row deterministically (the original owner's asset in the normal
  // case; a stable choice in the rare double-embed case). Sorted here rather than via
  // getFiles' sortOptions, whose hard-coded `{ updatedAt: -1 }` default always dominates
  // the sort key order and would change which row is chosen.
  rows.sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
  return rows[0];
}

module.exports = { computeContentHash, findAssetForHash };

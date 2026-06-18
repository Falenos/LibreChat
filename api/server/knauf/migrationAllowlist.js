// [knauf] Migration allowlist service.
//
// Wraps DB reads in a simple in-process TTL cache so the allowlist check
// adds no meaningful latency to every API request.
// The cache is per-process; a restart or TTL expiry forces a fresh DB read.
//
// TTL is controlled by MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES (default: 0 = no cache).
// Set to a positive number (e.g. 10) in production to reduce DB load.
'use strict';

const mongoose = require('mongoose');

const _ttlMinutes = parseInt(process.env.MIGRATION_ALLOWLIST_CACHE_TTL_MINUTES ?? '0', 10);
const CACHE_TTL_MS = (isNaN(_ttlMinutes) || _ttlMinutes < 0 ? 0 : _ttlMinutes) * 60 * 1000;

/** @type {Map<string, { allowed: boolean; expiresAt: number }>} */
const cache = new Map();

/**
 * Checks whether an email address is on the migration allowlist.
 * Results are cached per email for CACHE_TTL_MS when TTL > 0.
 * When TTL = 0 (default) the cache is bypassed entirely — no reads or writes.
 *
 * @param {string} email - Raw email (will be normalised to lowercase).
 * @returns {Promise<boolean>}
 */
async function isEmailAllowed(email) {
  const key = (email || '').toLowerCase().trim();
  if (!key) return false;

  if (CACHE_TTL_MS > 0) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.allowed;
    }
  }

  // Use the model registered by createModels() at startup — no inline schema needed.
  const Model = mongoose.models.MigrationAllowlist;
  if (!Model) {
    throw new Error(
      'MigrationAllowlist model not registered. Ensure createModels() has been called.',
    );
  }

  // key is already lowercased above; schema enforces lowercase: true on write,
  // so this equality match hits the unique index directly.
  const doc = await Model.findOne({ emailNormalized: key }).lean();
  const allowed = doc != null;

  if (CACHE_TTL_MS > 0) {
    cache.set(key, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return allowed;
}

module.exports = { isEmailAllowed };
// End [knauf]

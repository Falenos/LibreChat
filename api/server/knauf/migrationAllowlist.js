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
 * Returns the Mongoose model, creating it if not yet registered.
 * Uses a plain schema definition here to avoid TS→JS compilation issues
 * when called from JS route/middleware files.
 */
function getModel() {
  if (mongoose.models.MigrationAllowlist) {
    return mongoose.models.MigrationAllowlist;
  }
  const schema = new mongoose.Schema(
    {
      emailNormalized: { type: String, required: true, lowercase: true, trim: true },
    },
    { timestamps: true },
  );
  schema.index({ emailNormalized: 1 }, { unique: true });
  return mongoose.model('MigrationAllowlist', schema);
}

/**
 * Checks whether an email address is on the migration allowlist.
 * Results are cached per email for CACHE_TTL_MS.
 *
 * @param {string} email - Raw email (will be normalised to lowercase).
 * @returns {Promise<boolean>}
 */
async function isEmailAllowed(email) {
  const key = (email || '').toLowerCase().trim();
  if (!key) return false;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.allowed;
  }

  const Model = getModel();
  // Always compare lowercase-to-lowercase: normalise the DB value at query time
  // so manually-inserted mixed-case emails are matched correctly.
  const doc = await Model.findOne({
    $expr: { $eq: [{ $toLower: '$emailNormalized' }, key] },
  }).lean();
  const allowed = doc != null;

  cache.set(key, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
  return allowed;
}

module.exports = { isEmailAllowed };
// End [knauf]

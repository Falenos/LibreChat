// [knauf] Express middleware: rejects authenticated users who are not on
// the migration allowlist with HTTP 403.
//
// Must be placed AFTER requireJwtAuth (which populates req.user).
// Unauthenticated requests (no req.user) are passed through — the route's
// own requireJwtAuth will reject them with 401.
// Authenticated tokens with no email claim are rejected with 401.
'use strict';

const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

/**
 * Blocks requests from users whose email is not in migration_allowlists.
 * Pass-through only for genuinely unauthenticated requests (no req.user).
 */
async function requireMigrationAccess(req, res, next) {
  // No user at all — unauthenticated request, requireJwtAuth on the route handles 401
  if (!req.user) return next();

  const email = req.user.email;

  // Authenticated but token carries no email claim — reject
  if (!email) {
    return res.status(401).json({ message: 'Unauthorized: no email claim in token' });
  }

  try {
    const allowed = await isEmailAllowed(email);
    if (!allowed) {
      return res.status(403).json({
        message: 'Access to this platform is not yet enabled for your account.',
        code: 'MIGRATION_ACCESS_DENIED',
      });
    }
    return next();
  } catch (err) {
    // Fail closed: a DB error must not grant access to the new platform
    return res.status(503).json({
      message: 'Access check temporarily unavailable. Please try again shortly.',
      code: 'MIGRATION_ACCESS_UNAVAILABLE',
    });
  }
}

module.exports = requireMigrationAccess;
// End [knauf]

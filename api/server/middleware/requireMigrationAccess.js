// [knauf] Express middleware: rejects authenticated users who are not on
// the migration allowlist with HTTP 403.
//
// Must be placed AFTER requireJwtAuth (which populates req.user).
// Non-authenticated requests are passed through unchanged — the route's
// own requireJwtAuth will reject them with 401.
'use strict';

const { isEmailAllowed } = require('~/server/knauf/migrationAllowlist');

/**
 * Blocks requests from users whose email is not in migration_allowlists.
 * Pass-through for unauthenticated requests (requireJwtAuth handles those).
 */
async function requireMigrationAccess(req, res, next) {
  const email = req.user?.email;

  // No user on the request — let requireJwtAuth handle the 401
  if (!email) return next();

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
    // Fail open: a DB error should not lock out users entirely
    return next();
  }
}

module.exports = requireMigrationAccess;
// End [knauf]

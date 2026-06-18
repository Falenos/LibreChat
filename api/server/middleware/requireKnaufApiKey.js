// [knauf] Middleware: validates X-Knauf-Api-Key header against KNAUF_MIGRATION_API_SECRET.
// Used by endpoints that are called by third-party apps (not by the AGK frontend).
// Returns 401 if the key is missing, wrong, or if the env var is not configured.
'use strict';

const SECRET = process.env.KNAUF_MIGRATION_API_SECRET;

async function requireKnaufApiKey(req, res, next) {
  if (!SECRET) {
    return res.status(500).json({
      message: 'API key authentication is not configured on this server.',
    });
  }

  const provided = req.headers['x-knauf-api-key'];

  if (!provided || provided !== SECRET) {
    return res.status(401).json({ message: 'Unauthorized: invalid or missing X-Knauf-Api-Key' });
  }

  return next();
}

module.exports = requireKnaufApiKey;
// End [knauf]

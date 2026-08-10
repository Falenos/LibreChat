const { isEnabled } = require('@librechat/api');

const PUBLIC_SHARED_LINK_READ =
  /^\/share\/[^/]+(?:\/config|\/files\/[^/]+(?:\/(?:download|preview))?)?$/;

/** Let public share reads reach their route-level ACL without weakening owner or mutation routes. */
module.exports = function isPublicSharedLinkRead(req) {
  const sharedLinksEnabled =
    process.env.ALLOW_SHARED_LINKS === undefined || isEnabled(process.env.ALLOW_SHARED_LINKS);

  return (
    req.method === 'GET' &&
    sharedLinksEnabled &&
    isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC) &&
    PUBLIC_SHARED_LINK_READ.test(req.path)
  );
};

// [knauf] KK20-195 WP3b — the async-indexing feature flags (plan §12).
//
// Three independently configurable switches (never one flag for acceptance and
// execution — rollback must stop new async uploads while queued work drains):
//   KNAUF_ASYNC_FILE_INDEXING_ACCEPT  permits upload to return 202 after queued
//   KNAUF_INDEXING_WORKER_ENABLED     the dedicated worker claims queued work
//   KNAUF_ASYNC_INDEXING_TENANTS      optional tenant allow-list gating the
//                                     accept flag during canary (empty = all)
// Plus KNAUF_INDEX_PROFILE — the server-selected index profile stamped on new
// reservations (plan §4.2: generation metadata, never a client input).
//
// Read at call time (not boot constants): the tenant canary list must be
// changeable per deploy without code, and tests flip env without module
// reloads. Values are trivial to parse, so there is no boot-validation risk.

/** @param {unknown} value @returns {boolean} */
const isTrue = (value) => typeof value === 'string' && value.toLowerCase() === 'true';

/** @returns {boolean} */
const isAsyncAcceptEnabled = () => isTrue(process.env.KNAUF_ASYNC_FILE_INDEXING_ACCEPT);

/** @returns {boolean} */
const isIndexingWorkerEnabled = () => isTrue(process.env.KNAUF_INDEXING_WORKER_ENABLED);

/** @returns {string[]} */
const getTenantAllowlist = () =>
  (process.env.KNAUF_ASYNC_INDEXING_TENANTS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Async acceptance for THIS request: both acceptance and worker execution must
 * be enabled, and when a tenant allow-list is configured the requester's tenant
 * must be in it. A mismatched deployment therefore falls back to the bounded
 * synchronous claim/embed path instead of stranding queued uploads.
 * @param {{ tenantId?: string | null } | undefined} user
 * @returns {boolean}
 */
const isAsyncAcceptedForUser = (user) => {
  if (!isAsyncAcceptEnabled() || !isIndexingWorkerEnabled()) {
    return false;
  }
  const allowlist = getTenantAllowlist();
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.includes(String(user?.tenantId ?? ''));
};

/** @returns {string} */
const getIndexProfile = () => process.env.KNAUF_INDEX_PROFILE || 'legacy-v0';

module.exports = {
  isAsyncAcceptEnabled,
  isIndexingWorkerEnabled,
  isAsyncAcceptedForUser,
  getTenantAllowlist,
  getIndexProfile,
};
// End [knauf]

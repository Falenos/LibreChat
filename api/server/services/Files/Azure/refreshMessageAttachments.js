// [knauf] KK20-182 — Refresh Azure SAS URLs embedded in
// `messages[].attachments[].filepath` and `messages[].files[].filepath`
// on the response payload. In-memory only (no Mongo writes).
//
// The `files` collection refresh chain (KK20-167) does not cover SAS URLs
// that get snapshotted into messages, so generated and uploaded images
// 403 a few minutes after the conversation is reopened. See
// `knauf/docs/reference/azure-blob-storage.md` §7.1 for the full design.
//
// Paired with `[knauf]` markers in:
//   - api/server/routes/messages.js
//   - api/server/routes/share.js
//   - api/server/controllers/tools.js
//   - api/server/services/Files/Azure/index.js
// End [knauf]

const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { needsRefreshAzure, getNewAzureURL, isAzureBlobUrl } = require('./crud');

/**
 * Refresh window passed to `needsRefreshAzure`. With the KK20-167 default
 * URL TTL of 5 minutes, any value larger than the TTL effectively means
 * "always re-sign on read" — which is what we want here because the
 * snapshot in Mongo is never updated.
 */
const DEFAULT_BUFFER_SECONDS = 3600;

/**
 * Decide whether a snapshotted attachment looks Azure-owned, so we don't
 * pay the refresh cost (or log error noise) for local paths like
 * `/uploads/...`, S3 URLs, or third-party avatar URLs that happen to live
 * in the same `[Mixed]` array. Two cheap signals:
 *   1. `source === FileSources.azure_blob` — the producer's own claim.
 *   2. The `filepath` parses as a URL and `isAzureBlobUrl` recognises it.
 * Either is sufficient; neither alone is reliable (snapshots may omit
 * `source`, custom CNAMEs may not match the host whitelist).
 *
 * @param {Record<string, unknown>} attachment
 * @param {string} filepath
 * @returns {boolean}
 */
function looksLikeAzureAttachment(attachment, filepath) {
  if (attachment.source === FileSources.azure_blob) {
    return true;
  }
  try {
    return isAzureBlobUrl(new URL(filepath));
  } catch {
    return false;
  }
}

/**
 * Re-sign a single attachment's `filepath` in place if it is a near-expiry
 * Azure SAS URL. Non-Azure URLs and entries without a `filepath` are
 * left untouched. On error the original URL is retained so the client
 * still gets a diagnosable 403 instead of a `null` href.
 *
 * @param {Record<string, unknown> | null | undefined} attachment
 * @param {number} bufferSeconds
 * @param {Map<string, Promise<string | undefined>>} cache - per-call
 *   memoization keyed on the original `filepath` so repeated references
 *   to the same blob within one response only re-sign once.
 * @returns {Promise<void>}
 */
async function refreshAttachment(attachment, bufferSeconds, cache) {
  if (!attachment || typeof attachment !== 'object') {
    return;
  }
  const filepath = attachment.filepath;
  if (typeof filepath !== 'string' || filepath.length === 0) {
    return;
  }
  if (!looksLikeAzureAttachment(attachment, filepath)) {
    return;
  }
  let pending = cache.get(filepath);
  if (!pending) {
    // [knauf] KK20-199 — refresh diagnostics must not emit the SAS URL or
    // the Azure error object, both of which can contain signed/user paths.
    pending = (async () => {
      try {
        if (!needsRefreshAzure(filepath, bufferSeconds)) {
          return filepath;
        }
        const newUrl = await getNewAzureURL(filepath);
        if (!newUrl) {
          logger.debug('[refreshMessageAttachments] Azure URL refresh unavailable', {
            operation: 'azure_attachment_refresh',
          });
          return filepath;
        }
        return newUrl;
      } catch (_error) {
        logger.error('[refreshMessageAttachments] Azure URL refresh failed', {
          operation: 'azure_attachment_refresh',
        });
        return filepath;
      }
    })();
    // End [knauf]
    cache.set(filepath, pending);
  }
  const resolved = await pending;
  if (resolved && resolved !== filepath) {
    attachment.filepath = resolved;
  }
}

/**
 * Walk one or more messages and refresh Azure SAS URLs embedded in their
 * `attachments[]` and `files[]` snapshots, in place. Safe to call with
 * `null`, `undefined`, `[]`, a single message, or an array. Returns the
 * same shape it was given so callers can drop it in front of `res.json`
 * without restructuring.
 *
 * @template {Record<string, unknown>} TMessage
 * @param {TMessage | TMessage[] | null | undefined} messages
 * @param {{ bufferSeconds?: number }} [options]
 * @returns {Promise<TMessage | TMessage[] | null | undefined>}
 */
async function refreshMessageAttachmentUrls(messages, options = {}) {
  if (messages == null) {
    return messages;
  }
  const bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
  const list = Array.isArray(messages) ? messages : [messages];
  if (list.length === 0) {
    return messages;
  }
  const cache = new Map();
  const tasks = [];
  for (const message of list) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    for (const field of ['attachments', 'files']) {
      const entries = /** @type {unknown} */ (message[field]);
      if (!Array.isArray(entries) || entries.length === 0) {
        continue;
      }
      for (const entry of entries) {
        tasks.push(refreshAttachment(entry, bufferSeconds, cache));
      }
    }
  }
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
  return messages;
}

module.exports = {
  refreshMessageAttachmentUrls,
  refreshAttachment,
  DEFAULT_BUFFER_SECONDS,
};

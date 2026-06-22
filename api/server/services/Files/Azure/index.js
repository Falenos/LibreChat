const crud = require('./crud');
const images = require('./images');
// [knauf] KK20-182 — re-export the message-attachment SAS refresh shim
// (see `knauf/docs/reference/azure-blob-storage.md` §7.1).
const refreshMessageAttachments = require('./refreshMessageAttachments');
// End [knauf]

module.exports = {
  ...crud,
  ...images,
  // [knauf] KK20-182
  ...refreshMessageAttachments,
  // End [knauf]
};

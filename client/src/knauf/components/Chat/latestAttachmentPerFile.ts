import type { TAttachment, TFile } from 'librechat-data-provider';

/**
 * [knauf] KK20-397 — one card per generated file.
 *
 * Every code run that writes a file attaches it to its own tool call, and `processCodeOutput`
 * reuses the file record when a later run writes the same name (`claimCodeFile`). So when a
 * document skill builds a file, checks it and rebuilds it, the message carries two or three
 * attachments with the same `file_id`, and the hoisted tool-call group showed two identical
 * cards that both download the final version.
 *
 * Keeps the last attachment for each `file_id`, in the position of that last occurrence: the
 * last one carries the newest status (a deferred Office preview resolves on it). Attachments
 * without a `file_id` are left alone.
 */
export function latestAttachmentPerFile(attachments: TAttachment[]): TAttachment[] {
  const lastIndex = new Map<string, number>();
  attachments.forEach((attachment, index) => {
    const fileId = (attachment as Partial<TFile>).file_id;
    if (fileId) {
      lastIndex.set(fileId, index);
    }
  });
  if (lastIndex.size === attachments.length) {
    return attachments;
  }
  return attachments.filter((attachment, index) => {
    const fileId = (attachment as Partial<TFile>).file_id;
    return !fileId || lastIndex.get(fileId) === index;
  });
}

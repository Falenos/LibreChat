# Generated Artifact Revision History

KK20-410 applies to generated `:::artifact` directives stored in chat messages. It does not change tool/file-backed artifacts, which use blob storage, `File` records, message attachments, and `sourceFileId`.

## Identity and numbering

- A generated artifact lineage is identified by `(messageId, identifier)`.
- A revision is identified by `(messageId, identifier, version)`.
- Display titles are metadata and may change without changing lineage identity.
- Revision numbers are assigned from persisted successful `edit_artifact` outputs. A model-authored `version` directive is not authoritative.
- The latest title comes from the current persisted directive. Historical titles come from persisted edit metadata when available.

## Storage and reconstruction

- The latest source remains in the original assistant message.
- Each successful edit stores compact inverse patches plus base/content SHA-256 hashes in its tool output.
- The history endpoint returns lightweight version, title, type, language, and availability metadata. It validates continuity between persisted hashes and does not reconstruct every source snapshot.
- The exact revision endpoint reconstructs only the selected version and validates every applied inverse patch and hash before returning source.
- Missing or inconsistent history never substitutes the latest source under an older version number.

## Client behavior

- Preview stores lightweight lineage metadata and caches exact snapshots only after they are opened.
- One global request generation controls Preview selection. A later click on any artifact or version supersedes every earlier in-flight selection.
- Historical timestamps are anchored so the latest source remains the newest entry in global artifact ordering.
- During a rolling deployment, the legacy exact endpoint is used only when the history request itself returns 404. Failures from an exact snapshot request remain visible.

## Persistence boundaries

Generated chat artifacts are message-backed. Tool/file-backed artifacts are blob-backed attachments and do not participate in this revision lineage. The two persistence models must not be merged or inferred from whether an artifact appears in the attachment sidebar.

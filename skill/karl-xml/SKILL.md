---
name: karl-xml
description: >-
  Inspect, read, interpret, translate, edit, manipulate, and export attached XML
  files in KARL. Use for .xml text extraction, localization, exact text-node
  replacement or deletion, and safe structure-preserving round trips.
---

# XML files

KARL has two request-scoped XML tools:

| Need                                                               | Tool             |
| ------------------------------------------------------------------ | ---------------- |
| Translate attached XML files to another locale                     | `translate_file` |
| Inspect text nodes, replace exact text, delete text, or export XML | `edit_xml`       |

## Read and interpret

Use `edit_xml` with `action: inspect`. Inspection returns bounded, paginated
element paths, read-only attributes, and text nodes with stable IDs. Continue
with `offset` or narrow with `query`; do not request an unbounded dump.

Explain what the XML contains from the inspected paths and text. Do not claim
schema semantics that are not present in the file or supplied documentation.

## Translate

Call `translate_file` once for all XML attachments in the current request.
Supply the target BCP-47 locale and the XML source locale. A queued response
includes a durable job ID; use `translation_status` for later status or
user-requested cancellation. The tool sends
only text-node content to Azure Translator and rebuilds the XML around it.
If `translate_file` is not available, say that deterministic translation is disabled;
do not simulate a file round trip.

Do not translate element names, namespace prefixes or URIs, attributes, IDs,
links, comments, processing instructions, or ordering.

## Manipulate

Use `action: replace_text` after the target is known:

- Use `replacements` for exact substring changes.
- Set `replace_all: true` only when every occurrence should change. Ambiguous
  matches otherwise fail without writing a file.
- Use `segment_edits` for whole-node replacement or deletion after inspection.
  Select one `filename`; segment IDs belong to one parsed file version.
- Empty segment-edit `text` deletes that text node's content.

The export is a new `_edited.xml`; the source attachment remains unchanged.
Tell the user what changed and link the returned file.

## Boundaries

Reject malformed XML, DTDs, and entity declarations. Preserve element names,
namespaces, attributes, comments, processing instructions, and document order.
CDATA is supported, except output containing `]]>` is rejected.

This version edits element text nodes only. It does not rename, add, remove, or
reorder elements or attributes, modify schemas, execute transformations, or
validate business rules. Require schema or consuming-system review after edits.

For details and the acceptance checklist, read:

```
read_file  skills/karl-xml/references/xml.md
```

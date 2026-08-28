---
name: karl-idml
description: >-
  Inspect, parse, translate, edit, manipulate, and export attached Adobe IDML
  files in KARL. Use for .idml text extraction, exact story-text changes,
  localization, deletion, replacement, or safe round-trip requests.
---

# IDML files

KARL has two request-scoped IDML tools:

| Need                                                                    | Tool             |
| ----------------------------------------------------------------------- | ---------------- |
| Translate attached IDML files to another locale                         | `translate_file` |
| Inspect text, replace exact text, delete text, or export an edited IDML | `edit_idml`      |

## Translation

Call `translate_file` once for the IDML files the user requested. Supply their
exact `filenames` when multiple files are available; use `all_files: true` only
for an explicit translate-all request. Also supply the user's target BCP-47 locale
and the IDML source locale. A queued response includes a durable job ID; use
`translation_status` for later status or user-requested cancellation. Do not manually
translate segment-by-segment when the deterministic file translator is available.
If `translate_file` is not available, say that deterministic translation is disabled;
do not simulate a file round trip.

## Manipulation

Use `edit_idml` with `action: inspect` when the requested source text or segment
is uncertain. Inspection is paginated; continue with `offset` or narrow results
with `query` instead of requesting an unbounded dump.

Use `action: replace_text` after the target is known:

- Use `replacements` for exact substring changes.
- Set `replace_all: true` only when every occurrence should change. Ambiguous
  matches otherwise fail without modifying a file.
- Use `segment_edits` for whole-segment replacement or deletion after inspection.
  Select exactly one `filename`; segment IDs belong to one parsed file version.
- An empty segment-edit `text` deletes that segment's visible story text.

The exported file is a new `_edited.idml`; the source attachment remains
unchanged. Tell the user which edits were applied and link the returned file.

## Boundaries

Only story text is manipulated. Styles, swatches, links, images, text frames,
geometry, and package metadata are not prompt-editable in this version. Non-story
package entries remain byte-identical.

Translation or edited text can become longer or shorter. Final layout, overset
text, fonts, and visual acceptance require a human check in Adobe InDesign.

For package details and the acceptance checklist, read:

```
read_file  skills/karl-idml/references/idml.md
```

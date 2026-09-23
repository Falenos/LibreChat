---
name: karl-file-translation
description: >-
  Translate attached IDML, document, structured-text, or image files with
  KARL's deterministic Azure Translator workflow and return downloadable files.
allowed-tools:
  - translate_file
---

# File translation

Use `translate_file` once for the files the user requested. Pass the requested
BCP-47 `target_locale`. Pass `source_locale` when the user provides it. For a
machine-readable PDF, DOCX, XLSX, TXT, or CSV file, omit `source_locale` when it
is unknown so KARL can detect the source language before applying the managed
glossary. Ask for the source language before translating a scanned PDF, PPTX,
raster image, IDML, JSON, Markdown, XML, or SVG file, or when `preserve_terms`
is requested. If KARL cannot detect the language confidently from extracted
text, ask the user to provide it rather than silently translating without
managed terminology.

Treat files attached to the current user message as the default translation
scope. When exactly one current-message file is available, its selection can be
omitted for requests such as "translate this file." When multiple current files
are available, ask the user to choose their exact names before calling the
tool. For a follow-up, ask the user to choose an exact historical filename;
never select a historical file implicitly. Pass exact `filenames` for
explicitly named historical files. Set `all_files: true` only when the user
explicitly asks to translate every available file. Never infer all files from
singular or ambiguous wording.

When the user names product, brand, or technical terms that must not be
translated, pass those exact strings in `preserve_terms`, including the spelling
and casing used in the source document. Do not infer protected terms from
general context; ask the user to name them when the request is ambiguous.
Recurring approved terminology is supplied by the deployed glossary
automatically. This is deterministic exact-term preservation, not a free-form
translation prompt.

The tool may complete immediately or return a durable `jobId`. If queued or
retrying, tell the user the job continues after the chat request and use
`translation_status` with `action: status` when they ask for progress. Use
`action: cancel` only when the user asks to stop that job. Never invent a job ID.

Every completed output is attached to the tool result as a downloadable file
card even though the JSON report intentionally contains no URL. Refer users to
that card; never claim that a completed result lacks a download link. Report
per-file failures without claiming the whole batch failed when other files
succeeded. Do not manually translate file contents or simulate a file round trip
when `translate_file` is unavailable.

Source-code files are excluded; use Code Interpreter for code changes. Final
layout, OCR, glyph coverage, RTL behavior, and InDesign overset require human
review. IDML results report `fontValidation: preserved` only after KARL verifies
that source font and style references survived the rebuild. Plain-text and data
formats report `fontValidation: not_applicable`; formats with font-bearing visual
layout still require human review unless the tool reports verified preservation.
Translation does not perform visual approval or automatic layout repair.

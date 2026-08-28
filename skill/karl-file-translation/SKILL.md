---
name: karl-file-translation
description: >-
  Translate attached IDML, document, structured-text, or image files with
  KARL's deterministic Azure Translator workflow and return downloadable files.
---

# File translation

Use `translate_file` once for the files the user requested. Pass the requested
BCP-47 `target_locale` and `source_locale`. Ask for the source language when the
user did not provide it; do not guess or rely on auto-detection.

When multiple files are available, pass their exact names in `filenames`. Set
`all_files: true` only when the user explicitly asks to translate every file.
Never infer all files from singular or ambiguous wording. When exactly one file
is available, the selection can be omitted.

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
layout, OCR, fonts, glyphs, RTL behavior, and InDesign overset require human
review. Translation does not perform visual approval or automatic layout repair.

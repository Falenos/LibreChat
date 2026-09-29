# Translation quality and fidelity contract

**Ticket:** KK20-375
**Umbrella:** KK20-373
**Contract version:** 1

This contract fixes the supported translation routes and result vocabulary before the
format-specific implementation subtasks begin. The executable routing catalog is
`api/server/services/Files/knauf/translation/contracts.js`; benchmark evidence is produced by
`api/server/services/Files/knauf/translation/benchmarks/`.

## Routing decision

| Family          | Formats                  | Translation path                                                                       | Boundary | Fidelity guarantee                                                                                                                                                                                     |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Office          | DOCX, PPTX, XLSX         | Azure native document translation; synchronous at or below 10 MB, otherwise Blob batch | 40 MB    | Preserve the native output type. Package assets, relationships, styles, themes, fonts, geometry, and overflow are measured; unresolved visual findings require review.                                 |
| PDF             | PDF                      | Azure Blob batch document translation, followed by bounded optional recompression      | 40 MB    | Preserve PDF output, page count, and page geometry where supported. Font substitution, text expansion, accessibility metadata, forms, signatures, and visual flow require explicit findings or review. |
| Raster image    | PNG, JPEG, WebP          | Azure Blob batch image OCR with protected-logo masking/restoration                     | 5 MB     | Preserve output format and image geometry; OCR confidence, text placement, and protected assets require explicit findings or review.                                                                   |
| IDML            | IDML                     | Extract translatable story `Content`, translate segments, rebuild the package          | 25 MB    | Non-story package entries remain byte-identical and font/style manifests must match. InDesign rendering, glyph coverage, overflow, and layout remain review gates.                                     |
| Structured text | JSON, Markdown, XML, SVG | Extract translatable text and reconstruct the source structure                         | 25 MB    | Preserve protected syntax and structure. Rendered Markdown/SVG layout remains a review gate.                                                                                                           |
| Plain text      | CSV, TXT                 | Azure native document translation                                                      | 40 MB    | Preserve provider-supported output type; font and layout validation are not applicable.                                                                                                                |

A native document is promoted from synchronous to batch translation when it exceeds 10 MB or when
the applicable glossary exceeds the synchronous provider limit. PDF and raster images are always
batch routes. Executable source files remain explicitly unsupported.

## Shared result contract

Quality reporting is additive: a check that has not run must say `not_evaluated`; it must never be
reported as passed. Later implementation subtasks populate this shape:

```json
{
  "contractVersion": 1,
  "format": {
    "extension": "docx",
    "family": "office",
    "strategy": "azure_native_document"
  },
  "linguistic": {
    "status": "not_evaluated",
    "findings": [],
    "confidence": null
  },
  "fidelity": {
    "layoutValidation": "human_required",
    "fontValidation": "human_required",
    "assetValidation": "not_evaluated",
    "overflowValidation": "not_evaluated",
    "sizeValidation": "not_evaluated"
  },
  "humanReview": {
    "required": true,
    "reasons": ["layout", "overflow", "font_glyphs"]
  }
}
```

Allowed validation states are `passed`, `failed`, `warning`, `human_required`, `not_applicable`,
and `not_evaluated`. Findings contain a stable code, severity, bounded location, and redacted
evidence. Confidence is either `null` or a number from 0 through 1. Automated success cannot clear a
format's mandatory human-review reasons.

## Failure and review outcomes

Provider/runtime failures keep the existing stable codes, including `unsupported_format`,
`invalid_size`, `translator_rejected`, `translation_transport_failed`, and
`protected_term_not_preserved`. Benchmark comparison adds `format_changed`,
`output_size_exceeded`, `package_entry_missing`, `protected_package_entry_changed`,
`pdf_page_count_changed`, `pdf_page_geometry_changed`, and `image_geometry_changed`.

Unsupported encrypted or malformed inputs fail closed. A validation failure is not converted into a
successful translation; warning and human-review outcomes may return an output only when the report
states the unresolved condition explicitly.

## Linguistic controls

The pipeline order is:

1. normalize source and target BCP-47 locales;
2. resolve the approved immutable glossary revision and exact protected terms;
3. route the file and translate it;
4. run terminology, missing/untranslated/duplicated/hallucinated-text, locale, and RTL checks;
5. run format fidelity and output-size checks;
6. decide pass, fail, warning, or human review.

KK20-395 defines the detailed linguistic rules and thresholds. Translation memory is an optional
future input at step 2; it cannot bypass approved terminology, locale validation, or protected-term
checks.

## Security, rollout, and rollback

- Files remain owner- and tenant-scoped; scratch storage is private and SAS URLs are short-lived.
- Reports and logs must not contain source text, glossary terms, credentials, signed URLs, user IDs,
  tenant IDs, or filenames in metric labels.
- `KNAUF_FILE_TRANSLATION_ENABLED` stops new API acceptance. The worker flag remains separate so
  accepted jobs can drain during rollback.
- `KNAUF_FILE_TRANSLATION_WORKER_ENABLED` is disabled only after the queue drains or jobs are
  explicitly cancelled.
- Format-specific validation is introduced additively behind the existing translation capability;
  rollback restores the prior application image and does not reinterpret historical reports.
- Live-provider, linguistic, visual, and native-application evidence remains an environment release
  gate and is never replaced by repository fixtures.

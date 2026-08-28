# File translation functional spike — KK20-297

> Historical spike record. The durable production design and current release checklist are in [`file-translation-production-plan.md`](./file-translation-production-plan.md).

**Status:** Implemented and locally verified; human InDesign/layout acceptance pending

**Runtime provider:** Azure AI Translator

**Scope:** IDML plus the document, structured-text, and image formats listed below

## Decision

Use one deterministic `translate_file` tool. The tool is available only when the current message has a supported attachment. Users request any Azure-supported BCP-47 target locale; provider and storage details are not model-selectable.

The earlier Karl Model Router comparison showed better freedom for marketing tone but materially higher latency and nondeterministic batch output. Azure is the production spike path for repeatability, throughput, native document support, and predictable cost. The model remains responsible only for deciding when the user's request requires translation and calling the bounded tool.

## Supported routes

| Route                                     | Formats                                            | Limits and preservation                                                                  |
| ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Synchronous Azure document translation    | DOCX, PPTX, XLSX, CSV, TXT up to 10 MB             | Azure returns the same native format                                                     |
| Asynchronous Azure Blob batch translation | PDF, PNG, JPEG, WebP; native documents above 10 MB | 40 MB per document, 5 MB per image; private short-lived SAS URLs and scratch cleanup     |
| IDML adapter                              | IDML                                               | 25 MB; translates story `Content` nodes, rebuilds the package, verifies non-story hashes |
| Structured-text adapters                  | JSON, Markdown, XML, SVG                           | 25 MB; structure-aware text replacement                                                   |

HTML, CSS, JavaScript/JSX, TypeScript/TSX, Python, and other source files are uploadable for sandbox inspection and prompt-driven modification. They are intentionally excluded from deterministic whole-file translation: translating raw source can corrupt identifiers, syntax, templates, and executable behavior.

One call accepts all supported attachments from the current message. Processing concurrency is three. Successful files are returned even when another attachment fails; each failure has a stable per-file result.

## Dependencies

No new application package.

- Node.js `fetch`, `FormData`, `Blob`, `AbortSignal`, `Intl.Locale`, crypto, and streams.
- Existing `jszip`, `@xmldom/xmldom`, `xlsx`, and streamed ZIP-safety code.
- Existing `@azure/storage-blob` for batch source/target blobs and SAS generation.
- Existing Karl file storage strategies and File model for authenticated reads and private outputs.

Required runtime configuration:

```dotenv
AZURE_TRANSLATOR_ENDPOINT=https://<translator>.cognitiveservices.azure.com
AZURE_TRANSLATOR_KEY=<secret>
AZURE_TRANSLATOR_REGION=westeurope
AZURE_STORAGE_CONNECTION_STRING=<existing environment storage account>
KNAUF_FILE_TRANSLATION_ENABLED=false
```

Terraform owns the Translator resource, private endpoint/DNS, Key Vault secrets, private `translation-source` / `translation-target` containers, and one-day scratch lifecycle. GitOps maps the three Translator secrets into the application and keeps the rollout switch disabled until environment readiness is confirmed. The existing storage connection signs batch scratch URLs.

## Runtime flow

1. User uploads one or more supported files and requests a target locale.
2. Upload validation infers missing MIME types and keeps IDML as a binary attachment instead of sending it to RAG.
3. Agent loading injects `translate_file` for this request only; saved agent configuration is unchanged.
4. The tool resolves only current-message file IDs owned by the authenticated user and tenant.
5. Each file is size-checked, routed by format, translated, and validated.
6. Output is persisted through Karl's configured private file strategy.
7. Legacy and Responses API streams emit each saved output as a downloadable attachment.
8. The result reports per-file status and `layoutValidation: human_required`.

## Trust-boundary and edge cases

### Common

- Reject missing, stale, foreign-tenant, empty, unsupported, oversized, or duplicate attachment references.
- Normalize and validate BCP-47 locales; reject identical source and target locales.
- Never log file contents, API keys, provider bodies, glossary terms, or signed URLs.
- Propagate cancellation; bound request, polling, file, segment, and output sizes.
- Sanitize output names and preserve the original extension.
- Fail if provider output is empty, mismatched, or cannot be persisted.
- Keep scratch containers private. SAS grants only per-blob read or create/write permission for 30 minutes. Blobs are deleted after success or confirmed cancellation; uncertain jobs are left for the one-day storage lifecycle.
- No automatic layout claim. PDF/image OCR, fonts, glyphs, page flow, tables, and text expansion require human review.

### IDML

- Require a valid ZIP with the first uncompressed `mimetype` entry, safe paths, unique case-insensitive entries, valid `designmap.xml`, and bounded story XML.
- Reject DTDs/entities, malformed XML, ZIP bombs, CRC failures, traversal, and excessive expanded size.
- Translate nonblank story `Content` leaves; skip numeric-only, URL-only, and email-only text.
- Preserve XML escaping and outer whitespace.
- Require exact, unique, nonblank segment IDs from Azure XLIFF.
- Rebuild with `mimetype` first/uncompressed and verify every non-story entry hash.

### JSON, Markdown, and SVG

- JSON: translate string values only. Preserve keys, nesting, number/boolean/null values, indentation, and trailing newline.
- Markdown: protect fenced code, inline code, and URLs. Reject invalid placeholder reconstruction.
- SVG: reject DTDs/entities; translate visible `text` and `tspan` content only; preserve markup and attributes.

### Native documents, PDF, and images

- Use synchronous translation only for provider-supported native files within 10 MB.
- Route PDF/images and larger native documents through Azure batch translation.
- Poll batch status for at most 10 minutes and surface provider failures without exposing response bodies.
- PDF/image translation may use OCR and can alter visual placement. Human acceptance is mandatory.

## Verification

Automated checks cover:

- IDML parse/rebuild, XML safety, stable segments, and non-story fidelity.
- Azure synchronous/batch provider contracts and locale validation.
- JSON key/format preservation, Markdown protection, SVG visible-text selection, and unsafe XML rejection.
- Multiple attachments, bounded concurrency, partial success, private persistence, and cleanup.
- Request-scoped tool injection for representative supported formats.
- IDML MIME inference, picker/server allow-lists, and binary non-RAG upload routing.
- Download attachment projection in legacy and Responses streams.
- Seam checks, package build, formatting, and focused backend/client suites.

Eight supplied IDML fixtures passed identity round-trip. Their extracted segment counts were 61, 49, 65, 61, 62, 69, 78, and 183. A live Azure English-to-German smoke completed successfully. Local backend/frontend and config endpoints returned HTTP 200.

## Human acceptance

Open at least three representative outputs in Adobe InDesign: low text density, tables/multi-column, and the longest fixture. Record locale, reviewer, InDesign version, repair warning, page count, missing/untranslated text, overset/clipping, font/glyph/RTL issues, terminology, fluency score, and manual repair minutes.

The spike is accepted when outputs reopen without repair warnings, source assets/styles remain intact, and Marketing documents any required layout correction. Automated layout validation is intentionally out of scope.

## Deferred

- Queue/background job UX beyond the current bounded chat operation.
- Translation memory or multi-locale campaign orchestration.
- Automated frame resizing, overset detection, render previews, or InDesign Server.
- Cross-style-run sentence grouping if human review shows unacceptable fragmentation.

## Provider references

- [Adobe IDML Cookbook](https://developer.adobe.com/indesign/idml/)
- [Azure synchronous document translation](https://learn.microsoft.com/azure/ai-services/translator/document-translation/latest/rest-api/translate-synchronous)
- [Azure asynchronous document translation](https://learn.microsoft.com/azure/ai-services/translator/document-translation/latest/rest-api/translate-asynchronous)
- [Azure batch translation request](https://learn.microsoft.com/azure/ai-services/translator/document-translation/reference/start-batch-translation)

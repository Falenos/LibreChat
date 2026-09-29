# Translation quality and fidelity benchmarks

**Ticket:** KK20-374
**Umbrella:** KK20-373

**Status:** Azure AI Translator is the only translation provider we have credentials/access for.
The Google reference path has been split out into **KK20-396** (blocked, pending GCP project and
API credential provisioning) and is no longer part of this ticket's scope. KK20-374's remaining
"Done when" work is: approved linguistic reference sign-off, and reproducible Azure baseline
outputs/comparisons — the latter is now implemented (see "Running the Azure baseline" below).

The benchmark foundation lives in
`api/server/services/Files/knauf/translation/benchmarks/`. It provides:

- generated DOCX, PPTX, XLSX, PDF, PNG, JPEG, WebP, and IDML fixtures;
- German and Arabic cases with approved-reference placeholders and protected Knauf terms;
- deterministic source manifests for package entries, fonts, styles, relationships, assets,
  content runs, PDF page geometry/text/fonts, image geometry, and source/output size;
- structural comparison results with stable failure codes, including a hard failure when
  translatable content is missing/empty and a warning when font declarations are lost or
  substituted;
- an Azure baseline runner (`providerBaseline.js`) that translates DOCX/PPTX/XLSX/PDF fixtures via
  the same synchronous/batch routes used by production and IDML fixtures via segment-based
  translation, then builds and compares the resulting output manifest and approved reference text.

Fixtures are generated during tests instead of storing opaque binary files in Git. This keeps them
reviewable and reproducible while allowing later subtasks to extend the same builders with overflow,
fallback-font, OCR-confidence, and locale-specific cases.

Run the focused suite:

```bash
cd api
npm test -- --runInBand server/services/Files/knauf/translation/benchmarks/manifest.spec.js server/services/Files/knauf/translation/benchmarks/providerBaseline.spec.js
```

The automated suite does not call Azure. `providerBaseline.spec.js` mocks Azure's HTTP layer (same
pattern as `providers/azure.spec.js`) while exercising the real dispatch/manifest/comparison logic.

## Running the Azure baseline

To run fixtures through real Azure AI Translator and persist comparable baseline evidence:

```bash
cd api
AZURE_TRANSLATOR_ENDPOINT=... AZURE_TRANSLATOR_KEY=... \
  npm run knauf:translation-azure-baseline
```

This writes JSON results (manifests + comparison codes only — no buffers, credentials, source
content, glossary terms, or signed URLs) to
`api/server/services/Files/knauf/translation/benchmarks/.baseline-output/`, which is gitignored and
must never be committed.

**Known gap:** PNG/JPEG/WebP fixtures are not yet covered — they require the batch OCR pipeline
(`translateBatchWithAzure`, which needs `AZURE_STORAGE_CONNECTION_STRING`). The runner records
these fixtures as unsupported and exits unsuccessfully, so a successful run cannot be mistaken for
complete coverage.

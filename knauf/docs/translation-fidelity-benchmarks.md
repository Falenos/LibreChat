# Translation quality and fidelity benchmarks

**Ticket:** KK20-374
**Umbrella:** KK20-373

**Status:** This PR delivers the deterministic fixture/manifest foundation only. KK20-374
acceptance additionally requires approved linguistic references, Azure and Google output
baselines, and reproducible automated quality/fidelity/size comparisons against those baselines.
None of that exists yet — the suite never calls a provider and the linguistic references remain
placeholders. Treat KK20-374 as still open until that provider-baseline evidence is added in a
follow-up.

The benchmark foundation lives in
`api/server/services/Files/knauf/translation/benchmarks/`. It provides:

- generated DOCX, PPTX, XLSX, PDF, PNG, JPEG, WebP, and IDML fixtures;
- German and Arabic cases with approved-reference placeholders and protected Knauf terms;
- deterministic source manifests for package entries, fonts, styles, relationships, assets,
  content runs, PDF page geometry/text/fonts, image geometry, and source/output size;
- structural comparison results with stable failure codes, including a hard failure when
  translatable content is missing/empty and a warning when font declarations are lost or
  substituted.

Fixtures are generated during tests instead of storing opaque binary files in Git. This keeps them
reviewable and reproducible while allowing later subtasks to extend the same builders with overflow,
fallback-font, OCR-confidence, and locale-specific cases.

Run the focused suite:

```bash
cd api
npm test -- --runInBand server/services/Files/knauf/translation/benchmarks/manifest.spec.js
```

The suite does not call Azure or Google. Provider runs should use these fixtures and persist their
output manifests as environment-specific evidence. Credentials, source content, glossary terms, and
signed URLs must not be written to test output or committed baseline files.

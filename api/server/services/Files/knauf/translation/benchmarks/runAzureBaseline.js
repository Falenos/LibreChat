#!/usr/bin/env node
// [knauf] KK20-374 — manual/CI entry point to run the translation-fidelity
// benchmark fixtures through real Azure AI Translator and persist comparable
// baseline evidence.
//
// This intentionally makes real network calls to Azure and is NOT part of
// the automated Jest suite (which never calls a provider, per
// knauf/docs/translation-fidelity-benchmarks.md). Run it manually or from a
// dedicated CI job that has AZURE_TRANSLATOR_ENDPOINT/AZURE_TRANSLATOR_KEY.
//
// Usage:
//   cd api
//   AZURE_TRANSLATOR_ENDPOINT=... AZURE_TRANSLATOR_KEY=... \
//     node server/services/Files/knauf/translation/benchmarks/runAzureBaseline.js
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { buildBenchmarkFixtures } = require('./fixtures');
const { buildBenchmarkManifest } = require('./manifest');
const {
  UNSUPPORTED_BASELINE_EXTENSIONS,
  runAzureBaselineForFixture,
} = require('./providerBaseline');

const OUTPUT_DIR = path.join(__dirname, '.baseline-output');

function extensionFor(filename) {
  return (filename?.split('.').pop() ?? '').toLowerCase();
}

function assertAzureConfigured() {
  if (!process.env.AZURE_TRANSLATOR_ENDPOINT || !process.env.AZURE_TRANSLATOR_KEY) {
    console.error(
      'AZURE_TRANSLATOR_ENDPOINT and AZURE_TRANSLATOR_KEY must be set to run the Azure baseline. ' +
        'Aborting rather than silently skipping.',
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main() {
  if (!assertAzureConfigured()) return;

  const fixtures = await buildBenchmarkFixtures();
  const results = [];
  let hadFailure = false;

  for (const fixture of fixtures) {
    const extension = extensionFor(fixture.filename);
    if (UNSUPPORTED_BASELINE_EXTENSIONS.has(extension)) {
      hadFailure = true;
      results.push({
        id: fixture.id,
        provider: 'azure',
        status: 'unsupported',
        error: 'Azure batch OCR/image baseline is not implemented for this fixture',
      });
      console.log(
        `[unsupported] ${fixture.id}: image formats need the batch OCR pipeline (not yet implemented)`,
      );
      continue;
    }
    console.log(`[run]  ${fixture.id} (${fixture.sourceLocale} -> ${fixture.targetLocale})`);
    const sourceManifest = await buildBenchmarkManifest(fixture);
    try {
      const result = await runAzureBaselineForFixture({ fixture, sourceManifest });
      results.push(result);
      if (!result.comparison.passed) {
        hadFailure = true;
        console.error(`[fail] ${fixture.id}:`, JSON.stringify(result.comparison.failures));
      } else {
        console.log(`[pass] ${fixture.id} (sizeRatio=${result.comparison.sizeRatio.toFixed(2)})`);
      }
    } catch (error) {
      hadFailure = true;
      results.push({ id: fixture.id, provider: 'azure', error: error.message });
      console.error(`[error] ${fixture.id}:`, error.message);
    }
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `azure-baseline-${Date.now()}.json`);
  // Results contain only manifests/comparison codes — no buffers, credentials,
  // source content, or signed URLs — matching the documented persistence rule.
  await fs.writeFile(
    outputPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(`\nWrote baseline evidence to ${outputPath}`);

  if (hadFailure) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Azure baseline run failed:', error);
  process.exitCode = 1;
});

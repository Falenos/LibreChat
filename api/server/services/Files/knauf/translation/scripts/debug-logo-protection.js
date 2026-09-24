#!/usr/bin/env node
'use strict';

/**
 * Manual local sanity check for the Knauf logo-protection feature.
 * Not a test, not wired into CI/Jest — just a quick way to visually verify
 * detection (and, if you have a real translated image, restoration) against
 * a real screenshot before trusting the automated test suite alone.
 *
 * Usage:
 *   node scripts/debug-logo-protection.js --input /path/to/KARL-Evolution.png \
 *     [--translated /path/to/KARL-Evolution_es.png] [--out /path/to/out-dir]
 *
 * Produces in the output dir (defaults to alongside --input):
 *   <name>.detected.png   original image with a red box drawn around the detected region
 *   <name>.masked.png     original image with that region blanked (what Azure would receive)
 *   <name>.restored.png   only if --translated is given: the translated image with the
 *                         exact original logo pixels composited back in
 */

const path = require('path');
const sharp = require('sharp');
const {
  detectProtectedLogo,
  maskRegionForTranslation,
  restoreProtectedRegion,
} = require('../logoProtection');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function drawBox(imageBuffer, region, color = { r: 255, g: 0, b: 0, alpha: 1 }) {
  const thickness = Math.max(2, Math.round(Math.min(region.width, region.height) * 0.05));
  const overlays = [];
  const bar = async (w, h) =>
    sharp({ create: { width: Math.max(1, w), height: Math.max(1, h), channels: 4, background: color } })
      .png()
      .toBuffer();

  overlays.push({ input: await bar(region.width, thickness), left: region.x, top: region.y });
  overlays.push({
    input: await bar(region.width, thickness),
    left: region.x,
    top: region.y + region.height - thickness,
  });
  overlays.push({ input: await bar(thickness, region.height), left: region.x, top: region.y });
  overlays.push({
    input: await bar(thickness, region.height),
    left: region.x + region.width - thickness,
    top: region.y,
  });

  return sharp(imageBuffer).composite(overlays).png().toBuffer();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: node debug-logo-protection.js --input <image> [--translated <image>] [--out <dir>]');
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  const outDir = args.out ? path.resolve(args.out) : path.dirname(inputPath);
  const baseName = path.basename(inputPath, path.extname(inputPath));

  const original = await sharp(inputPath).toBuffer();
  console.log(`Loaded ${inputPath}`);

  console.time('detectProtectedLogo');
  const regions = await detectProtectedLogo(original);
  console.timeEnd('detectProtectedLogo');

  if (!regions.length) {
    console.log('No confident logo match found (nothing will be protected).');
    return;
  }
  console.log(`Detected ${regions.length} region(s):`, regions);

  let boxed = original;
  for (const region of regions) {
    boxed = await drawBox(boxed, region);
  }
  const detectedPath = path.join(outDir, `${baseName}.detected.png`);
  await sharp(boxed).toFile(detectedPath);
  console.log(`Wrote ${detectedPath} (inspect the red box placement)`);

  const masked = await maskRegionForTranslation(original, regions);
  const maskedPath = path.join(outDir, `${baseName}.masked.png`);
  await sharp(masked).toFile(maskedPath);
  console.log(`Wrote ${maskedPath} (this is what Azure would actually receive)`);

  if (args.translated) {
    const translatedPath = path.resolve(args.translated);
    const translated = await sharp(translatedPath).toBuffer();
    const restored = await restoreProtectedRegion(translated, original, regions);
    const restoredPath = path.join(outDir, `${baseName}.restored.png`);
    await sharp(restored).toFile(restoredPath);
    console.log(`Wrote ${restoredPath} (translated image with the original logo pixels restored)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

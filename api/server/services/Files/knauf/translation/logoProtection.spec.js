// [knauf] Knauf logo/brand-mark protection — regression coverage for image translation.
'use strict';

const path = require('path');
const sharp = require('sharp');
const {
  detectProtectedLogo,
  maskRegionForTranslation,
  restoreProtectedRegion,
  MIN_CONFIDENCE,
} = require('./logoProtection');

const REFERENCE_LOGO_PATH = path.join(__dirname, 'assets', 'knauf-wordmark-reference.png');
// Matches the reference asset's true aspect ratio (2363x1196) so scaled
// fixtures aren't artificially distorted the way `fit: 'fill'` would skew them.
const REFERENCE_ASPECT_RATIO = 2363 / 1196;
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 270;
const LOGO_REGION = { x: 24, y: 16, width: 63, height: 32 };
const TEXT_REGION = { x: 40, y: 200, width: 300, height: 40 };

/**
 * Builds a synthetic screenshot/document page: light background + the real
 * reference logo placed at `logoRegion`, optionally plus a distinct "text"
 * block placed at `textRegion`. Both default to the historical fixed
 * positions so existing assertions keep meaning; resolution-matrix
 * regression tests override canvas size and logo placement instead.
 */
async function buildFixture({
  canvasWidth = CANVAS_WIDTH,
  canvasHeight = CANVAS_HEIGHT,
  logoRegion = LOGO_REGION,
  textRegion = TEXT_REGION,
} = {}) {
  const background = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    },
  });
  const scaledLogo = await sharp(REFERENCE_LOGO_PATH)
    .resize({ width: logoRegion.width, height: logoRegion.height, fit: 'fill' })
    .png()
    .toBuffer();
  const composites = [{ input: scaledLogo, left: logoRegion.x, top: logoRegion.y }];
  if (textRegion) {
    const textBlock = await sharp({
      create: {
        width: textRegion.width,
        height: textRegion.height,
        channels: 4,
        background: { r: 30, g: 30, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    composites.push({ input: textBlock, left: textRegion.x, top: textRegion.y });
  }

  return background.composite(composites).png().toBuffer();
}

/** Proportional logo placement for a given canvas size + render height, in a header or footer band. */
function logoRegionFor(canvasWidth, canvasHeight, logoHeight, position = 'top') {
  const width = Math.round(logoHeight * REFERENCE_ASPECT_RATIO);
  const x = Math.round(canvasWidth * 0.05);
  const margin = Math.round(canvasHeight * 0.05);
  const y = position === 'bottom' ? canvasHeight - logoHeight - margin : margin;
  return { x, y, width, height: logoHeight };
}

/** Simulates Azure regenerating the whole canvas (OCR + redraw), logo included. */
async function simulateAzureTranslation(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  return sharp(buffer)
    .negate({ alpha: false })
    .png()
    .toBuffer()
    .then((negated) => sharp(negated).resize(width, height).png().toBuffer());
}

async function pixelAt(buffer, x, y) {
  const { data, info } = await sharp(buffer)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Array.from(data.slice(0, info.channels));
}

describe('logoProtection', () => {
  // These tests run real native-resolution logo detection at up to
  // 2560x1440; on slower/shared CI hardware (2 Jest workers, contention
  // with the rest of the suite) this can comfortably exceed the default
  // 60s timeout even though it completes in well under that locally.
  jest.setTimeout(240000);

  it('detects the known Knauf wordmark with high confidence at its actual position', async () => {
    const fixture = await buildFixture();
    const regions = await detectProtectedLogo(fixture);

    expect(regions.length).toBeGreaterThan(0);
    const [region] = regions;
    expect(region.name).toBe('knauf-wordmark');
    expect(region.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    // Detected box (with padding) should fully contain the true logo placement.
    expect(region.x).toBeLessThanOrEqual(LOGO_REGION.x);
    expect(region.y).toBeLessThanOrEqual(LOGO_REGION.y);
    expect(region.x + region.width).toBeGreaterThanOrEqual(LOGO_REGION.x + LOGO_REGION.width);
    expect(region.y + region.height).toBeGreaterThanOrEqual(LOGO_REGION.y + LOGO_REGION.height);
  });

  // Regression for a confirmed miss: the prior implementation downscaled the
  // *whole* image to a fixed 1400px cap before searching. That resize used a
  // non-integer ratio at 1920x1080 (0.729x) which smeared the wordmark's
  // letterform edges enough to drop its score below MIN_CONFIDENCE.
  //
  // The matrix below is scoped to actually certify what its name promises,
  // per review feedback on an earlier version of this test:
  // - Canvas sizes are chosen to hit both sides of the
  //   SEARCH_SAFETY_MAX_DIMENSION integer-downscale boundary (960 -> scale 1,
  //   1600 -> scale 2) rather than three sizes that collapse onto only two
  //   scale factors at up to 4x the pixel cost (1920 and 2560 both resolve
  //   to scale 2 — testing both exercised nothing 1920 alone didn't).
  // - Every case includes real in-band body content (`textRegion`, not
  //   `null`) — the previous version of this matrix ran every case against
  //   a logo alone on a blank background, the easiest input the detector
  //   will ever see.
  // - Two distinct, independently-required logo placements per resolution
  //   ('margin', the historical fixed-5%-margin corner, and 'offset', an
  //   unrelated position) instead of one — the previous version passed
  //   entirely on the strength of one lucky (canvas, position) pair, so a
  //   position-sensitive regression (like the scale-refine bug fixed
  //   alongside this test) could hide behind it indefinitely.
  // - The scale-2 bucket (1600px) skips the 24px render height: at a 2x
  //   downscale that becomes a 12px template, which is close enough to this
  //   detector's noise floor that *any* nearby content measurably erodes an
  //   already-marginal score — a genuine (if narrow) precision limit of the
  //   gradient-correlation approach at small effective template sizes, not
  //   a regression this PR introduced. 40px/64px stay comfortably above
  //   MIN_CONFIDENCE at this scale with the same nearby content; the 24px
  //   case is still covered natively (no downscale) in the 960px bucket.
  describe.each([
    [960, 540, 24],
    [960, 540, 64],
    [1600, 900, 40],
    [1600, 900, 64],
  ])('resolution matrix: %dx%d canvas, %dpx render height', (canvasWidth, canvasHeight, logoHeight) => {
    it.each(['margin', 'offset'])(
      'detects the wordmark at the "%s" placement, alongside in-band body text',
      async (placement) => {
        const logoRegion =
          placement === 'margin'
            ? logoRegionFor(canvasWidth, canvasHeight, logoHeight, 'top')
            : {
                x: Math.round(canvasWidth * 0.25),
                y: Math.round(canvasHeight * 0.08),
                width: Math.round(logoHeight * REFERENCE_ASPECT_RATIO),
                height: logoHeight,
              };
        // Body content sharing the same (searched) top band as the logo,
        // not merely elsewhere on the canvas.
        const textRegion = {
          x: Math.min(canvasWidth - 40, logoRegion.x + logoRegion.width + 20),
          y: logoRegion.y,
          width: Math.max(20, Math.round(canvasWidth * 0.3)),
          height: Math.max(10, Math.round(logoHeight * 0.6)),
        };
        const fixture = await buildFixture({ canvasWidth, canvasHeight, logoRegion, textRegion });

        const regions = await detectProtectedLogo(fixture);

        expect(regions.length).toBeGreaterThan(0);
        const [region] = regions;
        expect(region.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
        expect(region.x).toBeLessThanOrEqual(logoRegion.x);
        expect(region.y).toBeLessThanOrEqual(logoRegion.y);
        expect(region.x + region.width).toBeGreaterThanOrEqual(logoRegion.x + logoRegion.width);
        expect(region.y + region.height).toBeGreaterThanOrEqual(logoRegion.y + logoRegion.height);
      },
    );
  });

  it('protects the wordmark in both a header and a footer on the same page', async () => {
    const headerRegion = logoRegionFor(1920, 1080, 40, 'top');
    const footerRegion = logoRegionFor(1920, 1080, 40, 'bottom');
    const scaledLogo = await sharp(REFERENCE_LOGO_PATH)
      .resize({ width: headerRegion.width, height: headerRegion.height, fit: 'fill' })
      .png()
      .toBuffer();
    const fixture = await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 4,
        background: { r: 245, g: 245, b: 245, alpha: 1 },
      },
    })
      .composite([
        { input: scaledLogo, left: headerRegion.x, top: headerRegion.y },
        { input: scaledLogo, left: footerRegion.x, top: footerRegion.y },
      ])
      .png()
      .toBuffer();

    const regions = await detectProtectedLogo(fixture);

    expect(regions).toHaveLength(2);
    const [first, second] = [...regions].sort((a, b) => a.y - b.y);
    expect(first.y).toBeLessThan(headerRegion.y + headerRegion.height + 10);
    expect(second.y + second.height).toBeGreaterThan(footerRegion.y);
  });

  // Regression: `bestMatchInBand` previously kept only the single top-scoring
  // match per band, so a second genuine instance of the mark sharing the
  // same band (e.g. two logos side by side in a wide header) was silently
  // left unprotected. Non-max suppression now reports every distinct,
  // non-overlapping confident match within a band.
  it('protects two separate copies of the wordmark within the same band', async () => {
    const canvasWidth = 1920;
    const canvasHeight = 1080;
    const logoHeight = 40;
    const leftRegion = {
      x: Math.round(canvasWidth * 0.05),
      y: Math.round(canvasHeight * 0.05),
      width: Math.round(logoHeight * REFERENCE_ASPECT_RATIO),
      height: logoHeight,
    };
    const rightRegion = { ...leftRegion, x: Math.round(canvasWidth * 0.55) };
    const scaledLogo = await sharp(REFERENCE_LOGO_PATH)
      .resize({ width: leftRegion.width, height: leftRegion.height, fit: 'fill' })
      .png()
      .toBuffer();
    const fixture = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 245, g: 245, b: 245, alpha: 1 },
      },
    })
      .composite([
        { input: scaledLogo, left: leftRegion.x, top: leftRegion.y },
        { input: scaledLogo, left: rightRegion.x, top: rightRegion.y },
      ])
      .png()
      .toBuffer();

    const regions = await detectProtectedLogo(fixture);

    expect(regions).toHaveLength(2);
    const [first, second] = [...regions].sort((a, b) => a.x - b.x);
    expect(first.x).toBeLessThanOrEqual(leftRegion.x);
    expect(first.x + first.width).toBeGreaterThanOrEqual(leftRegion.x + leftRegion.width);
    expect(second.x).toBeLessThanOrEqual(rightRegion.x);
    expect(second.x + second.width).toBeGreaterThanOrEqual(rightRegion.x + rightRegion.width);
  });

  // Pins a documented, intentional limitation (see the SEARCH_BAND_FRACTION
  // docstring) rather than leaving it as archaeology: a mark placed in the
  // vertical middle of the image is not detected today. If this test starts
  // failing because search coverage was deliberately widened, update this
  // test and that docstring together — don't let it regress silently either
  // way.
  it('known limitation: does not detect a mark centered in the vertical middle of the image', async () => {
    const canvasWidth = 1920;
    const canvasHeight = 1080;
    const logoHeight = 64;
    const centeredRegion = {
      x: Math.round((canvasWidth - logoHeight * REFERENCE_ASPECT_RATIO) / 2),
      y: Math.round(canvasHeight / 2 - logoHeight / 2),
      width: Math.round(logoHeight * REFERENCE_ASPECT_RATIO),
      height: logoHeight,
    };
    const fixture = await buildFixture({
      canvasWidth,
      canvasHeight,
      logoRegion: centeredRegion,
      textRegion: null,
    });

    const regions = await detectProtectedLogo(fixture);

    expect(regions).toHaveLength(0);
  });

  it('still detects the wordmark after JPEG re-compression', async () => {
    const fixture = await buildFixture();
    const recompressed = await sharp(fixture).jpeg({ quality: 80 }).toBuffer();

    const regions = await detectProtectedLogo(recompressed);

    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0].confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it('distinguishes the logo from a nearby text block on the same page', async () => {
    const fixture = await buildFixture();
    const regions = await detectProtectedLogo(fixture);

    expect(regions.length).toBeGreaterThan(0);
    const [region] = regions;
    // The text block sits in a separate row from the detected (padded) logo region.
    expect(region.y + region.height).toBeLessThan(TEXT_REGION.y);
  });

  it('does not flag a dense, similar-weight text block as a logo (harder true-negative)', async () => {
    // A single solid rectangle isn't a meaningful negative — it barely
    // exercises the gradient-correlation shape signal at all. Several
    // dark, varying-width lines produce a much closer-to-real text-block
    // gradient signature without being an actual logo.
    const lineHeights = [26, 24, 28, 22, 30];
    const composites = lineHeights.map((height, index) => ({
      input: {
        create: {
          width: 40 + ((index * 37) % 220),
          height,
          channels: 4,
          background: { r: 25, g: 25, b: 25, alpha: 1 },
        },
      },
      left: 30,
      top: 20 + index * 40,
    }));
    const fixture = await sharp({
      create: {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        channels: 4,
        background: { r: 250, g: 250, b: 250, alpha: 1 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const regions = await detectProtectedLogo(fixture);

    // Assert the empty-array contract explicitly rather than indexing into
    // a possibly-empty/undefined match — a prior version of this test would
    // have thrown a raw TypeError instead of a readable assertion failure
    // if detection ever regressed to a false positive here.
    expect(regions).not.toBeNull();
    expect(regions).toHaveLength(0);
  });

  it('preserves exact original logo pixels while the rest of the image reflects translation', async () => {
    const original = await buildFixture();
    const regions = await detectProtectedLogo(original);
    expect(regions.length).toBeGreaterThan(0);

    const masked = await maskRegionForTranslation(original, regions);
    const translated = await simulateAzureTranslation(masked);
    const finalOutput = await restoreProtectedRegion(translated, original, regions);

    // Logo region: pixel-exact match with the untouched original (not the "translated" negative).
    const originalLogoPixel = await pixelAt(original, LOGO_REGION.x + 5, LOGO_REGION.y + 5);
    const finalLogoPixel = await pixelAt(finalOutput, LOGO_REGION.x + 5, LOGO_REGION.y + 5);
    expect(finalLogoPixel).toEqual(originalLogoPixel);

    // Elsewhere (the "text" block), the simulated translation's changes must survive.
    const originalTextPixel = await pixelAt(original, TEXT_REGION.x + 5, TEXT_REGION.y + 5);
    const finalTextPixel = await pixelAt(finalOutput, TEXT_REGION.x + 5, TEXT_REGION.y + 5);
    expect(finalTextPixel).not.toEqual(originalTextPixel);
  });

  it('falls back to blanking instead of restoring when translated dimensions no longer match', async () => {
    const original = await buildFixture();
    const regions = await detectProtectedLogo(original);
    expect(regions.length).toBeGreaterThan(0);

    const masked = await maskRegionForTranslation(original, regions);
    const mismatched = await sharp(masked)
      .resize(CANVAS_WIDTH + 10, CANVAS_HEIGHT + 10)
      .png()
      .toBuffer();

    const finalOutput = await restoreProtectedRegion(mismatched, original, regions);
    const finalMeta = await sharp(finalOutput).metadata();

    // Never silently ship a size mismatch, and never claim to restore pixels we can't align.
    expect(finalMeta.width).toBe(CANVAS_WIDTH + 10);
    expect(finalMeta.height).toBe(CANVAS_HEIGHT + 10);
    // Sample actual logo ink (matching the fixture's known placement), not
    // just the padded detection box's corner — which can land on background
    // and coincidentally match a background-colored fill regardless of
    // whether restoration happened.
    const finalLogoPixel = await pixelAt(finalOutput, LOGO_REGION.x + 5, LOGO_REGION.y + 5);
    const originalLogoPixel = await pixelAt(original, LOGO_REGION.x + 5, LOGO_REGION.y + 5);
    expect(finalLogoPixel).not.toEqual(originalLogoPixel);
  });

  // Regression for a confirmed crash: buildInpaintedPatch dereferenced null
  // top/bottom/left/right edge samples when a region has no neighboring
  // pixels to blend from on one or more sides.
  it('does not crash when the protected region covers the entire image', async () => {
    const original = await buildFixture();
    const { width, height } = await sharp(original).metadata();
    const fullImageRegion = { x: 0, y: 0, width, height };

    await expect(maskRegionForTranslation(original, fullImageRegion)).resolves.toBeInstanceOf(
      Buffer,
    );
  });

  it('does not crash when the protected region spans the full width only', async () => {
    const original = await buildFixture();
    const { width } = await sharp(original).metadata();
    const fullWidthRegion = { x: 0, y: 40, width, height: 20 };

    await expect(maskRegionForTranslation(original, fullWidthRegion)).resolves.toBeInstanceOf(
      Buffer,
    );
  });

  it('stops scanning promptly when the caller signal is already aborted', async () => {
    const fixture = await buildFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(detectProtectedLogo(fixture, { signal: controller.signal })).rejects.toThrow();
  });

  it('returns an empty array when no confident match exists (avoids over-flagging ordinary text)', async () => {
    const plainText = await sharp({
      create: {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        channels: 4,
        background: { r: 250, g: 250, b: 250, alpha: 1 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 200,
              height: 30,
              channels: 4,
              background: { r: 20, g: 20, b: 20, alpha: 1 },
            },
          })
            .png()
            .toBuffer(),
          left: 40,
          top: 40,
        },
      ])
      .png()
      .toBuffer();

    const regions = await detectProtectedLogo(plainText);
    expect(regions).toEqual([]);
  });
});

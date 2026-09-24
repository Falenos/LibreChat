'use strict';

/**
 * Protects known Knauf brand marks from being redrawn/regenerated during
 * image translation (KK20-334 follow-up: logo fidelity).
 *
 * Azure Translator's image-translation mode OCRs visible text and redraws it
 * in the target language; it has no concept of a "logo" and will happily
 * regenerate a stylized wordmark as plain typed text. Since we cannot change
 * that provider behavior, we detect known brand assets ourselves before
 * translation, mask the region so Azure never touches it, and paste the
 * *exact original pixels* back into the translated image afterwards. If a
 * detection cannot be trusted (low confidence, or the returned image
 * dimensions no longer line up), we fail toward omitting the mark rather
 * than risking a synthetic approximation, per the brand invariant.
 *
 * That "fail toward omission" choice has a concrete consequence worth
 * stating plainly: a mark that scores *below* MIN_CONFIDENCE is not masked
 * at all, and the image is still translated — it just ships with that mark
 * unprotected, the same as it would have before this module existed. This
 * is an intentional trade, not an oversight: the alternative (blocking or
 * degrading translation whenever confidence is merely uncertain) would let
 * an increasingly common false *miss* — busy backgrounds, unusual scans,
 * novel resolutions — turn a translation feature outage into "brand
 * protection working" only in the narrowest, easiest cases. We chose to
 * treat this module as a best-effort enhancement layered on top of
 * translation, never a gate on it: worst case without a confident match is
 * exactly today's status quo (an unprotected mark), not a broken or refused
 * translation.
 *
 * Known limitations, called out explicitly rather than left as archaeology:
 * - Detection only searches the top/bottom SEARCH_BAND_FRACTION of the
 *   image (see that constant) — a mark centered in the middle of an
 *   otherwise ordinary image (a title slide, a centered product shot with
 *   a watermark) will not be found. This is a deliberate compute/accuracy
 *   trade for the common letterhead/screenshot case, not an oversight; see
 *   computeSearchBands.
 * - This is synchronous, CPU-bound JS running on the main event loop. A
 *   worst-case (large, logo-free) image can cost roughly 1-2s of wall time
 *   and produce event-loop stalls of 100ms+, and a cancelled translation
 *   (`signal`) can only abort at the yield points inside the search loops,
 *   not instantly. Moving this to a worker thread would remove the event-
 *   loop-stall side effect entirely; that's a larger structural change than
 *   this module currently makes, and is worth revisiting if per-image cost
 *   becomes a production problem rather than a theoretical one.
 */

const path = require('path');
const sharp = require('sharp');
const { logger } = require('@librechat/data-schemas');

/** Brand assets eligible for detection/protection. Extend as new confirmed marks are added. */
const PROTECTED_LOGOS = [
  {
    name: 'knauf-wordmark',
    assetPath: path.join(__dirname, 'assets', 'knauf-wordmark-reference.png'),
  },
];

/** Normalized cross-correlation score (0-1-ish, can dip negative) required to trust a match. */
const MIN_CONFIDENCE = 0.85;
/**
 * Fraction of the image height searched from the top and (independently)
 * from the bottom. Brand marks live in letterheads/headers/footers, not the
 * body content area, so restricting the search to these two bands bounds
 * worst-case compute without the accuracy cost of a blanket downscale.
 *
 * A prior version of this module downscaled the *whole* image to a fixed
 * 1400px cap before searching. That resize used a non-integer ratio for the
 * most common screenshot size (1920x1080 -> 0.729x), which smears exactly
 * the fine letterform edges template matching keys on, and could push the
 * true logo's score below MIN_CONFIDENCE even though a human would spot it
 * immediately. Searching at native resolution (within a bounded band) fixes
 * that miss and, since the two bands together are usually smaller than the
 * whole image, also tends to be cheaper.
 *
 * Known limitation (kept deliberately, not an oversight): the middle
 * `1 - 2 * SEARCH_BAND_FRACTION` of every image (50% at the default 0.25) is
 * never searched. Verified: a mark centered vertically in an otherwise
 * ordinary 1920x1080 image is not detected. Marks *do* legitimately appear
 * outside the header/footer bands sometimes — a centered title slide, a
 * product shot with a watermark, a diagram with an inline logo — and those
 * currently ship to Azure unprotected. Searching the full image instead
 * would close that gap but roughly doubles worst-case compute on top of an
 * already CPU-bound synchronous scan (see the module header), which is the
 * more pressing concern today; this trade is intentionally kept in favor of
 * the (far more common) letterhead/screenshot case. See
 * `logoProtection.spec.js`'s "known limitation: does not search the middle
 * of the image" test, which pins this behavior so a future change to it is
 * a deliberate, reviewed decision rather than a silent regression either way.
 */
const SEARCH_BAND_FRACTION = 0.25;
/**
 * Bounds the largest dimension of a searched band. Ordinary full-width
 * screenshots/pages (1080p, 1440p, ...) routinely exceed this and *will*
 * be downscaled — this isn't just a pathological-input safety net, it's
 * the primary lever bounding worst-case compute now that search runs at
 * (otherwise) native resolution. Critically, this is only ever an
 * *integer* factor (1/2, 1/3, ...), never an arbitrary ratio: integer-
 * factor box downsampling maps a fixed, uniform number of source pixels to
 * each output pixel everywhere in the image, so it doesn't selectively
 * smear small features out of detectability the way an arbitrary-ratio
 * resize can (which is exactly what the old fixed 1400px cap did).
 */
const SEARCH_SAFETY_MAX_DIMENSION = 1280;
/** Candidate template heights (px) to try; covers common render/DPR scales. */
const CANDIDATE_HEIGHTS = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96];
/**
 * How many px above/below the best coarse-candidate height to re-check
 * during scale refinement. Gradient/edge correlation is scale-sensitive
 * enough that the true render height can fall between two coarse
 * candidates and still score far higher than either (e.g. 0.94 at the
 * exact height vs ~0.8 one px off) — this closes that gap cheaply, since
 * it only re-searches a small neighborhood, not the whole image.
 */
const SCALE_REFINE_RADIUS = 5;
/**
 * Hard cap on the position-refinement search radius (px), independent of
 * template size. Refine cost is O(radius^2 * templateArea); since both
 * factors grow with template size, an uncapped radius-proportional-to-size
 * makes the largest CANDIDATE_HEIGHTS entries (80, 96) cost far more than
 * the rest combined (empirically, a dominant share of total search time).
 * Below this cap the true position is already fully covered (see
 * coarseStride below); above it, a bounded 16px window is still generous
 * for the largest/least common candidate sizes.
 */
const MAX_REFINE_SEARCH_RADIUS = 16;
/**
 * Box-blur radius applied to a *copy* of the gradient maps used only for
 * the coarse localization pass (never for scoring/reporting confidence).
 * Gradient-magnitude correlation on thin wordmark strokes is sharply peaked
 * — empirically the score can fall from ~0.98 at the true position to
 * under 0.1 just 4-6px away — so a coarse grid stepped at a fraction of the
 * template size can straddle the peak entirely and find nothing to refine
 * from. Blurring widens that peak's basin of attraction enough for a coarse
 * stride to reliably land near it, without losing precision: the refine and
 * scale-refine passes immediately after still score candidates against the
 * original sharp gradient.
 */
const COARSE_SEARCH_BLUR_RADIUS = 3;
/** Extra margin (fraction of matched box) kept around a detection when masking/restoring. */
const REGION_PADDING = 0.08;
/** Border strip (px) sampled to pick a plausible fill color when masking a region. */
const BORDER_SAMPLE_PX = 6;

const referenceCache = new Map();

/**
 * Signals a cancelled translation without depending on any caller-specific
 * error class (this module has no knowledge of tool.js's IdmlError). Callers
 * that thread a `signal` through are expected to check `signal?.aborted`
 * themselves (as tool.js's translation pipeline already does at every other
 * step) rather than pattern-match on this error's identity.
 */
function abortError() {
  const err = new Error('Logo detection aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Cooperatively yields to the event loop and, if the caller's signal has
 * since been aborted, throws instead of continuing. Threaded through the
 * hottest loops (candidate heights, scale-refinement steps) so a long
 * detection run neither monopolizes the event loop for its full ~1-2s in a
 * single stretch nor keeps burning CPU after its request was cancelled —
 * see the module header's "known limitations" note.
 */
async function checkpoint(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
  await new Promise((resolve) => setImmediate(resolve));
  if (signal?.aborted) {
    throw abortError();
  }
}

/**
 * Splits the image into the top/bottom bands actually searched. Small images
 * (where the two bands would overlap or cover almost the whole image anyway)
 * collapse to a single full-image band — there's no compute to save by
 * splitting them, and it avoids scanning the same middle rows twice.
 */
function computeSearchBands(height) {
  const bandHeight = Math.max(1, Math.round(height * SEARCH_BAND_FRACTION));
  if (bandHeight * 2 >= height) {
    return [{ name: 'full', top: 0, height }];
  }
  return [
    { name: 'top', top: 0, height: bandHeight },
    { name: 'bottom', top: height - bandHeight, height: bandHeight },
  ];
}

/**
 * Loads a single band (full width, bounded height) of the source image as a
 * dense grayscale buffer, native resolution unless the band itself still
 * exceeds SEARCH_SAFETY_MAX_DIMENSION, in which case it's downscaled by an
 * integer factor (see constant doc above). Returns the factor used so
 * callers can map matched coordinates back to native pixels.
 */
async function loadGrayscaleBand(input, extractRegion) {
  let pipeline = sharp(input).extract(extractRegion).grayscale();
  const largestDimension = Math.max(extractRegion.width, extractRegion.height);
  const scale =
    largestDimension > SEARCH_SAFETY_MAX_DIMENSION
      ? Math.ceil(largestDimension / SEARCH_SAFETY_MAX_DIMENSION)
      : 1;
  if (scale > 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.floor(extractRegion.width / scale)),
      height: Math.max(1, Math.floor(extractRegion.height / scale)),
      fit: 'fill',
    });
  }
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, scale };
}

/**
 * 3x3 Sobel gradient magnitude over a dense grayscale buffer (edge-replicated
 * at the border). Matching on gradients rather than raw intensity makes
 * correlation invariant to the page's background color/brightness — the
 * Knauf wordmark is a near-flat single color, so raw-intensity correlation
 * (even masked to ink-only pixels) has almost no variance to key on and is
 * numerically unstable. Edges (letterform boundaries) are where the actual
 * shape signal lives, and are near-zero in flat background regions of both
 * the template and any real screenshot, regardless of what that background
 * color actually is.
 */
function sobelMagnitude(gray, width, height) {
  const out = new Float32Array(width * height);
  const at = (x, y) => {
    const cx = Math.min(Math.max(x, 0), width - 1);
    const cy = Math.min(Math.max(y, 0), height - 1);
    return gray[cy * width + cx];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gx =
        -at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1) +
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1);
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/**
 * Loads a reference logo at a given render height as a dense gradient-
 * magnitude map. The source PNG has a transparent background; `flatten`
 * alpha-composites it onto a neutral mid-gray so the whole rectangle becomes
 * opaque before conversion — the exact flatten color doesn't matter since a
 * uniform background has ~zero gradient either way.
 */
async function loadTemplateGradient(assetPath, height) {
  const { data, info } = await sharp(assetPath)
    .resize({ height })
    .flatten({ background: { r: 128, g: 128, b: 128 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width } = info;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    gray[i] = data[i];
  }
  return { width, height, gradient: sobelMagnitude(gray, width, height) };
}

async function referenceHeightVariant(logo, height) {
  const cacheKey = `${logo.assetPath}:${height}`;
  if (referenceCache.has(cacheKey)) {
    return referenceCache.get(cacheKey);
  }
  const template = await loadTemplateGradient(logo.assetPath, height);
  referenceCache.set(cacheKey, template);
  return template;
}

/**
 * Simple separable-in-effect (naive, but small-radius so cheap) box blur
 * over a dense Float32Array grid, edge-replicated at the border. Used only
 * to widen the coarse-search correlation peak (see COARSE_SEARCH_BLUR_RADIUS)
 * — never for the sharp refine/scoring passes.
 */
function boxBlur(gradient, width, height, radius) {
  if (radius <= 0) {
    return gradient;
  }
  const at = (x, y) => {
    const cx = Math.min(Math.max(x, 0), width - 1);
    const cy = Math.min(Math.max(y, 0), height - 1);
    return gradient[cy * width + cx];
  };
  const out = new Float32Array(width * height);
  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          sum += at(x + dx, y + dy);
        }
      }
      out[y * width + x] = sum / windowSize;
    }
  }
  return out;
}

/** Precompute mean-centered template gradient values over the full dense grid. */
function templateStats(template) {
  const { width, height, gradient } = template;
  const count = width * height;
  if (count === 0) {
    return null;
  }
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    sum += gradient[i];
  }
  const mean = sum / count;
  const centered = new Float32Array(count);
  let sumSq = 0;
  for (let i = 0; i < count; i += 1) {
    const v = gradient[i] - mean;
    centered[i] = v;
    sumSq += v * v;
  }
  return { width, height, count, centered, sumSq };
}

/**
 * Summed-area table (integral image) over a dense grid, padded with a
 * leading zero row/column so any rectangle's sum is a plain 4-lookup
 * subtraction — no per-query loop. Used to make the correlation window's
 * mean computation O(1) instead of O(template area); this is by far the
 * hottest inner loop during search (run for every candidate position at
 * every candidate scale), so this alone is a meaningful chunk of measured
 * search cost.
 */
function buildIntegralImage(source, width, height) {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const rowOut = (y + 1) * stride;
    const rowPrevOut = y * stride;
    for (let x = 0; x < width; x += 1) {
      rowSum += source[y * width + x];
      integral[rowOut + x + 1] = integral[rowPrevOut + x + 1] + rowSum;
    }
  }
  return integral;
}

function integralWindowSum(integral, stride, x0, y0, width, height) {
  const a = integral[y0 * stride + x0];
  const b = integral[y0 * stride + x0 + width];
  const c = integral[(y0 + height) * stride + x0];
  const d = integral[(y0 + height) * stride + x0 + width];
  return d - b - c + a;
}

/**
 * Normalized cross-correlation between the template's gradient magnitude map
 * and the corresponding same-size window of the source image's gradient map.
 * `integral` must be the summed-area table (see buildIntegralImage) of the
 * same `source`/`sourceWidth` being queried.
 */
function correlationAt(source, sourceWidth, x0, y0, stats, integral) {
  const { width, height, count, centered, sumSq: templateSumSq } = stats;
  const sum = integralWindowSum(integral, sourceWidth + 1, x0, y0, width, height);
  const mean = sum / count;
  let numerator = 0;
  let windowSumSq = 0;
  let i = 0;
  for (let ty = 0; ty < height; ty += 1) {
    const rowBase = (y0 + ty) * sourceWidth + x0;
    for (let tx = 0; tx < width; tx += 1) {
      const centeredValue = source[rowBase + tx] - mean;
      numerator += centeredValue * centered[i];
      windowSumSq += centeredValue * centeredValue;
      i += 1;
    }
  }
  const denominator = Math.sqrt(windowSumSq * templateSumSq);
  return denominator === 0 ? -1 : numerator / denominator;
}

/**
 * How many distinct non-overlapping candidate locations get carried into
 * the (comparatively expensive) scale-refinement pass per band, after
 * non-max suppression collapses the raw per-height candidates down to one
 * representative per physical location. Bounds worst-case compute for
 * pathological inputs while comfortably covering realistic cases — a
 * letterhead repeating the same mark more than a handful of times in one
 * band would be unusual. Picking only the single overall best coarse
 * candidate isn't safe even for a single-instance image: at an off-scale
 * height the true logo's score can be *lower* than a spurious match
 * elsewhere (busy toolbars/tables can coincidentally correlate reasonably
 * well with edge-gradient templates), so the global coarse winner is
 * sometimes the wrong location entirely — refining several distinct
 * candidates and letting the *refined* scores decide avoids locking onto
 * that wrong one.
 */
const MAX_MATCHES_PER_BAND = 6;

/**
 * Upper bound on how many distinct coarse-grid peaks are pursued into the
 * (expensive) refine/scale-refine passes for a single CANDIDATE_HEIGHTS
 * value. Without this, the coarse pass only ever surfaced its single global
 * best position per height, so two real instances of a mark rendered at the
 * *same* height could never both survive: only cross-height diversity (two
 * instances happening to win at different heights) let more than one
 * instance reach the candidate list at all, which silently broke as soon as
 * duplicate instances shared a render height. Collecting a bounded number
 * of non-overlapping local peaks per height (rather than one) fixes that
 * while keeping the added cost proportional to a small constant, not to the
 * full coarse grid.
 */
const MAX_LOCAL_PEAKS_PER_HEIGHT = 3;

/**
 * Collapses a list of candidate boxes down to one representative per
 * distinct location: sorts by score descending, then greedily keeps each
 * candidate only if its bounding box doesn't overlap one already kept.
 * Distinct real instances of a mark are placed with enough separation that
 * their boxes don't collide, while near-duplicate detections of the *same*
 * instance (e.g. the same physical logo winning at several adjacent
 * CANDIDATE_HEIGHTS, or shifting a few px after scale-refinement) do.
 */
function nonMaxSuppress(items) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const item of sorted) {
    const overlapsKept = kept.some(
      (k) =>
        !(
          item.x + item.width <= k.x ||
          k.x + k.width <= item.x ||
          item.y + item.height <= k.y ||
          k.y + k.height <= item.y
        ),
    );
    if (!overlapsKept) {
      kept.push(item);
    }
  }
  return kept;
}

/**
 * Re-checks a coarse candidate across a small neighborhood of scales AND
 * positions, since the coarse/refine passes only searched at the candidate's
 * initial (possibly off-scale) height. Deliberately re-evaluates
 * `candidate.height` itself here too, not just the +/-N neighborhood: the
 * position refine pass upstream ran with a radius derived from the coarse
 * *stride* (see refineRadius in searchLogoInGray), which can be smaller than
 * this pass's radius, so a position that improves once the search radius
 * widens can still land closer to the true peak at the very same height.
 * Skipping the own-height re-check risks permanently discarding a candidate
 * whose position simply hadn't been refined far enough yet — measured with
 * a real fixture, the gradient-correlation surface can drop from ~0.90 at
 * the true position to ~0.57 just a few px/scale-steps away, so an
 * under-refined near-miss reads as "no match" rather than "close".
 */
async function scaleRefineCandidate(
  sourceGradient,
  sourceWidth,
  sourceHeight,
  logo,
  candidate,
  sourceIntegral,
  signal,
) {
  let refinedBest = candidate;
  for (
    let h = candidate.height - SCALE_REFINE_RADIUS;
    h <= candidate.height + SCALE_REFINE_RADIUS;
    h += 1
  ) {
    await checkpoint(signal);
    if (h < 4 || h >= sourceHeight) {
      continue;
    }
    const template = await referenceHeightVariant(logo, h);
    if (template.width >= sourceWidth || template.height >= sourceHeight) {
      continue;
    }
    const stats = templateStats(template);
    if (!stats) {
      continue;
    }
    const searchRadius = Math.min(
      MAX_REFINE_SEARCH_RADIUS,
      Math.max(2, Math.floor(Math.min(template.width, template.height) / 4)),
    );
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
      const y = candidate.y + dy;
      if (y < 0 || y + template.height > sourceHeight) {
        continue;
      }
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        const x = candidate.x + dx;
        if (x < 0 || x + template.width > sourceWidth) {
          continue;
        }
        const score = correlationAt(sourceGradient, sourceWidth, x, y, stats, sourceIntegral);
        if (score > refinedBest.score) {
          refinedBest = { score, x, y, width: template.width, height: template.height };
        }
      }
    }
  }
  return refinedBest;
}

async function searchLogoInGray(sourceGradient, sourceWidth, sourceHeight, logo, signal) {
  // Computed once per call (not per candidate height) and reused — this is
  // only for coarse localization, see COARSE_SEARCH_BLUR_RADIUS.
  const blurredSourceGradient = boxBlur(
    sourceGradient,
    sourceWidth,
    sourceHeight,
    COARSE_SEARCH_BLUR_RADIUS,
  );
  // Summed-area tables, likewise computed once per call and reused across
  // every candidate height/position — see buildIntegralImage.
  const sourceIntegral = buildIntegralImage(sourceGradient, sourceWidth, sourceHeight);
  const blurredSourceIntegral = buildIntegralImage(blurredSourceGradient, sourceWidth, sourceHeight);
  const candidates = [];
  for (const height of CANDIDATE_HEIGHTS) {
    // Yields once per candidate height (the outermost, coarsest-grained
    // loop here) so a long detection run gives the event loop periodic
    // openings rather than blocking for its entire ~1-2s worst case in one
    // stretch, and so a cancelled translation's signal is actually observed
    // instead of only being checked after the whole scan finishes.
    await checkpoint(signal);
    if (height < 4 || height >= sourceHeight) {
      continue;
    }
    const template = await referenceHeightVariant(logo, height);
    if (template.width >= sourceWidth || template.height >= sourceHeight) {
      continue;
    }
    const stats = templateStats(template);
    if (!stats) {
      continue;
    }
    const blurredStats = templateStats({
      width: template.width,
      height: template.height,
      gradient: boxBlur(template.gradient, template.width, template.height, COARSE_SEARCH_BLUR_RADIUS),
    });
    if (!blurredStats) {
      continue;
    }

    // Coarse pass: run on the blurred gradients (wide, forgiving peak) so a
    // stride proportional to the template size still reliably lands near
    // the true position — on the sharp gradient this correlation surface
    // can be sharply peaked enough (score can roughly halve within 1-2px)
    // that an off-grid coarse sample sees no signal at all to key on.
    // Every scored grid position is kept (not just the running best) so
    // that distinct instances rendered at this same height — which would
    // otherwise all collapse onto whichever one happens to score highest —
    // can be pulled apart below via non-max suppression.
    const coarseStride = Math.max(1, Math.floor(Math.min(template.width, template.height) / 4));
    const coarseScores = [];
    for (let y = 0; y + template.height <= sourceHeight; y += coarseStride) {
      for (let x = 0; x + template.width <= sourceWidth; x += coarseStride) {
        const score = correlationAt(
          blurredSourceGradient,
          sourceWidth,
          x,
          y,
          blurredStats,
          blurredSourceIntegral,
        );
        coarseScores.push({ score, x, y, width: template.width, height: template.height });
      }
    }
    if (!coarseScores.length) {
      continue;
    }

    // Collapse the coarse grid down to a bounded number of distinct local
    // peaks — see MAX_LOCAL_PEAKS_PER_HEIGHT for why this must be more than
    // one.
    const coarsePeaks = nonMaxSuppress(coarseScores).slice(0, MAX_LOCAL_PEAKS_PER_HEIGHT);

    // Refine pass: pinpoint the exact position (stride 1) in a neighborhood
    // around each coarse peak, scored against the original sharp gradient —
    // the blur was only a localization aid, never the actual match score.
    // The neighborhood must cover the coarse grid's blind spot (±coarseStride)
    // but is capped so the largest candidate heights don't dominate runtime.
    const refineRadius = Math.min(coarseStride, MAX_REFINE_SEARCH_RADIUS);
    for (const coarsePeak of coarsePeaks) {
      let refined = {
        score: correlationAt(
          sourceGradient,
          sourceWidth,
          coarsePeak.x,
          coarsePeak.y,
          stats,
          sourceIntegral,
        ),
        x: coarsePeak.x,
        y: coarsePeak.y,
      };
      for (let dy = -refineRadius; dy <= refineRadius; dy += 1) {
        const y = coarsePeak.y + dy;
        if (y < 0 || y + template.height > sourceHeight) {
          continue;
        }
        for (let dx = -refineRadius; dx <= refineRadius; dx += 1) {
          const x = coarsePeak.x + dx;
          if (x < 0 || x + template.width > sourceWidth) {
            continue;
          }
          const score = correlationAt(sourceGradient, sourceWidth, x, y, stats, sourceIntegral);
          if (score > refined.score) {
            refined = { score, x, y };
          }
        }
      }

      candidates.push({
        score: refined.score,
        x: refined.x,
        y: refined.y,
        width: template.width,
        height: template.height,
      });
    }
  }

  if (!candidates.length) {
    return [];
  }

  // A single band can legitimately contain more than one instance of the
  // same mark (e.g. two copies side by side in a wide header, or a repeated
  // watermark) — collapsing straight to one "best" candidate here silently
  // leaves every instance but the highest-scoring one unprotected. Cluster
  // the per-height candidates by bounding-box overlap first: the *same*
  // physical instance is typically the coarse winner at several adjacent
  // CANDIDATE_HEIGHTS (not just one), so naively scale-refining the raw
  // top-N would mostly re-discover that one instance N times rather than
  // surfacing distinct ones. Non-max suppression collapses those near-
  // duplicates down to one representative box per distinct location before
  // any of the (comparatively expensive) scale-refinement work runs.
  candidates.sort((a, b) => b.score - a.score);
  const clusterRepresentatives = nonMaxSuppress(candidates).slice(0, MAX_MATCHES_PER_BAND);

  // Scale-refinement pass: gradient/edge correlation is sharply peaked
  // around the true render scale (a couple of px off can nearly halve the
  // score), and CANDIDATE_HEIGHTS is deliberately coarse to keep the initial
  // full-image search cheap. Refine each distinct cluster's representative
  // independently so a location that starts out second- or third-best can
  // still be reported once it locks onto its exact render scale.
  const refined = [];
  for (const candidate of clusterRepresentatives) {
    refined.push(
      await scaleRefineCandidate(sourceGradient, sourceWidth, sourceHeight, logo, candidate, sourceIntegral, signal),
    );
  }

  // Scale-refinement can nudge a candidate's position/size enough to create
  // overlap that wasn't there pre-refine (e.g. two clusters converging on
  // the same true logo at slightly different starting heights) — suppress
  // once more on the refined boxes, keeping the higher-scoring member of any
  // pair that now collides, and only return matches that clear the
  // confidence bar.
  return nonMaxSuppress(refined).filter((match) => match.score >= MIN_CONFIDENCE);
}

/** Runs the full detection pipeline for every registered logo within a single band. */
async function allMatchesInBand(bandGradient, bandWidth, bandHeight, signal) {
  const matches = [];
  for (const logo of PROTECTED_LOGOS) {
    let found;
    try {
      found = await searchLogoInGray(bandGradient, bandWidth, bandHeight, logo, signal);
    } catch (err) {
      // A cancelled translation must actually stop the scan, not be treated
      // as "this one logo's search merely failed" and swallowed while the
      // loop moves on to the next registered mark.
      if (signal?.aborted) {
        throw err;
      }
      // A single missing/corrupt reference asset shouldn't stop detection of
      // the other registered brand marks — log and keep going.
      logger.warn(
        `[logoProtection] Failed to search for "${logo.name}" (${logo.assetPath}): ${err.message}`,
      );
      continue;
    }
    for (const match of found) {
      matches.push({ ...match, name: logo.name });
    }
  }
  // Different registered logo templates could in principle also collide on
  // the same pixels; a final cross-logo suppression keeps only the
  // higher-confidence call for any such overlap.
  return nonMaxSuppress(matches);
}

/**
 * Detects confidently-matched protected brand marks in an image buffer.
 * Returns an array of regions in the *original* image's pixel coordinates
 * (with a small safety margin) — empty if nothing was found with enough
 * confidence. Letterheads commonly carry the mark in both a header and a
 * footer, and a single band can itself contain more than one instance (see
 * allMatchesInBand/nonMaxSuppress), so every confident, non-overlapping
 * match in every searched band (see SEARCH_BAND_FRACTION) is reported —
 * not just one per band.
 *
 * Accepts an optional AbortSignal so a cancelled translation actually stops
 * this scan at its next checkpoint instead of running to completion
 * regardless (see the module header's "known limitations" note).
 */
async function detectProtectedLogo(imageBuffer, { signal } = {}) {
  const metadata = await sharp(imageBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    return [];
  }

  const regions = [];
  for (const band of computeSearchBands(metadata.height)) {
    const extractRegion = { left: 0, top: band.top, width: metadata.width, height: band.height };
    const bandGray = await loadGrayscaleBand(imageBuffer, extractRegion);
    const bandGradient = sobelMagnitude(bandGray.data, bandGray.width, bandGray.height);
    const matches = await allMatchesInBand(bandGradient, bandGray.width, bandGray.height, signal);

    if (process.env.DEBUG_LOGO_PROTECTION) {
      logger.debug('[logoProtection] band search result', { band: band.name, matches });
    }

    const { scale } = bandGray;
    for (const best of matches) {
      const padX = best.width * REGION_PADDING;
      const padY = best.height * REGION_PADDING;
      const x0 = Math.max(0, Math.floor((best.x - padX) * scale));
      const y0 = Math.max(0, Math.floor((best.y - padY) * scale + band.top));
      const x1 = Math.min(metadata.width, Math.ceil((best.x + best.width + padX) * scale));
      const y1 = Math.min(
        metadata.height,
        Math.ceil((best.y + best.height + padY) * scale + band.top),
      );

      regions.push({
        name: best.name,
        confidence: best.score,
        x: x0,
        y: y0,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
      });
    }
  }

  return regions;
}

/**
 * Reads a single row/column of pixels just outside the region on one side,
 * as flat RGB triplets, one per pixel along that side's length. Falls back
 * to the opposite side's edge when the region touches the image boundary
 * (e.g. a logo flush against the top of the screenshot has no row above it).
 */
async function readEdge(imageBuffer, extractRegion, count) {
  const { data, info } = await sharp(imageBuffer)
    .extract(extractRegion)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels;
  const samples = new Array(count);
  // Average across the strip's thickness (the few pixels closest to the
  // region) so a single noisy pixel doesn't dominate the fill.
  const thickness = info.width === count ? info.height : info.width;
  for (let i = 0; i < count; i += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let t = 0; t < thickness; t += 1) {
      const idx =
        info.width === count ? (t * info.width + i) * stride : (i * info.width + t) * stride;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
    }
    samples[i] = [r / thickness, g / thickness, b / thickness];
  }
  return samples;
}

/**
 * Builds a raw RGBA patch the size of `region` by bilinearly blending the
 * pixel rows/columns immediately outside its four edges — a lightweight,
 * dependency-free stand-in for proper inpainting (no OpenCV/native deps
 * available here). Handles gradients and simple textures far better than a
 * single flat fill color; still just a heuristic, but this patch is only
 * ever sent to Azure and is fully discarded once we restore the exact
 * original crop, so it only needs to be plausible, not perfect.
 */
async function buildInpaintedPatch(imageBuffer, region, metadata) {
  const { width, height } = region;
  const hasAbove = region.y > 0;
  const hasBelow = region.y + region.height < metadata.height;
  const hasLeft = region.x > 0;
  const hasRight = region.x + region.width < metadata.width;
  const stripPx = Math.max(1, Math.min(BORDER_SAMPLE_PX, 3));

  const [topEdge, bottomEdge, leftEdge, rightEdge] = await Promise.all([
    hasAbove
      ? readEdge(
          imageBuffer,
          {
            left: region.x,
            top: Math.max(0, region.y - stripPx),
            width,
            height: Math.min(stripPx, region.y),
          },
          width,
        )
      : null,
    hasBelow
      ? readEdge(
          imageBuffer,
          {
            left: region.x,
            top: region.y + region.height,
            width,
            height: Math.min(stripPx, metadata.height - (region.y + region.height)),
          },
          width,
        )
      : null,
    hasLeft
      ? readEdge(
          imageBuffer,
          {
            left: Math.max(0, region.x - stripPx),
            top: region.y,
            width: Math.min(stripPx, region.x),
            height,
          },
          height,
        )
      : null,
    hasRight
      ? readEdge(
          imageBuffer,
          {
            left: region.x + region.width,
            top: region.y,
            width: Math.min(stripPx, metadata.width - (region.x + region.width)),
            height,
          },
          height,
        )
      : null,
  ]);

  // Regions flush against a canvas edge borrow the opposite side so every
  // fill still has four sides to blend from — unless the region spans the
  // *entire* width and/or height (e.g. a full-bleed banner), in which case
  // that axis genuinely has no neighboring pixels on either side.
  const top = topEdge ?? bottomEdge;
  const bottom = bottomEdge ?? topEdge;
  const left = leftEdge ?? rightEdge;
  const right = rightEdge ?? leftEdge;
  const hasVerticalEdges = Boolean(top && bottom);
  const hasHorizontalEdges = Boolean(left && right);

  const raw = Buffer.alloc(width * height * 4);
  if (!hasVerticalEdges && !hasHorizontalEdges) {
    // No neighboring pixel data on any side at all (region covers the whole
    // image). There's nothing plausible to blend from, so fall back to a
    // flat mid-grey fill — this patch is only ever seen by Azure's OCR pass,
    // never the final output, so "visually inert" is all it needs to be.
    for (let i = 0; i < width * height; i += 1) {
      const idx = i * 4;
      raw[idx] = 128;
      raw[idx + 1] = 128;
      raw[idx + 2] = 128;
      raw[idx + 3] = 255;
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const vy = height <= 1 ? 0 : y / (height - 1);
      for (let x = 0; x < width; x += 1) {
        const vx = width <= 1 ? 0 : x / (width - 1);
        const vBlend = hasVerticalEdges
          ? [0, 1, 2].map((c) => top[x][c] * (1 - vy) + bottom[x][c] * vy)
          : null;
        const hBlend = hasHorizontalEdges
          ? [0, 1, 2].map((c) => left[y][c] * (1 - vx) + right[y][c] * vx)
          : null;
        const blend =
          vBlend && hBlend
            ? [0, 1, 2].map((c) => (vBlend[c] + hBlend[c]) / 2)
            : vBlend || hBlend;
        const idx = (y * width + x) * 4;
        raw[idx] = Math.round(blend[0]);
        raw[idx + 1] = Math.round(blend[1]);
        raw[idx + 2] = Math.round(blend[2]);
        raw[idx + 3] = 255;
      }
    }
  }

  // A light blur smooths the blocky bilinear seams into something closer to
  // a soft gradient/texture continuation.
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .blur(2)
    .png()
    .toBuffer();
}

/**
 * Format-specific encode options used when re-serializing an image after
 * masking/restoring. Sharp's format defaults (e.g. JPEG q80) are tuned for
 * general-purpose downsizing, not for round-tripping an otherwise-untouched
 * image just to blank/restore a few small regions — a high quality setting
 * keeps that re-encode close to lossless for the 99% of pixels we never
 * touched.
 *
 * `quality` is overridable (see maskRegionForTranslation's retry) because a
 * flat 95 isn't free: re-encoding a JPEG that was originally saved at a low
 * quality (a scanned/compressed source) through mozjpeg at 95 can nearly
 * double its size, and that's what's actually sent to Azure. A caller
 * fighting the batch size limit needs the option to trade some of that
 * fidelity headroom back for size on the masked copy specifically — the
 * final restored output composites the exact original pixels back in
 * regardless, so this only affects what Azure's OCR sees, never the result.
 */
function encodeOptionsFor(format, quality) {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return { quality: quality ?? 95, mozjpeg: true };
    case 'webp':
      return { quality: quality ?? 95 };
    case 'png':
      return { compressionLevel: 9 };
    default:
      return {};
  }
}

/**
 * Blanks each detected region with an inpainted-style fill before the image
 * is handed to Azure Translator, so it has nothing logo-shaped to redraw.
 * Only the masked copy sent to Azure ever sees this fill — the final output
 * always gets the exact original crop(s) back (see `restoreProtectedRegion`),
 * so this only needs to avoid confusing Azure's OCR, not to look perfect.
 *
 * Accepts either a single region or an array (letterheads can carry the mark
 * in both a header and a footer). `.withMetadata()` carries through ICC/EXIF
 * that a bare re-encode would otherwise silently drop.
 *
 * `quality` lets a caller retry at a lower re-encode quality when the
 * default-quality masked copy is too large for the Azure batch size limit
 * (see tool.js), rather than giving up on protection outright the first
 * time that happens.
 */
async function maskRegionForTranslation(imageBuffer, regions, { quality } = {}) {
  const regionList = Array.isArray(regions) ? regions : [regions];
  const metadata = await sharp(imageBuffer).metadata();
  const patches = await Promise.all(
    regionList.map((region) => buildInpaintedPatch(imageBuffer, region, metadata)),
  );
  const composites = regionList.map((region, i) => ({
    input: patches[i],
    left: region.x,
    top: region.y,
  }));
  const format = metadata.format || 'png';
  return sharp(imageBuffer)
    .composite(composites)
    .toFormat(format, encodeOptionsFor(format, quality))
    .withMetadata()
    .toBuffer();
}

/**
 * Restores the exact original pixels for each protected region into a
 * translated image. If the translated image's dimensions no longer match
 * the original (so the regions can't be trusted), the mismatched areas are
 * blanked instead of left as Azure's regenerated content — omitting the
 * mark is safer than a synthetic approximation.
 */
async function restoreProtectedRegion(translatedBuffer, originalBuffer, regions) {
  const regionList = Array.isArray(regions) ? regions : [regions];
  const [translatedMeta, originalMeta] = await Promise.all([
    sharp(translatedBuffer).metadata(),
    sharp(originalBuffer).metadata(),
  ]);
  const format = translatedMeta.format || 'png';

  if (
    translatedMeta.width === originalMeta.width &&
    translatedMeta.height === originalMeta.height
  ) {
    const patches = await Promise.all(
      regionList.map((region) =>
        sharp(originalBuffer)
          .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
          .toBuffer(),
      ),
    );
    const composites = regionList.map((region, i) => ({
      input: patches[i],
      left: region.x,
      top: region.y,
    }));
    return sharp(translatedBuffer)
      .composite(composites)
      .toFormat(format, encodeOptionsFor(format))
      .withMetadata()
      .toBuffer();
  }

  logger.warn(
    '[translate_file] translated image dimensions changed; omitting protected logo region(s) instead of restoring',
    {
      original: `${originalMeta.width}x${originalMeta.height}`,
      translated: `${translatedMeta.width}x${translatedMeta.height}`,
      regionCount: regionList.length,
    },
  );
  const scaleX = translatedMeta.width / originalMeta.width;
  const scaleY = translatedMeta.height / originalMeta.height;
  // Clamp width/height against the *remaining* space to the right/below the
  // mapped origin, not the full canvas — otherwise a region near the right
  // or bottom edge can still overshoot the canvas bounds.
  const mappedRegions = regionList.map((region) => {
    const mappedX = Math.max(0, Math.floor(region.x * scaleX));
    const mappedY = Math.max(0, Math.floor(region.y * scaleY));
    return {
      x: mappedX,
      y: mappedY,
      width: Math.max(
        1,
        Math.min(translatedMeta.width - mappedX, Math.ceil(region.width * scaleX)),
      ),
      height: Math.max(
        1,
        Math.min(translatedMeta.height - mappedY, Math.ceil(region.height * scaleY)),
      ),
    };
  });
  return maskRegionForTranslation(translatedBuffer, mappedRegions);
}

module.exports = {
  PROTECTED_LOGOS,
  MIN_CONFIDENCE,
  detectProtectedLogo,
  maskRegionForTranslation,
  restoreProtectedRegion,
};

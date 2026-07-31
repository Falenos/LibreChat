/**
 * [knauf] KK20-252 — the Knauf brand as a real module inside the artifact sandbox.
 *
 * ## Why
 *
 * Every branded artifact needs the same `KNAUF` token const, KnaufScreen fonts, the
 * `useKnaufTheme` hook, and a wordmark whose `d` attribute is 903 characters of
 * coordinate data. Until now the skills told the model to retype most of it into every
 * artifact, and `skill/karl-brand/references/logo.md` says of that path:
 *
 *   "It is 903 characters of coordinate data with no redundancy — any edit silently
 *    deforms the letterforms, and there is no error to tell you."
 *
 * That is a lossy channel with no checksum and two failure modes: a placeholder logo
 * (visible) or deformed letterforms (invisible). In practice the model routed around it
 * — placeholders, trimmed blocks, and finally an invented
 * `import ... from '/knauf-brand-tokens'` that resolved to nothing. The model was asking
 * for the right architecture; this gives it one.
 *
 * ## How
 *
 * Sandpack mounts a virtual filesystem per artifact. `sharedFiles` in
 * `client/src/utils/artifacts.ts` already injects ~38 shadcn sources into every sandbox,
 * and `ArtifactPreview` spreads it last so these entries win on key collision. Adding
 * `/knauf/brand.tsx` and `/knauf/fonts.css` there makes
 *
 *     import { KNAUF, useKnaufTheme, KnaufWordmark } from '/knauf/brand';
 *
 * resolve exactly the way `/components/ui/card` already does — extension-less,
 * root-absolute, resolved by the bundler with no tsconfig `paths` involved.
 *
 * ## The source of truth is still the skill
 *
 * The string below is copied verbatim from `skill/karl-brand/SKILL.md` (the `KNAUF`
 * const and `useKnaufTheme`) and `skill/karl-brand/references/logo.md` (the
 * `KnaufWordmark` component). Those files remain where the values are authored — they
 * are also read by non-artifact deliverables (documents, email, spreadsheets) and by
 * `text/html` and `image/svg+xml` artifacts, none of which can import anything.
 *
 * `brandModule.knauf.spec.ts` holds the two in lockstep in both directions, and checks
 * this file's `d` path against the committed `knauf/brand/logos/KNAUFLogo2024sRGB.svg`.
 * Edit the skill, then re-copy here; the spec fails if they drift.
 *
 * Untyped on purpose: Sandpack transpiles without type-checking, and these are the exact
 * signatures that already run in previews today.
 */
export const knaufBrandModule = `import { useMemo } from 'react';
import '/knauf/fonts.css';

// ── KNAUF tokens — canonical. Never invent a hex; copy from here. ────────────
const KNAUF = {
  // BRAND-LITERAL — the Knauf Color System. Never alter these values.
  brand: {
    cyanBlue:       '#0099DE', // primary. Headlines, key visual, chart slot 1. 3.18:1 on white
    logoCyan:       '#00A0E6', // LOGO MARK FILL ONLY. 2.93:1 — logotype exemption
    accessibleBlue: '#003778', // digital text + highlights. 11.55:1 on white. NEVER the logo
    darkGreen:      '#004B46', // secondary support colour
    lightGreen:     '#87C15F', // backgrounds/tables/accents. NOT text, NOT a series (2.14:1)
    orange:         '#F06E00', // support, sparingly. NOT text
    yellow:         '#FFD25C', // backgrounds/highlights. NOT text (1.44:1)
    grey:           '#CFD7D9', // tables, neutral areas, gridlines. NOT text (1.46:1)
  },
  // EXTENSION — the brand book defines no ink layer. Derived for WCAG AA.
  ink: {
    primary:       '#0F1A2A', // 17.48:1 on #FFFFFF
    secondary:     '#3A4A5C', //  9.08:1
    muted:         '#5B6770', //  5.80:1 — the floor for captions and axis labels
    heading:       '#003778', // = brand.accessibleBlue. LIGHT MODE ONLY
    accentOnBrand: '#66BCE8', // on the #003778 bar: 5.46:1
    onDark:        '#E6EEF5', // 15.39:1 on #0F1720
    mutedOnDark:   '#9FB0BF', //  8.11:1 on #0F1720
    headingOnDark: '#E6EEF5', // accessibleBlue is 1.56:1 on dark — never use it there
  },
  // EXTENSION — no surface layer in the brand book.
  surface: {
    page:    '#F4F8FB', card:     '#FFFFFF', border:     '#DCE6EE',
    pageDark:'#0F1720', cardDark: '#16212E', borderDark: '#26333F',
    neutral: '#CFD7D9', // = brand.grey, by role: table header/zebra, gridlines
  },
  typography: {
    body: '"Knauf Screen", Arial, Helvetica, sans-serif',
    heading: '"Knauf Screen Head", "Knauf Screen", Arial, Helvetica, sans-serif',
  },
  // Chart series, fixed order, assigned by series index. Validated in BOTH
  // modes with ONE set of steps — there is no dark variant.
  // Derivation and measurements are recorded with the palette.
  categorical: ['#0099DE','#D96400','#009184','#7A4FB5','#5A9A32','#C43A8B','#B8860B'],
  // Scatter / bubble / choropleth / small multiples: max 3 series, THESE three.
  categoricalAllPairs: ['#0099DE','#D96400','#7A4FB5'],
  // ORDINAL — discrete ordered marks (funnel stages, tiers). Both modes.
  ordinalCerulean: ['#66BCE8','#0099DE','#0077B0','#00527A'],
  // SEQUENTIAL — continuous magnitude only (heatmap, choropleth). NOT ordinal.
  sequentialCerulean: ['#E5F3FB','#B3DCF3','#66BCE8','#0099DE','#0077B0','#00527A'],
  // EXTENSION — functional state. NEVER a data series. Always paired with an
  // icon or a label. Never white text on these fills.
  status: { success: '#1F883D', warning: '#C98A00', serious: '#E8792A', critical: '#D64550' },
};

// One theme picker. \`palette\` does not branch — the series steps are mode-agnostic.
function useKnaufTheme(dark) {
  return useMemo(() => ({
    palette: KNAUF.categorical,
    page:    dark ? KNAUF.surface.pageDark   : KNAUF.surface.page,
    card:    dark ? KNAUF.surface.cardDark   : KNAUF.surface.card,
    border:  dark ? KNAUF.surface.borderDark : KNAUF.surface.border,
    text:    dark ? KNAUF.ink.onDark         : KNAUF.ink.primary,
    muted:   dark ? KNAUF.ink.mutedOnDark    : KNAUF.ink.muted,
    heading: dark ? KNAUF.ink.headingOnDark  : KNAUF.ink.heading,
    grid:    dark ? KNAUF.surface.borderDark : KNAUF.surface.neutral,
  }), [dark]);
}

function KnaufWordmark({ height = 28, fill = KNAUF.brand.logoCyan }) {
  return (
    <svg
      viewBox="0 0 283.4646 143.4898"
      height={height}
      width={height * 1.9755}
      role="img"
      aria-label="Knauf"
      focusable="false"
    >
      <path fill={fill} d="M197.5438,118.3649c18.5564,0,26.0413-5.926,28.0685-20.4293l9.3562-66.746h-19.0242l-9.3562,67.3698c-0.4678,3.5868-2.6509,5.1463-7.0171,5.1463s-6.0815-1.5595-5.6137-5.1463l9.5121-67.3698h-19.0242l-9.3562,66.746C173.0618,112.5948,179.6112,118.3649,197.5438,118.3649z M141.5628,87.0193l11.2274-41.4823h1.7153l-3.1187,41.4823H141.5628z M115.2096,116.3376h18.5564l4.0543-15.127h12.4749l-1.0916,15.127h18.7123l3.5865-85.1479h-31.3432L115.2096,116.3376z M57.5132,116.3376H75.134l5.9256-41.9501h1.0916l10.2918,41.9501h17.9326l12.0071-85.1479h-17.6208l-6.2374,44.1334h-1.0916l-9.9799-44.1334H69.5203L57.5132,116.3376z M0,116.3376h19.0242l5.3018-37.2717h1.8712l7.1731,37.2717h19.3361L43.974,71.1125L63.31,31.1897H44.1299L27.6007,65.1865h-1.4034L35.3975,0H16.3733L0,116.3376z M247.7308,143.4898l9.5365-67.6988h18.4005l2.0272-14.3473h-18.4005l2.1831-15.9067h19.9598l2.0272-14.3473h-38.984l-15.7739,112.3001H247.7308z" />
    </svg>
  );
}

export { KNAUF, useKnaufTheme, KnaufWordmark };
`;

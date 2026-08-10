---
name: karl-brand
description: >-
  Knauf brand tokens — the single source of truth for anything that must look
  like Knauf: reports, decks, dashboards, artifacts, documents, tables, emails.
  Official colours, a validated chart palette, ink/surface tokens and the real
  KNAUF logo.
argument-hint: "[what to brand]"
user-invocable: true
version: "1.0.1"
---

# Knauf brand — the single source of truth

This file owns every Knauf colour value. No other skill, template, or artifact
declares a hex — they transcribe the `KNAUF` const below. If a colour you need
is not here, it is not a Knauf colour.

Three references carry the rest:

| Read | When |
|---|---|
| `skills/karl-brand/references/charts.md` | Any chart, in any medium |
| `skills/karl-brand/references/logo.md` | Any time the wordmark appears |
| `skills/karl-brand/references/non-artifact.md` | Documents, decks, chat tables, email, spreadsheets |

For artifact structure and layout templates, see `skills/karl-artifacts/SKILL.md`.

## Read this before you pick a colour

1. **Never invent a hex.** Transcribe from the `KNAUF` const. Every value there is
   either brand-literal or a labelled, measured extension.
2. **`lightGreen`, `orange`, `yellow` and `grey` are never text and never a chart
   series.** The brand book marks all four "not for text" — they are background,
   table and accent fills. On white they measure 2.14, 3.03, 1.44 and 1.46:1.
3. **`accessibleBlue` `#003778` is the light-mode heading and highlight ink.** It is
   never the logo (the brand book forbids it), and never used on a dark surface —
   `#003778` on `#0F1720` is **1.56:1**, effectively invisible.
4. **Chart labels, values, axes and legends wear ink tokens, never a series colour.**
   A coloured mark beside the text carries the identity; the text stays readable.

## The official colour system

Verbatim from the Knauf Color System. Contrast measured against `#FFFFFF` (light
surface) and `#0F1720` (dark surface).

| Name | HEX | RGB | CMYK | Pantone | RAL | Use case | on white | on dark |
|---|---|---|---|---|---|---|---|---|
| Knauf Cyan Blue | `#0099DE` | 0,160,230 | 100,0,0,0 | Process Cyan C | 240 60 40 | Logo, headlines, brand statement, key visual | 3.18 | 5.68 |
| Knauf Accessible Blue | `#003778` | 0,55,120 | 100,75,0,30 | 3597 C | 270 30 30 | Digital text and highlights. **Never the logo** | 11.55 | 1.56 |
| Knauf Dark Green | `#004B46` | 0,75,70 | 100,25,55,55 | 3292 C | 6026 | Secondary support colour | 10.02 | — |
| Knauf Light Green | `#87C15F` | 135,193,95 | 50,0,75,0 | 368 C | 120 70 75 | Backgrounds, tables, graphic accents. **Not text** | 2.14 | — |
| Knauf Orange | `#F06E00` | 240,110,0 | 0,65,100,0 | 152 C | 060 60 80 | Support colour, use sparingly. **Not text** | 3.03 | — |
| Knauf Yellow | `#FFD25C` | 255,210,92 | 0,17,70,0 | 121 C | 080 80 60 | Backgrounds and graphic highlights. **Not text** | 1.44 | — |
| Knauf Grey | `#CFD7D9` | 207,215,217 | 5,0,0,20 | 427 C | 7047 | Tables, backgrounds, neutral content areas. **Not text** | 1.46 | — |

`#0099DE` at 3.18:1 clears the 3:1 floor for graphics and large text but **fails
4.5:1 for body copy** — use `#003778` for anything small.

## Two cyans

The brand sheet lists Cyan Blue as `#0099DE` while giving its RGB as 0,160,230,
which is `#00A0E6`. The resolution, so nobody reopens it:

- **`#0099DE` for every digital surface, UI element and chart series.**
- **`#00A0E6` for the logo mark fill only** — that is what the official SVG uses.
  It measures 2.93:1 on white, which is fine for a logotype (WCAG 1.4.11 exempts
  logotypes) and disqualifying for anything else. It is reused for nothing.

## Typography

The official typefaces are **Knauf Screen** for body copy and **Knauf Screen Head**
for headings and display type. React artifacts load the supplied Digital+Web WOFF2
files automatically when they import `/knauf/brand`; do not add another webfont or
replace them with a system-UI stack. Standalone HTML artifacts use the prebuilt
`/knauf/fonts.css` stylesheet. Arial and Helvetica are fallbacks only for formats
that cannot embed or load the supplied fonts, especially email.

Use weights 400 and 700, matching the supplied regular and bold webfont files.
Reserve `font-variant-numeric: tabular-nums` for columns that must align vertically
(table rows, axis ticks).

Type scale is layout, so it comes from Tailwind classes: page title `text-2xl`,
section `text-lg`/`text-xl`, card title `text-base font-bold`, captions
`text-sm`/`text-xs`. Headings use the supplied 700 weight in `ink.heading`.

## Generated imagery

Generated images that represent Knauf or KARL use the Knauf palette and leave a
quiet clear-space area for the real wordmark. Never ask an image model to draw,
spell or reinterpret the KNAUF logo: generate the imagery without a mark, then add
the exact SVG wordmark in the artifact or layout stage. If the output medium cannot
preserve that SVG exactly, omit the logo rather than ship a synthetic one.

In generated artifacts, place that wordmark only in a full-width white header band
with the cyan logo fill. The header stays white in dark mode. Never simulate this by
putting a small white logo box inside a dark or coloured header.

## Tokens

In React artifacts these are prebuilt at `/knauf/brand`, which exports `KNAUF`,
`useKnaufTheme` and `KnaufWordmark` — import them, never re-declare them. Every other
medium (HTML and SVG artifacts, documents, decks, email, spreadsheets) has no module
system, so transcribe the values from the block below. It is the only place they are
authored.

```ts
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

// One theme picker. `palette` does not branch — the series steps are mode-agnostic.
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
```

Three shape decisions worth knowing:

- `logoCyan` is a separate token from `cyanBlue` because that is where the brand
  sheet's own HEX-vs-RGB inconsistency is resolved.
- `ink.heading` and `ink.headingOnDark` exist as a pair so the 1.56:1 dark-heading
  trap is structurally unreachable — read the heading colour from the theme, never
  from `KNAUF.brand.accessibleBlue` directly.
- `surface.neutral` aliases `brand.grey` **by role**, so someone reaching for a
  table zebra never has to know it is a brand colour under a "not for text" rule.

## Not brand tokens

Two values you may find in older material. Both are deliberately absent above.

- **`#55B7DA`** (once called "shakespeare") — 2.29:1 on white, below even the 3:1
  floor for graphics, and not in the brand book. Where it was used as accent text
  on the `#003778` bar, use `ink.accentOnBrand` `#66BCE8` (5.46:1 on that bar).
- **`#213A75`** — the app's user-avatar background, a generator seed in
  `packages/client/src/hooks/useAvatar.ts`. It measures **1.06:1 against `#003778`**,
  i.e. visually identical, so it is not a design token. Never use it in a
  deliverable; use `#003778`.

## Contrast pairs you will actually need

| Foreground | Background | Ratio | Note |
|---|---|---|---|
| `#0F1A2A` | `#FFFFFF` | 17.48 | body copy |
| `#5B6770` | `#FFFFFF` | 5.80 | captions, axis labels — the muted floor |
| `#003778` | `#FFFFFF` | 11.55 | headings |
| `#FFFFFF` | `#003778` | 11.55 | the brand bar |
| `#0099DE` | `#FFFFFF` | 3.18 | graphics and large headings only |
| `#0F1A2A` | `#0099DE` | 5.50 | so a cyan button takes ink text, not white |
| `#E6EEF5` | `#0F1720` | 15.39 | dark-mode body |
| `#003778` | `#0F1720` | 1.56 | **never** |
| `#0F1A2A` | `#CFD7D9` | 11.96 | why grey is an excellent table fill |
| `#0F1A2A` | `#FFD25C` | 12.17 | why yellow is an excellent highlight fill |
| `#0F1A2A` | `#87C15F` | 8.18 | why light green is a good accent fill |

## If this reference is unavailable

`karl-artifacts` carries a labelled quick-card mirror of the values above for the
case where a cross-skill read of this file fails. When falling back to it, add one
short line to the reply saying the result uses fallback brand values and may differ
in detail — name no file and no skill — rather than presenting the mirror as
authoritative.

Maintainer constraints for this skill — the frontmatter it must keep, why it must
not be renamed — live in `skill/README.md`, not here.

# Slide-deck template (`slides`)

## When to use this template

Reach for this when the artifact is a **presentation**: a linear sequence of
full-bleed 16:9 slides the viewer clicks through — a quarterly review, a rollout
plan, a pitch. It follows the viewer's OS light/dark preference and routes every
colour through the theme; there is no visible toggle, because the viewer is here to
advance slides. If the ask is an interactive dashboard, a single report page, or a
form, use a different template.

The deck is driven by one `const SLIDES = [...]` array. Each entry has a `type` that
picks a layout — `'title'`, `'section'`, `'bullets'`, `'chart'`. Add or reorder slides
by editing that array only; the renderer, navigation and footer adapt automatically.

## Before you write

Read `skills/karl-brand/SKILL.md` and paste its `KNAUF` const and `useKnaufTheme`
into the artifact as the first block. Read
`skills/karl-brand/references/logo.md` for the `KnaufWordmark` component and its `d`
path. **The code below assumes all three exist and introduces no colour that is not
already in the `KNAUF` const.**

## Tokens this layout uses

| Token | Styles |
|---|---|
| `KNAUF.brand.accessibleBlue` | title-slide field, top-bar mark background |
| `KNAUF.brand.cyanBlue` | section rule, bullet markers, the Next button |
| `KNAUF.ink.accentOnBrand` | title-slide subtitle on the blue field |
| `theme.heading` / `theme.text` / `theme.muted` | slide headings / body / captions |
| `theme.card` / `theme.page` / `theme.border` | slide surface / stage surround / hairlines |
| `theme.palette[i]` | chart series, by index |
| `theme.grid` | gridlines, axis strokes |

## Brand & layout guidance

- **The real wordmark, not typed text.** `<KnaufWordmark />` in the top bar and in the
  slide footer. On the `accessibleBlue` field it takes `#FFFFFF`; on a light surface
  it takes `KNAUF.brand.logoCyan`. Deck naming is separate text beside it. Both
  placements sit at or above the **20px floor** from `logo.md` — the footer mark is
  the one that tempts you below it, and below 20px the counters close up.
- **Stage.** A `max-w-5xl` wrapper holds an `aspect-video` stage. Slide content is
  absolutely positioned to fill it, so every slide is the same size.
- **Type scale.** Title slides `text-5xl`; section dividers `text-4xl`; slide headings
  `text-3xl`; body `text-lg`/`text-base`; footer `text-sm`. Tailwind scale classes
  only — never bracket values.
- **Navigation.** Prev/Next buttons (lucide `ChevronLeft`/`ChevronRight`) plus
  `ArrowLeft`/`ArrowRight` keys via a `keydown` `useEffect`. A `"3 / 5"` counter and a
  slide-number footer orient the viewer.
- **A cyan button takes ink text, not white.** White on `#0099DE` is 3.18:1, which
  fails AA for a `text-sm` label; ink on cyan is 5.50:1.
- **Charts.** Assign `theme.palette` in **fixed index order**, never rank- or
  value-driven. Always include a `<Legend />`, and always give it a `formatter` —
  recharts paints legend label text in the series colour and `wrapperStyle` does not
  override it. The `<ResponsiveContainer>` sits in a parent with an explicit
  `h-72 w-full`. Status colours never enter the data palette.

```tsx
// ── assumes KNAUF, useKnaufTheme and KnaufWordmark from karl-brand ───────────
import React, { useMemo, useState, useEffect, useCallback } from 'react'; // useMemo: also the pasted useKnaufTheme
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

const REVENUE = [
  { region: 'DACH', prior: 42, current: 51 },
  { region: 'Iberia', prior: 28, current: 33 },
  { region: 'Nordics', prior: 19, current: 26 },
  { region: 'Benelux', prior: 23, current: 24 },
];

// `field: 'brand'` renders a full-bleed accessibleBlue title slide.
const SLIDES = [
  { type: 'title', title: 'KARL Platform Review', subtitle: 'Q2 2026 · Knauf Digital', field: 'brand' },
  { type: 'section', title: '01 — Adoption', subtitle: 'Where the rollout stands today' },
  { type: 'bullets', title: 'Highlights this quarter', items: [
    'Active users up 38% across DACH and Iberia business units',
    'Median time-to-first-answer down from 14s to 5s',
    'Four production agents live; two more in UAT',
    'Zero SEV-1 incidents since the March hardening release',
  ] },
  { type: 'chart', title: 'Revenue by region', unit: '€M',
    keys: [{ k: 'prior', label: 'FY2023' }, { k: 'current', label: 'FY2024' }] },
  { type: 'title', title: 'Thank you', subtitle: 'Questions & discussion', field: 'brand' },
];

function Slide({ slide, theme }) {
  if (slide.type === 'title') {
    return (
      <div
        className="absolute inset-0 flex flex-col justify-center px-16"
        style={{ backgroundColor: KNAUF.brand.accessibleBlue }}
      >
        <h1 className="text-5xl font-bold leading-tight" style={{ color: '#FFFFFF' }}>{slide.title}</h1>
        <p className="mt-4 text-xl" style={{ color: KNAUF.ink.accentOnBrand }}>{slide.subtitle}</p>
      </div>
    );
  }
  if (slide.type === 'section') {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-16" style={{ backgroundColor: theme.page }}>
        <div className="mb-5 h-1.5 w-24 rounded-full" style={{ backgroundColor: KNAUF.brand.cyanBlue }} />
        <h2 className="text-4xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
        <p className="mt-3 text-lg" style={{ color: theme.muted }}>{slide.subtitle}</p>
      </div>
    );
  }
  if (slide.type === 'bullets') {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-16" style={{ backgroundColor: theme.card }}>
        <h2 className="mb-8 text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
        <ul className="space-y-5">
          {slide.items.map((item, i) => (
            <li key={i} className="flex items-start gap-4">
              <span
                className="mt-2 inline-block h-3 w-3 flex-shrink-0 rounded-sm"
                style={{ backgroundColor: KNAUF.brand.cyanBlue }}
                aria-hidden="true"
              />
              <span className="text-lg leading-snug" style={{ color: theme.text }}>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  // 'chart'
  return (
    <div className="absolute inset-0 flex flex-col px-16 py-12" style={{ backgroundColor: theme.card }}>
      <h2 className="mb-1 text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
      <p className="mb-4 text-sm" style={{ color: theme.muted }}>Figures in {slide.unit}</p>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={REVENUE} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis dataKey="region" tick={{ fill: theme.muted, fontSize: 13 }} stroke={theme.grid} />
            <YAxis tick={{ fill: theme.muted, fontSize: 13 }} stroke={theme.grid} />
            <Tooltip
              contentStyle={{
                backgroundColor: theme.card,
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                color: theme.text,
              }}
            />
            {/* formatter, not wrapperStyle: recharts colours legend text by series. */}
            <Legend
              wrapperStyle={{ fontSize: 13 }}
              formatter={(value) => <span style={{ color: theme.text }}>{value}</span>}
            />
            {slide.keys.map((s, i) => (
              <Bar key={s.k} dataKey={s.k} name={s.label} fill={theme.palette[i]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function KarlSlideDeck() {
  // Follow the viewer's OS preference. No toggle: they are here to advance slides.
  const dark = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
    [],
  );
  const theme = useKnaufTheme(dark);
  const [index, setIndex] = useState(0);
  const total = SLIDES.length;

  const go = useCallback((delta) => {
    setIndex((prev) => Math.min(total - 1, Math.max(0, prev + delta)));
  }, [total]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const slide = SLIDES[index];

  return (
    <div className="min-h-screen w-full px-4 py-8" style={{ backgroundColor: theme.page }}>
      <div className="mx-auto max-w-5xl">
        <div
          className="mb-3 flex items-center justify-between rounded-t-lg border px-5 py-3"
          style={{ backgroundColor: KNAUF.brand.accessibleBlue, borderColor: theme.border }}
        >
          <KnaufWordmark height={22} fill="#FFFFFF" />
          <span className="text-sm font-medium" style={{ color: KNAUF.ink.accentOnBrand }}>
            Knauf Digital · Confidential
          </span>
        </div>

        <div
          className="relative aspect-video w-full overflow-hidden rounded-lg border"
          style={{ borderColor: theme.border }}
        >
          <Slide slide={slide} theme={theme} />
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t px-6 py-2"
            style={{ borderTopColor: theme.border, backgroundColor: theme.card }}
          >
            {/* 20px is the floor from logo.md — do not shrink this to fit. */}
            <KnaufWordmark height={20} fill={KNAUF.brand.logoCyan} />
            <span className="text-sm" style={{ color: theme.muted }}>Slide {index + 1}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            onClick={() => go(-1)}
            disabled={index === 0}
            className="flex items-center gap-1 rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: theme.card, color: theme.heading, borderColor: theme.border }}
          >
            <ChevronLeft size={18} aria-hidden="true" /> Prev
          </button>
          <span className="text-sm font-semibold" style={{ color: theme.text }}>{index + 1} / {total}</span>
          <button
            onClick={() => go(1)}
            disabled={index === total - 1}
            className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: KNAUF.brand.cyanBlue, color: KNAUF.ink.primary }}
          >
            Next <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

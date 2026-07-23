# Slide-deck template (`slides`)

## When to use this template

Reach for this when the artifact is a **presentation**: a linear sequence of full-bleed 16:9 slides the viewer clicks through — a quarterly review, a rollout plan, a pitch. It is a brand *deliverable*, so it commits to the Knauf **light** look (white surfaces, no dark-mode swap). If the ask is an interactive dashboard, a single report page, or a form, use a different template.

The deck is driven by one `const SLIDES = [...]` array. Each entry has a `type` that picks a layout — `'title'`, `'section'`, `'bullets'`, `'chart'`. Add or reorder slides by editing that array only; the renderer, navigation, and footer adapt automatically.

## Brand & layout guidance

- **Wordmark, not logo.** External images are blocked. Render the brand as styled text (`KARL` in Regal Blue + a Cerulean dot) in the top bar and footer. Never an `<img>` logo.
- **Colors come from one `KNAUF` object** applied via `style={{}}` (surfaces, text, bars) or recharts props (chart fills). Tailwind is for **layout/spacing/typography only** — no bracket/arbitrary values ever.
- **Stage.** A `max-w-5xl` wrapper holds an `aspect-video` stage (the allowed 16:9 class). Slide content is absolutely positioned to fill it, so every slide is the same size.
- **Type scale.** Title slides use `text-5xl`; section dividers `text-4xl`; slide headings `text-3xl`; body `text-lg`/`text-base`; footer `text-sm`. All Tailwind scale classes — never pixel values.
- **Navigation.** Prev/Next buttons (lucide `ChevronLeft`/`ChevronRight`) plus `ArrowLeft`/`ArrowRight` keys via a `keydown` `useEffect`. A `"3 / 8"` counter and a slide-number footer orient the viewer.
- **Charts.** Assign `categoricalLight` in **fixed index order** (series 0 → `[0]`, series 1 → `[1]`), never rank- or value-driven. Always include a `<Legend />` — identity is never by color alone. The `<ResponsiveContainer>` sits in a parent with an explicit `h-72 w-full`. Keep status colors (good/warn/serious/critical) out of the data palette.

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';

// Single source of brand truth — every color below is applied inline or via recharts props.
const KNAUF = {
  cerulean: '#0099DE',
  regalBlue: '#003778',
  shakespeare: '#55B7DA',
  ink: '#0F1A2A',
  muted: '#5B6770',
  surface: '#FFFFFF',
  surfaceAlt: '#F4F8FB',
  border: '#DCE6EE',
  onDark: '#E6EEF5',
  categoricalLight: ['#0099DE', '#E86D1F', '#009E86', '#7A4FB5', '#D64550', '#C98A00', '#C43A8B'],
};

const REVENUE = [
  { region: 'DACH', prior: 42, current: 51 },
  { region: 'Iberia', prior: 28, current: 33 },
  { region: 'Nordics', prior: 19, current: 26 },
  { region: 'Benelux', prior: 23, current: 24 },
];

const SLIDES = [
  { type: 'title', title: 'KARL Platform Review', subtitle: 'Q2 2026 · Knauf Digital', bg: KNAUF.regalBlue },
  { type: 'section', title: '01 — Adoption', subtitle: 'Where the rollout stands today' },
  { type: 'bullets', title: 'Highlights this quarter', items: [
    'Active users up 38% across DACH and Iberia business units',
    'Median time-to-first-answer down from 14s to 5s',
    'Four production agents live; two more in UAT',
    'Zero SEV-1 incidents since the March hardening release',
  ] },
  { type: 'chart', title: 'Revenue by region', unit: '€M',
    keys: [{ k: 'prior', label: 'FY2023' }, { k: 'current', label: 'FY2024' }] },
  { type: 'title', title: 'Thank you', subtitle: 'Questions & discussion', bg: KNAUF.cerulean },
];

function Wordmark({ dark }) {
  return (
    <span className="font-bold tracking-tight" style={{ color: dark ? KNAUF.onDark : KNAUF.regalBlue }}>
      KARL<span style={{ color: KNAUF.cerulean }}>.</span>
    </span>
  );
}

function Slide({ slide }) {
  if (slide.type === 'title') {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-16" style={{ backgroundColor: slide.bg }}>
        <h1 className="text-5xl font-bold leading-tight" style={{ color: '#FFFFFF' }}>{slide.title}</h1>
        <p className="mt-4 text-xl" style={{ color: KNAUF.onDark }}>{slide.subtitle}</p>
      </div>
    );
  }
  if (slide.type === 'section') {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-16" style={{ backgroundColor: KNAUF.surfaceAlt }}>
        <div className="mb-5 h-1.5 w-24 rounded-full" style={{ backgroundColor: KNAUF.cerulean }} />
        <h2 className="text-4xl font-semibold" style={{ color: KNAUF.regalBlue }}>{slide.title}</h2>
        <p className="mt-3 text-lg" style={{ color: KNAUF.muted }}>{slide.subtitle}</p>
      </div>
    );
  }
  if (slide.type === 'bullets') {
    return (
      <div className="absolute inset-0 flex flex-col justify-center px-16" style={{ backgroundColor: KNAUF.surface }}>
        <h2 className="mb-8 text-3xl font-semibold" style={{ color: KNAUF.regalBlue }}>{slide.title}</h2>
        <ul className="space-y-5">
          {slide.items.map((item, i) => (
            <li key={i} className="flex items-start gap-4">
              <span className="mt-2 inline-block h-3 w-3 flex-shrink-0 rounded-sm" style={{ backgroundColor: KNAUF.cerulean }} />
              <span className="text-lg leading-snug" style={{ color: KNAUF.ink }}>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  // 'chart'
  return (
    <div className="absolute inset-0 flex flex-col px-16 py-12" style={{ backgroundColor: KNAUF.surface }}>
      <h2 className="mb-1 text-3xl font-semibold" style={{ color: KNAUF.regalBlue }}>{slide.title}</h2>
      <p className="mb-4 text-sm" style={{ color: KNAUF.muted }}>Figures in {slide.unit}</p>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={REVENUE} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={KNAUF.border} vertical={false} />
            <XAxis dataKey="region" tick={{ fill: KNAUF.muted, fontSize: 13 }} stroke={KNAUF.border} />
            <YAxis tick={{ fill: KNAUF.muted, fontSize: 13 }} stroke={KNAUF.border} />
            <Tooltip contentStyle={{ borderColor: KNAUF.border, borderRadius: 8, color: KNAUF.ink }} />
            <Legend wrapperStyle={{ color: KNAUF.ink, fontSize: 13 }} />
            {slide.keys.map((s, i) => (
              <Bar key={s.k} dataKey={s.k} name={s.label} fill={KNAUF.categoricalLight[i]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function KarlSlideDeck() {
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
    <div className="min-h-screen w-full px-4 py-8" style={{ backgroundColor: KNAUF.surfaceAlt }}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex items-center justify-between rounded-t-lg px-5 py-3" style={{ backgroundColor: KNAUF.surface, borderColor: KNAUF.border, borderWidth: 1 }}>
          <Wordmark />
          <span className="text-sm font-medium" style={{ color: KNAUF.muted }}>Knauf Digital · Confidential</span>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-lg" style={{ borderColor: KNAUF.border, borderWidth: 1 }}>
          <Slide slide={slide} />
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-6 py-2"
            style={{ borderTopColor: KNAUF.border, borderTopWidth: 1, backgroundColor: 'rgba(255,255,255,0.85)' }}>
            <Wordmark />
            <span className="text-sm" style={{ color: KNAUF.muted }}>Slide {index + 1}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button onClick={() => go(-1)} disabled={index === 0}
            className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: KNAUF.surface, color: KNAUF.regalBlue, borderColor: KNAUF.border, borderWidth: 1 }}>
            <ChevronLeft size={18} /> Prev
          </button>
          <span className="text-sm font-semibold" style={{ color: KNAUF.ink }}>{index + 1} / {total}</span>
          <button onClick={() => go(1)} disabled={index === total - 1}
            className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ backgroundColor: KNAUF.cerulean, color: '#FFFFFF' }}>
            Next <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
```

/**
 * [knauf] A platform-owned slide renderer for generated React artifacts.
 *
 * The model supplies slide data. This module owns navigation, export markers,
 * responsive 16:9 layout, Knauf branding, keyboard controls, and theme-safe ink.
 */
export const knaufSlideDeckModule = `import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { KNAUF, KnaufWordmark, useKnaufTheme } from '/knauf/brand';

function useOsDarkMode() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches === true);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = () => setDark(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  return dark;
}

function InlineText({ value, theme }) {
  if (value && typeof value === 'object' && value.href) {
    return (
      <a
        href={value.href}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-1 underline-offset-2"
        style={{ color: theme.heading }}
      >
        {value.text || value.label || value.href}
      </a>
    );
  }
  return <>{String(value ?? '')}</>;
}

function Sources({ sources, theme }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: theme.muted }}>
      {sources.map((source, index) => (
        <span key={source.href || source.text || index}>
          <InlineText value={source} theme={theme} />
        </span>
      ))}
    </div>
  );
}

function TitleSlide({ slide }) {
  return (
    <div
      className="absolute inset-0 flex flex-col justify-center px-16 pb-16"
      style={{ backgroundColor: KNAUF.brand.accessibleBlue }}
    >
      <p className="mb-5 text-sm font-semibold uppercase tracking-wider" style={{ color: KNAUF.ink.accentOnBrand }}>
        {slide.eyebrow || 'Presentation'}
      </p>
      <h1 className="max-w-4xl text-5xl font-bold leading-tight" style={{ color: '#FFFFFF' }}>
        {slide.title}
      </h1>
      {slide.subtitle ? (
        <p className="mt-5 max-w-3xl text-xl leading-relaxed" style={{ color: KNAUF.ink.accentOnBrand }}>
          {slide.subtitle}
        </p>
      ) : null}
    </div>
  );
}

function SectionSlide({ slide, theme }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-center px-16 pb-16" style={{ backgroundColor: theme.page }}>
      <div className="mb-6 h-1.5 w-24 rounded-full" style={{ backgroundColor: KNAUF.brand.cyanBlue }} />
      <h2 className="max-w-4xl text-4xl font-semibold leading-tight" style={{ color: theme.heading }}>{slide.title}</h2>
      {slide.subtitle ? <p className="mt-4 max-w-3xl text-xl" style={{ color: theme.muted }}>{slide.subtitle}</p> : null}
    </div>
  );
}

function BulletList({ items = [], theme }) {
  return (
    <ul className="space-y-4">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-4 text-lg leading-snug" style={{ color: theme.text }}>
          <span className="mt-2.5 h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: KNAUF.brand.cyanBlue }} aria-hidden="true" />
          <span><InlineText value={item} theme={theme} /></span>
        </li>
      ))}
    </ul>
  );
}

function BulletsSlide({ slide, theme }) {
  return (
    <div className="absolute inset-0 px-16 pb-20 pt-12" style={{ backgroundColor: theme.card }}>
      <h2 className="mb-7 text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
      <BulletList items={slide.items} theme={theme} />
      <Sources sources={slide.sources} theme={theme} />
    </div>
  );
}

function ColumnsSlide({ slide, theme }) {
  const columns = slide.columns || [];
  return (
    <div className="absolute inset-0 px-12 pb-20 pt-10" style={{ backgroundColor: theme.page }}>
      <h2 className="mb-6 text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
      <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(' + Math.max(1, columns.length) + ', minmax(0, 1fr))' }}>
        {columns.map((column, index) => (
          <section key={column.title || index} className="rounded-lg border p-5" style={{ backgroundColor: theme.card, borderColor: theme.border }}>
            <h3 className="mb-4 text-xl font-semibold" style={{ color: theme.heading }}>{column.title}</h3>
            <BulletList items={column.items} theme={theme} />
          </section>
        ))}
      </div>
      <Sources sources={slide.sources} theme={theme} />
    </div>
  );
}

function ProcessSlide({ slide, theme }) {
  const steps = slide.steps || [];
  return (
    <div className="absolute inset-0 px-12 pb-20 pt-10" style={{ backgroundColor: theme.card }}>
      <h2 className="mb-8 text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
      <ol className="grid gap-4" style={{ gridTemplateColumns: 'repeat(' + Math.max(1, steps.length) + ', minmax(0, 1fr))' }}>
        {steps.map((step, index) => (
          <li key={step.title || index} className="rounded-lg border p-5" style={{ borderColor: theme.border, backgroundColor: theme.page }}>
            <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold" style={{ backgroundColor: KNAUF.brand.cyanBlue, color: KNAUF.ink.primary }}>
              {index + 1}
            </span>
            <h3 className="text-lg font-semibold" style={{ color: theme.heading }}>{step.title}</h3>
            {step.text ? <p className="mt-2 text-sm leading-relaxed" style={{ color: theme.text }}>{step.text}</p> : null}
          </li>
        ))}
      </ol>
      <Sources sources={slide.sources} theme={theme} />
    </div>
  );
}

function ChartSlide({ slide, theme }) {
  const series = slide.series || [];
  return (
    <div className="absolute inset-0 px-12 pb-20 pt-9" style={{ backgroundColor: theme.card }}>
      <h2 className="text-3xl font-semibold" style={{ color: theme.heading }}>{slide.title}</h2>
      {slide.subtitle ? <p className="mt-1 text-sm" style={{ color: theme.muted }}>{slide.subtitle}</p> : null}
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={slide.data || []} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis dataKey={slide.categoryKey || 'name'} tick={{ fill: theme.muted, fontSize: 13 }} stroke={theme.grid} />
            <YAxis tick={{ fill: theme.muted, fontSize: 13 }} stroke={theme.grid} />
            <Tooltip contentStyle={{ backgroundColor: theme.card, border: '1px solid ' + theme.border, borderRadius: 8, color: theme.text }} />
            <Legend formatter={(value) => <span style={{ color: theme.text }}>{value}</span>} />
            {series.map((entry, index) => (
              <Bar key={entry.key} dataKey={entry.key} name={entry.label || entry.key} fill={theme.palette[index % theme.palette.length]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Sources sources={slide.sources} theme={theme} />
    </div>
  );
}

function Slide({ slide, theme }) {
  if (slide.type === 'title') return <TitleSlide slide={slide} />;
  if (slide.type === 'section') return <SectionSlide slide={slide} theme={theme} />;
  if (slide.type === 'columns') return <ColumnsSlide slide={slide} theme={theme} />;
  if (slide.type === 'process') return <ProcessSlide slide={slide} theme={theme} />;
  if (slide.type === 'chart') return <ChartSlide slide={slide} theme={theme} />;
  return <BulletsSlide slide={slide} theme={theme} />;
}

function KnaufSlideDeck({ slides = [], deckLabel = 'Knauf', footerLabel = 'Knauf Digital' }) {
  const theme = useKnaufTheme(useOsDarkMode());
  const [index, setIndex] = useState(0);
  const total = Math.max(1, slides.length);
  const slide = slides[index] || { type: 'section', title: 'No slides supplied' };
  const go = useCallback((delta) => setIndex((current) => Math.min(total - 1, Math.max(0, current + delta))), [total]);

  useEffect(() => {
    if (index >= total) setIndex(total - 1);
  }, [index, total]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go]);

  return (
    <div data-knauf-artifact-kind="slides" data-knauf-export-pages={total} className="min-h-screen w-full" style={{ backgroundColor: theme.page, color: theme.text }}>
      <header className="w-full border-b px-6 py-5" style={{ backgroundColor: KNAUF.surface.card, borderColor: KNAUF.surface.border }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-8">
          <KnaufWordmark height={22} fill={KNAUF.brand.logoCyan} />
          <span className="truncate text-sm font-medium" style={{ color: KNAUF.ink.heading }}>{deckLabel}</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg border shadow-sm" style={{ borderColor: theme.border }} aria-live="polite">
          <Slide slide={slide} theme={theme} />
          <footer className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t px-6 py-4 text-sm" style={{ borderTopColor: theme.border, backgroundColor: theme.card, color: theme.muted }}>
            <span>{footerLabel}</span>
            <span>Slide {index + 1}</span>
          </footer>
        </div>

        <nav className="mt-4 flex items-center justify-between" aria-label="Slide navigation">
          <button type="button" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous slide" className="flex items-center gap-1 rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-40" style={{ backgroundColor: theme.card, color: theme.heading, borderColor: theme.border }}>
            <ChevronLeft size={18} aria-hidden="true" /> Previous
          </button>
          <span className="text-sm font-semibold" style={{ color: theme.text }}>{index + 1} / {total}</span>
          <button type="button" data-knauf-export-next onClick={() => go(1)} disabled={index === total - 1} aria-label="Next slide" className="flex items-center gap-1 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40" style={{ backgroundColor: KNAUF.brand.cyanBlue, color: KNAUF.ink.primary }}>
            Next <ChevronRight size={18} aria-hidden="true" />
          </button>
        </nav>
      </main>
    </div>
  );
}

export { KnaufSlideDeck };
`;

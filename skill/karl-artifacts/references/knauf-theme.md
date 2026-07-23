# Knauf brand theme — token source for KARL artifacts

## When to use this template

Read this file first, on **every** Knauf-branded artifact. It is not a page you render as-is — it is the single source of the Knauf/KARL design tokens and the rules for applying them under the Sandpack constraints. Every other template (report, dashboard, slides) copy-pastes the `KNAUF` token object and the `KnaufHeader` snippet from here, then builds its own layout on top. Default to the **light** brand look for deliverables (reports, slides); make interactive dashboards theme-aware by swapping `categoricalLight → categoricalDark` and the light surfaces for dark ones.

## Brand at a glance

- **Primary** — Knauf Cerulean `#0099DE`. Buttons, primary chart series, active accents.
- **Structure** — Regal Blue `#003778`. Headings, the top brand bar, structural rules.
- **Soft accent** — Shakespeare `#55B7DA`. Tints, hover fills, quiet callout backgrounds.
- **Text** — ink `#0F1A2A` body, muted `#5B6770` captions/secondary.
- **Surface** — white `#FFFFFF` cards on a `#F4F8FB` page, `#DCE6EE` borders.
- **Wordmark, never a logo image.** External images are blocked, so render the brand as styled **text** ("KARL" bold + "by Knauf" muted) inside a colored bar. No `<img>` logo, ever.

## Typography

- **Font:** rely on the system UI font — no external fonts, no `@font-face`. The Sandpack default stack is fine; do not import Inter/Roboto/etc.
- **Headings:** Regal Blue `#003778` via `style={{ color: KNAUF.brand.regalBlue }}`, weight `font-semibold`/`font-bold` (600–700). Type scale with Tailwind classes only: page title `text-2xl`, section `text-lg`/`text-xl`, card title `text-base font-semibold`.
- **Body:** ink `#0F1A2A`. **Captions / secondary / axis labels:** muted `#5B6770` at `text-sm`/`text-xs`.

## Layout defaults

- Page: `min-h-screen p-6` with `max-w-4xl` (reports) or `max-w-5xl` (dashboards) and `mx-auto`.
- Cards: `rounded-xl border p-5` with `borderColor: KNAUF.surface.border` and `backgroundColor: KNAUF.surface.light` inline (border color is a brand token, so it goes inline, not in a Tailwind class).
- Rhythm: consistent `gap-4`/`gap-6`, `space-y-4`, grids via `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3`.

## Apply-under-constraint rules (read twice)

- **Brand color → inline `style={{}}`, a recharts `fill`/`stroke`/`color` prop, or the `KNAUF` const.** Never a Tailwind arbitrary value. `bg-[#0099DE]`, `text-[#003778]`, `h-[600px]`, `text-[13px]` are all forbidden and blank the preview.
- **Tailwind = layout, spacing, typographic scale only** (`flex`, `grid`, `gap-4`, `p-6`, `rounded-xl`, `text-lg`, `font-semibold`). Any color that is a Knauf hex comes from a token, applied inline or via a chart prop.
- **Every `<ResponsiveContainer>` sits in a parent with an explicit height class** (`h-72 w-full`, `h-80 w-full`). No `%`-only height parents.
- **Identity is never by color alone** — always a `<Legend />` and/or direct labels. Reserve status colors for good/warn/serious/critical; never use them as an ordinary data series.
- **No network, no external images.** Data is a `const DATA = [...]`; images are `/api/placeholder/{w}/{h}` only.

## Chart color rules

- Assign `KNAUF.categoricalLight` in **fixed order** by series index — `palette[i % palette.length]` — never sorted by rank or value, so a series keeps its color across renders.
- Always render a `Legend` and/or labels; color is decoration, not the key.
- Use `KNAUF.sequentialCerulean` (light→dark) for a single magnitude dimension (choropleth, heat, one-metric ramp), not for unrelated categories.
- Keep `KNAUF.status` for state only (success/warning/serious/critical). Amber `#C98A00` and the amber↔red pair must always carry a visible label — the layouts here already do.
- **Dark mode:** swap `categoricalLight → categoricalDark`, `surface.light → surface.dark`, `surface.border → surface.darkBorder`, and ink to `ink.onDark`. Drive it off a single `dark` boolean or `window.matchMedia('(prefers-color-scheme: dark)')` and pass the chosen palette down.

## Light / dark note

Deliverables (report, slides) may commit to the light look and ignore dark. Interactive dashboards should be theme-aware: pick `pal = dark ? KNAUF.categoricalDark : KNAUF.categoricalLight` once, choose surfaces/ink/border from the matching token group, and pass them into both Tailwind-free inline styles and recharts props. Maintain WCAG contrast in both themes — ink `#0F1A2A` on white and `#E6EEF5` on `#0F1720` both clear AA.

## Copy-paste tokens + `KnaufHeader`

The block below is a complete, self-contained showcase file: the full `KNAUF` token object, the theme picker, the text-wordmark `KnaufHeader`, and a minimal card + chart demonstrating fixed categorical order with a legend. Copy the `KNAUF` const and `KnaufHeader` verbatim into any template.

```tsx
import { useMemo } from 'react';
import { format } from 'date-fns';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ── 1) KNAUF TOKENS — copy verbatim into every Knauf template ────────────────
const KNAUF = {
  brand: {
    cerulean: '#0099DE',
    regalBlue: '#003778',
    shakespeare: '#55B7DA',
    appDarkBlue: '#213A75',
  },
  ink: {
    primary: '#0F1A2A',
    secondary: '#3A4A5C',
    muted: '#5B6770',
    onDark: '#E6EEF5',
    mutedOnDark: '#9FB0BF',
  },
  surface: {
    light: '#FFFFFF',
    lightAlt: '#F4F8FB',
    border: '#DCE6EE',
    dark: '#0F1720',
    darkAlt: '#16212E',
    darkBorder: '#26333F',
  },
  categoricalLight: [
    '#0099DE',
    '#E86D1F',
    '#009E86',
    '#7A4FB5',
    '#D64550',
    '#C98A00',
    '#C43A8B',
  ],
  categoricalDark: [
    '#1C9CDB',
    '#C56420',
    '#12A78E',
    '#895FC4',
    '#DA5561',
    '#B8860B',
    '#C94E97',
  ],
  sequentialCerulean: [
    '#E5F3FB',
    '#B3DCF3',
    '#66BCE8',
    '#0099DE',
    '#0077B0',
    '#00527A',
  ],
  status: {
    success: '#1F883D',
    warning: '#C98A00',
    serious: '#E8792A',
    critical: '#D64550',
  },
};

// ── 2) THEME PICKER — one place to resolve palette + surfaces per mode ───────
function useKnaufTheme(dark: boolean) {
  return useMemo(
    () => ({
      palette: dark ? KNAUF.categoricalDark : KNAUF.categoricalLight,
      surface: dark ? KNAUF.surface.dark : KNAUF.surface.light,
      surfaceAlt: dark ? KNAUF.surface.darkAlt : KNAUF.surface.lightAlt,
      border: dark ? KNAUF.surface.darkBorder : KNAUF.surface.border,
      text: dark ? KNAUF.ink.onDark : KNAUF.ink.primary,
      muted: dark ? KNAUF.ink.mutedOnDark : KNAUF.ink.muted,
      heading: dark ? KNAUF.ink.onDark : KNAUF.brand.regalBlue,
    }),
    [dark],
  );
}

// ── 3) KnaufHeader — TEXT wordmark in a Regal Blue bar (never an <img> logo) ─
function KnaufHeader({
  title,
  showDate = true,
}: {
  title?: string;
  showDate?: boolean;
}) {
  return (
    <header
      className="flex items-center justify-between rounded-xl px-5 py-4"
      style={{ backgroundColor: KNAUF.brand.regalBlue }}
    >
      <div className="flex items-center gap-3">
        {/* Cerulean accent stripe stands in for a logo mark */}
        <span
          className="inline-block h-6 w-1.5 rounded-full"
          style={{ backgroundColor: KNAUF.brand.cerulean }}
        />
        <div className="flex items-baseline gap-2">
          <span
            className="text-xl font-bold tracking-tight"
            style={{ color: '#FFFFFF' }}
          >
            KARL
          </span>
          <span
            className="text-sm font-medium"
            style={{ color: KNAUF.brand.shakespeare }}
          >
            by Knauf
          </span>
        </div>
        {title ? (
          <span
            className="ml-3 border-l pl-3 text-sm"
            style={{ color: KNAUF.ink.onDark, borderColor: 'rgba(230,238,245,0.3)' }}
          >
            {title}
          </span>
        ) : null}
      </div>
      {showDate ? (
        <time className="text-sm" style={{ color: KNAUF.ink.onDark }}>
          {format(new Date(), 'd MMM yyyy')}
        </time>
      ) : null}
    </header>
  );
}

// ── 4) Demo data (never fetched — always a const) ────────────────────────────
const DATA = [
  { quarter: 'Q1', boards: 42, plaster: 28, insulation: 19 },
  { quarter: 'Q2', boards: 51, plaster: 30, insulation: 24 },
  { quarter: 'Q3', boards: 48, plaster: 34, insulation: 27 },
  { quarter: 'Q4', boards: 60, plaster: 39, insulation: 31 },
];

// Fixed categorical order — series index maps to palette index, never rank.
const SERIES = [
  { key: 'boards', label: 'Boards' },
  { key: 'plaster', label: 'Plaster' },
  { key: 'insulation', label: 'Insulation' },
];

// ── 5) Showcase — the single export default ──────────────────────────────────
export default function KnaufThemeShowcase() {
  const dark = false; // deliverable: light. Dashboards: derive from prefers-color-scheme.
  const t = useKnaufTheme(dark);

  return (
    <div
      className="min-h-screen p-6"
      style={{ backgroundColor: t.surfaceAlt, color: t.text }}
    >
      <div className="mx-auto max-w-5xl space-y-6">
        <KnaufHeader title="Theme reference" />

        <section
          className="rounded-xl border p-5"
          style={{ backgroundColor: t.surface, borderColor: t.border }}
        >
          <h1
            className="text-2xl font-bold"
            style={{ color: t.heading }}
          >
            Sales by product line
          </h1>
          <p className="mt-1 text-sm" style={{ color: t.muted }}>
            Categorical palette applied in fixed order; identity carried by the legend.
          </p>

          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DATA} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={t.border} vertical={false} />
                <XAxis dataKey="quarter" stroke={t.muted} tick={{ fill: t.muted }} />
                <YAxis stroke={t.muted} tick={{ fill: t.muted }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: t.surface,
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    color: t.text,
                  }}
                />
                <Legend />
                {SERIES.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={t.palette[i % t.palette.length]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            { label: 'On track', value: '86%', tone: KNAUF.status.success },
            { label: 'At risk', value: '9%', tone: KNAUF.status.warning },
            { label: 'Blocked', value: '5%', tone: KNAUF.status.critical },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-xl border p-5"
              style={{ backgroundColor: t.surface, borderColor: t.border }}
            >
              <div className="text-sm" style={{ color: t.muted }}>
                {kpi.label}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: kpi.tone }}
                />
                <span className="text-2xl font-bold" style={{ color: t.text }}>
                  {kpi.value}
                </span>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
```

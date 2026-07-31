# Report artifact template (Knauf-brand)

## When to use this template

Use this when the user wants a **static analytical deliverable** — a findings report,
a monthly/quarterly review, an executive summary with a few KPIs, one chart, and a
findings table. It is a *deliverable*, not an interactive dashboard. It follows the
viewer's OS light/dark preference and routes every colour through the theme; there is
no visible toggle, because a deliverable is read, not operated. If the user wants
filters, tabs, live data, or drill-down, reach for the dashboard template instead.

Adapt it by swapping `DATA`, the KPI tiles, the chart type (bar↔line), and the table
rows. Keep the top-to-bottom order: **brand bar → title → executive summary → KPI
row → one chart → findings table → footer.**

## Before you write

Read `skills/karl-brand/SKILL.md` for what the tokens mean, then start the artifact
with the import below — the module is mounted in every preview, so nothing is pasted:

```tsx
import { KNAUF, useKnaufTheme, KnaufWordmark } from '/knauf/brand';
```

**The code below assumes that import and introduces no colour that is not already in
the `KNAUF` const.**

## Tokens this layout uses

| Token | Styles |
|---|---|
| `KNAUF.brand.accessibleBlue` | the top brand bar field |
| `theme.heading` | h1, card titles, table headers, KPI values |
| `theme.text` / `theme.muted` | body copy / captions, axis labels, footer |
| `theme.card` / `theme.page` / `theme.border` | card fill / page fill / hairlines |
| `theme.palette[i]` | chart series, by index |
| `theme.grid` | gridlines, axis strokes |
| `KNAUF.ink.accentOnBrand` | the eyebrow label on the brand bar |
| `KNAUF.status[tone]` | KPI delta icon, status chip ring + dot; text stays ink |

## Brand + layout guidance

- The brand mark is `<KnaufWordmark fill="#FFFFFF" />` in the `accessibleBlue` bar,
  with the report kind as a **separate** eyebrow label on the right. Never fuse
  naming into the mark; never use an `<img>`. Bar padding and the gap to other
  content are at least the 26px mark height.
- Headings and structural type read from `theme.heading`, never from
  `KNAUF.brand.accessibleBlue` directly — that hex is 1.56:1 on a dark surface.
- KPI deltas keep their text in `theme.text`; the lucide arrow carries the status
  colour, so small text stays readable in both modes and meaning never rests on colour.
- Status chips are **ink on a light fill with a status-coloured ring and dot**. Do not
  put white text on a status fill: white-on-warning is 2.95:1 and white-on-serious
  2.92:1, both failing AA.
- The chart assigns `theme.palette` in **fixed index order** (series 0 → `palette[0]`),
  always ships a `<Legend>`, axis labels and a `<Tooltip>`, and its
  `<ResponsiveContainer>` lives inside an `h-80 w-full` parent. Status colours are
  never a data series.
- **The `<Legend>` needs a `formatter`.** Recharts paints legend label text in the
  series colour by default, and `wrapperStyle` does not override it — the per-item
  span wins. At `text-xs` that puts 3.2:1 text on the page. Force `theme.text`.
- Use `border` + subtle `page` fills rather than shadows for structure — it prints.

```tsx
import { KNAUF, useKnaufTheme, KnaufWordmark } from '/knauf/brand';
import { useMemo } from 'react';
import { format } from 'date-fns';
import { ArrowUpRight, ArrowDownRight, ShieldCheck } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '/components/ui/table';
import { Separator } from '/components/ui/separator';

// Chart series in FIXED palette order. Swap keys/labels for your report.
const SERIES = [
  { key: 'onboarded', label: 'Users onboarded' },
  { key: 'activated', label: 'Active users' },
];
const DATA = [
  { month: 'Jan', onboarded: 420, activated: 288 },
  { month: 'Feb', onboarded: 510, activated: 355 },
  { month: 'Mar', onboarded: 604, activated: 441 },
  { month: 'Apr', onboarded: 688, activated: 523 },
  { month: 'May', onboarded: 742, activated: 601 },
  { month: 'Jun', onboarded: 815, activated: 690 },
];
const KPIS = [
  { label: 'Total onboarded', value: '3,779', delta: '+18.4%', dir: 'up', tone: 'success' },
  { label: 'Active users', value: '2,898', delta: '+22.1%', dir: 'up', tone: 'success' },
  { label: 'Avg. weekly prompts', value: '11.6', delta: '+3.9%', dir: 'up', tone: 'success' },
  { label: 'Support tickets', value: '47', delta: '-12.5%', dir: 'down', tone: 'success' },
];
const FINDINGS = [
  { area: 'Adoption', detail: 'Activation rate climbed to 84.6% of onboarded users.', status: 'On track', tone: 'success' },
  { area: 'Engagement', detail: 'Weekly prompt volume up quarter-over-quarter across all teams.', status: 'On track', tone: 'success' },
  { area: 'Document Q&A', detail: 'CSV ingestion errors elevated; retry UX shipping next release.', status: 'Watch', tone: 'warning' },
  { area: 'Reliability', detail: 'One MCP visibility reset traced to config persistence gap.', status: 'Action needed', tone: 'serious' },
];

/** Ink on a tint, with a status ring + dot — never colour alone, never white on fill. */
function StatusChip({ tone, children, theme }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ color: theme.text, backgroundColor: theme.card, borderColor: KNAUF.status[tone] }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: KNAUF.status[tone] }}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export default function KnaufReport() {
  // Follow the viewer's OS preference. No toggle: a report is read, not operated.
  const dark = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
    [],
  );
  const theme = useKnaufTheme(dark);
  const generatedOn = format(new Date(), 'MMMM d, yyyy');

  return (
    <div className="min-h-full w-full" style={{ backgroundColor: theme.page, color: theme.text }}>
      <header
        className="w-full px-7 py-7 md:px-10"
        style={{ backgroundColor: KNAUF.brand.accessibleBlue }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-7">
          <KnaufWordmark height={26} fill="#FFFFFF" />
          <span
            className="text-xs font-medium uppercase tracking-widest"
            style={{ color: KNAUF.ink.accentOnBrand }}
          >
            Analytics Report
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8 md:px-10">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl" style={{ color: theme.heading }}>
            KARL Adoption Report — H1 2026
          </h1>
          <p className="mt-1 text-sm" style={{ color: theme.muted }}>Generated {generatedOn}</p>
        </div>

        <Card style={{ backgroundColor: theme.card, borderColor: theme.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: theme.heading }}>
              Executive summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed" style={{ color: theme.text }}>
              KARL adoption accelerated through the first half of 2026, with cumulative onboarding up
              18% and active usage growing faster still as teams moved from pilots into daily
              workflows. Engagement quality improved alongside volume, and support load fell despite
              the larger user base. Two areas need attention: document ingestion reliability for CSV
              files and configuration persistence for MCP visibility across deployments.
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {KPIS.map((k) => {
            const Arrow = k.dir === 'up' ? ArrowUpRight : ArrowDownRight;
            const tone = KNAUF.status[k.tone];
            return (
              <div
                key={k.label}
                className="rounded-lg border p-4"
                style={{ backgroundColor: theme.card, borderColor: theme.border }}
              >
                <p className="text-xs font-medium uppercase tracking-wide" style={{ color: theme.muted }}>
                  {k.label}
                </p>
                <p className="mt-1 text-2xl font-bold" style={{ color: theme.heading }}>{k.value}</p>
                <p className="mt-1 flex items-center gap-1 text-sm font-semibold" style={{ color: theme.text }}>
                  <Arrow size={16} color={tone} aria-hidden="true" />{k.delta}
                </p>
              </div>
            );
          })}
        </div>

        <Card style={{ backgroundColor: theme.card, borderColor: theme.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: theme.heading }}>
              Onboarding vs. active users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={DATA} margin={{ top: 8, right: 12, left: 0, bottom: 18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: theme.muted, fontSize: 12 }}
                    stroke={theme.grid}
                    label={{ value: 'Month', position: 'insideBottom', offset: -8, fill: theme.muted, fontSize: 12 }}
                  />
                  <YAxis
                    tick={{ fill: theme.muted, fontSize: 12 }}
                    stroke={theme.grid}
                    label={{ value: 'Users', angle: -90, position: 'insideLeft', fill: theme.muted, fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: theme.card,
                      border: `1px solid ${theme.border}`,
                      color: theme.text,
                    }}
                  />
                  {/* formatter, not wrapperStyle: recharts colours legend text by series. */}
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value) => <span style={{ color: theme.text }}>{value}</span>}
                  />
                  {SERIES.map((s, i) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      name={s.label}
                      fill={theme.palette[i]}
                      radius={[3, 3, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card style={{ backgroundColor: theme.card, borderColor: theme.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: theme.heading }}>
              Key findings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ color: theme.heading }}>Area</TableHead>
                  <TableHead style={{ color: theme.heading }}>Detail</TableHead>
                  <TableHead style={{ color: theme.heading }}>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FINDINGS.map((f) => (
                  <TableRow key={f.area}>
                    <TableCell className="font-medium" style={{ color: theme.text }}>{f.area}</TableCell>
                    <TableCell style={{ color: theme.muted }}>{f.detail}</TableCell>
                    <TableCell>
                      <StatusChip tone={f.tone} theme={theme}>{f.status}</StatusChip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Separator style={{ backgroundColor: theme.border }} />
        <footer className="flex items-center gap-2 pb-4 text-xs" style={{ color: theme.muted }}>
          <ShieldCheck size={14} color={theme.muted} aria-hidden="true" />
          <span>Source: KARL platform telemetry. Knauf internal — confidential. Do not distribute externally.</span>
        </footer>
      </main>
    </div>
  );
}
```

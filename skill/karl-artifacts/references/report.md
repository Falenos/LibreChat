# Report artifact template (Knauf-brand)

## When to use this template

Use this when the user wants a **static analytical deliverable** — a findings report, a monthly/quarterly review, an executive summary with a few KPIs, one chart, and a findings table. It is a *deliverable*, not an interactive dashboard: it commits to the Knauf **light** brand look (white surface, print-friendly) and does not need a dark mode. If the user wants filters, tabs, live data, or drill-down, reach for the dashboard template instead.

Adapt it by swapping `DATA`, the KPI tiles, the chart type (bar↔line), and the table rows. Keep the top-to-bottom order: **brand bar → executive summary → KPI row → one chart → findings table → footer.**

## Brand + layout guidance

- Declare every exact hex in the single `const KNAUF = {…}` object at the top and reference it from `style={{}}` (for DOM) or recharts `fill`/`stroke`/`color` props (for the chart). Tailwind classes handle only layout, spacing, and the typography scale — **never** color and **never** bracket values.
- The brand mark is a **text wordmark** in a Regal-Blue top bar (`KNAUF` heavy + `KARL` in Cerulean) — external logo images are blocked.
- Headings/structural bars use Regal Blue `#003778`; primary accents and the first chart series use Cerulean `#0099DE`; body text is ink `#0F1A2A`, secondary text muted `#5B6770`, hairlines `#DCE6EE`.
- KPI deltas carry a lucide arrow **and** a status color (success/serious/critical) so meaning never rests on color alone.
- The chart assigns `KNAUF.categoricalLight` in **fixed index order** (series 0 → palette[0]), always ships a `<Legend>`, axis labels, and a `<Tooltip>`, and its `<ResponsiveContainer>` lives inside an `h-80 w-full` parent. Status colors are reserved for KPI deltas, never used as a data series.
- Surfaces stay light and print-friendly; use `border` + subtle `lightAlt` fills rather than shadows for structure.

```tsx
import { format } from 'date-fns';
import { ArrowUpRight, ArrowDownRight, FileBarChart2, ShieldCheck } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '/components/ui/table';
import { Badge } from '/components/ui/badge';
import { Separator } from '/components/ui/separator';

const KNAUF = {
  cerulean: '#0099DE', regalBlue: '#003778', shakespeare: '#55B7DA',
  ink: '#0F1A2A', inkSecondary: '#3A4A5C', muted: '#5B6770',
  surface: '#FFFFFF', surfaceAlt: '#F4F8FB', border: '#DCE6EE', onDark: '#E6EEF5',
  categoricalLight: ['#0099DE', '#E86D1F', '#009E86', '#7A4FB5', '#D64550', '#C98A00', '#C43A8B'],
  status: { success: '#1F883D', warning: '#C98A00', serious: '#E8792A', critical: '#D64550' },
};

// Chart series in FIXED palette order. Swap keys/values for your report.
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

export default function KnaufReport() {
  const generatedOn = format(new Date(), 'MMMM d, yyyy');
  return (
    <div className="min-h-full w-full" style={{ backgroundColor: KNAUF.surfaceAlt, color: KNAUF.ink }}>
      <header className="w-full px-6 py-5 md:px-10" style={{ backgroundColor: KNAUF.regalBlue, color: KNAUF.onDark }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FileBarChart2 size={26} color={KNAUF.shakespeare} />
            <span className="text-xl font-extrabold tracking-tight">
              KNAUF <span style={{ color: KNAUF.cerulean }}>KARL</span>
            </span>
          </div>
          <span className="text-xs font-medium uppercase tracking-widest" style={{ color: KNAUF.shakespeare }}>
            Analytics Report
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8 md:px-10">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl" style={{ color: KNAUF.regalBlue }}>
            KARL Adoption Report — H1 2026
          </h1>
          <p className="mt-1 text-sm" style={{ color: KNAUF.muted }}>Generated {generatedOn}</p>
        </div>

        <Card style={{ backgroundColor: KNAUF.surface, borderColor: KNAUF.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: KNAUF.regalBlue }}>
              Executive summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed" style={{ color: KNAUF.inkSecondary }}>
              KARL adoption accelerated through the first half of 2026, with cumulative onboarding up 18% and active usage
              growing faster still as teams moved from pilots into daily workflows. Engagement quality improved alongside
              volume, and support load fell despite the larger user base. Two areas need attention: document ingestion
              reliability for CSV files and configuration persistence for MCP visibility across deployments.
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {KPIS.map((k) => {
            const Arrow = k.dir === 'up' ? ArrowUpRight : ArrowDownRight;
            const c = KNAUF.status[k.tone];
            return (
              <div key={k.label} className="rounded-lg border p-4"
                style={{ backgroundColor: KNAUF.surface, borderColor: KNAUF.border }}>
                <p className="text-xs font-medium uppercase tracking-wide" style={{ color: KNAUF.muted }}>{k.label}</p>
                <p className="mt-1 text-2xl font-bold" style={{ color: KNAUF.regalBlue }}>{k.value}</p>
                <p className="mt-1 flex items-center gap-1 text-sm font-semibold" style={{ color: c }}>
                  <Arrow size={16} color={c} />{k.delta}
                </p>
              </div>
            );
          })}
        </div>

        <Card style={{ backgroundColor: KNAUF.surface, borderColor: KNAUF.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: KNAUF.regalBlue }}>
              Onboarding vs. active users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={DATA} margin={{ top: 8, right: 12, left: 0, bottom: 18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={KNAUF.border} vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: KNAUF.muted, fontSize: 12 }} stroke={KNAUF.border}
                    label={{ value: 'Month', position: 'insideBottom', offset: -8, fill: KNAUF.muted, fontSize: 12 }} />
                  <YAxis tick={{ fill: KNAUF.muted, fontSize: 12 }} stroke={KNAUF.border}
                    label={{ value: 'Users', angle: -90, position: 'insideLeft', fill: KNAUF.muted, fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: KNAUF.surface, border: `1px solid ${KNAUF.border}`, color: KNAUF.ink }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: KNAUF.inkSecondary }} />
                  {SERIES.map((s, i) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label}
                      fill={KNAUF.categoricalLight[i]} radius={[3, 3, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card style={{ backgroundColor: KNAUF.surface, borderColor: KNAUF.border }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold" style={{ color: KNAUF.regalBlue }}>
              Key findings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead style={{ color: KNAUF.regalBlue }}>Area</TableHead>
                  <TableHead style={{ color: KNAUF.regalBlue }}>Detail</TableHead>
                  <TableHead style={{ color: KNAUF.regalBlue }}>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FINDINGS.map((f) => (
                  <TableRow key={f.area}>
                    <TableCell className="font-medium" style={{ color: KNAUF.ink }}>{f.area}</TableCell>
                    <TableCell style={{ color: KNAUF.inkSecondary }}>{f.detail}</TableCell>
                    <TableCell>
                      <Badge style={{ backgroundColor: KNAUF.status[f.tone], color: '#FFFFFF' }}>{f.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Separator style={{ backgroundColor: KNAUF.border }} />
        <footer className="flex items-center gap-2 pb-4 text-xs" style={{ color: KNAUF.muted }}>
          <ShieldCheck size={14} color={KNAUF.muted} />
          <span>Source: KARL platform telemetry. Knauf internal — confidential. Do not distribute externally.</span>
        </footer>
      </main>
    </div>
  );
}
```

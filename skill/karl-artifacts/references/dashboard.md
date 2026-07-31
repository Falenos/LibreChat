# KPI Dashboard template

## When to use this template

Reach for this when the artifact is an **interactive analytics dashboard**: a brand
header, a filter row (time range) that drives `useState`, a row of KPI stat-tiles, and
three recharts panels (indexed trend, category breakdown, share donut). It is the
right skeleton whenever the ask is "show me metrics over time with filters and
charts." For a static print report or slides, prefer those templates. This one ships
a visible dark toggle, initialised from the viewer's OS preference.

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
| `KNAUF.brand.accessibleBlue` | the header bar field |
| `KNAUF.brand.cyanBlue` | KPI tile icons |
| `KNAUF.ink.accentOnBrand` | header subtitle, dark-toggle label |
| `theme.text` / `theme.muted` | values, titles / labels, axes |
| `theme.card` / `theme.page` / `theme.border` | tile + panel fill / page / hairlines |
| `theme.palette[i]` | chart series, by index |
| `theme.grid` | gridlines |
| `KNAUF.status.success` | KPI delta dot; delta text stays readable ink |

## Brand + layout guidance

- **The real wordmark** — `<KnaufWordmark fill="#FFFFFF" />` on the `accessibleBlue`
  header, with "Performance Dashboard" as separate text beside it. Padding and the
  gap to that label are at least the 24px mark height.
- **One palette, both modes.** The chart steps are validated on the light *and* dark
  surface, so there is no palette swap — only surfaces and ink change. Everything
  routes through `useKnaufTheme(dark)`.
- **Never two y-scales, and never two measures of different magnitude on one.**
  Revenue (€128–233M) and orders (940–1,640) on a shared axis would flatten revenue
  into the baseline. The trend panel therefore **indexes both to 100 at the first
  month in range**, which is comparable, honest, and needs one axis. The raw values
  stay available in the tooltip.
- **Charts.** Every `<ResponsiveContainer>` sits in a parent with an explicit height
  (`h-64`/`h-72 w-full`). Assign the palette in **fixed index order** — never
  rank-driven, never cycled. Every chart has a `<Tooltip>` and a `<Legend>`.
- **Recharts paints chart text in the series colour unless you stop it**, and
  `wrapperStyle` is not enough — the per-item span wins. Two overrides are mandatory:
  a `<Legend formatter>` that wraps the label in `theme.text`, and a `<Pie label>` that
  returns a `<text fill={theme.text}>` element rather than a bare string (a string
  inherits the slice's `<Cell>` fill). Both would otherwise put 3.2–3.9:1 text on the
  page, which is the rule in `charts.md` broken by the library's default.
- **The per-`Cell` bar colouring is only legitimate here** because each bar is already
  named by its axis tick — otherwise it is colour carrying no identity.
- **Keep the donut to four or five slices** with direct labels, so identity never
  rests on colour.
- **Grid.** `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` — KPI tiles span single cells;
  charts span 2 or 4 columns via `md:col-span-2` / `lg:col-span-2`.
- Status colours are reserved for state, never a data series or small-text colour.
  KPI delta text uses `theme.text`; a status-coloured dot carries the accent.

```tsx
import { KNAUF, useKnaufTheme, KnaufWordmark } from '/knauf/brand';
import { useState, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { TrendingUp, ShoppingCart, DollarSign, Percent } from 'lucide-react';
import { Card } from '/components/ui/card';
import { Switch } from '/components/ui/switch';
import { Label } from '/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '/components/ui/toggle-group';

const DATA = {
  months: [
    { m: 'Jan', revenue: 128, orders: 940, conv: 3.1 }, { m: 'Feb', revenue: 141, orders: 1010, conv: 3.4 },
    { m: 'Mar', revenue: 137, orders: 990, conv: 3.2 }, { m: 'Apr', revenue: 156, orders: 1120, conv: 3.6 },
    { m: 'May', revenue: 169, orders: 1205, conv: 3.8 }, { m: 'Jun', revenue: 162, orders: 1180, conv: 3.7 },
    { m: 'Jul', revenue: 178, orders: 1290, conv: 4.0 }, { m: 'Aug', revenue: 185, orders: 1330, conv: 4.1 },
    { m: 'Sep', revenue: 174, orders: 1260, conv: 3.9 }, { m: 'Oct', revenue: 197, orders: 1410, conv: 4.3 },
    { m: 'Nov', revenue: 214, orders: 1520, conv: 4.6 }, { m: 'Dec', revenue: 233, orders: 1640, conv: 4.9 },
  ],
  breakdown: [
    { name: 'Boards', value: 420 }, { name: 'Plaster', value: 310 }, { name: 'Insulation', value: 265 },
    { name: 'Ceilings', value: 190 }, { name: 'Tools', value: 120 },
  ],
  share: [
    { name: 'DACH', value: 44 }, { name: 'Western EU', value: 27 },
    { name: 'Eastern EU', value: 18 }, { name: 'Rest of World', value: 11 },
  ],
};

const RANGES = { '3M': 3, '6M': 6, '12M': 12 };

export default function KnaufKpiDashboard() {
  const [range, setRange] = useState('6M');
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
  );
  const theme = useKnaufTheme(dark);

  const months = useMemo(() => DATA.months.slice(-RANGES[range]), [range]);

  // Two measures of different magnitude share one axis only when indexed to a
  // common base. Base = the first month in range = 100.
  const indexed = useMemo(() => {
    const base = months[0];
    if (!base) return [];
    return months.map((r) => ({
      m: r.m,
      revenueIdx: (r.revenue / base.revenue) * 100,
      ordersIdx: (r.orders / base.orders) * 100,
      revenue: r.revenue,
      orders: r.orders,
    }));
  }, [months]);

  const kpis = useMemo(() => {
    const rev = months.reduce((s, r) => s + r.revenue, 0);
    const ord = months.reduce((s, r) => s + r.orders, 0);
    const conv = months.reduce((s, r) => s + r.conv, 0) / months.length;
    return [
      { label: 'Revenue', value: `€${rev.toFixed(0)}M`, delta: '+8.4%', Icon: DollarSign },
      { label: 'Orders', value: ord.toLocaleString(), delta: '+5.1%', Icon: ShoppingCart },
      { label: 'Avg. Order', value: `€${((rev * 1000) / ord).toFixed(1)}k`, delta: '+3.2%', Icon: TrendingUp },
      { label: 'Conversion', value: `${conv.toFixed(1)}%`, delta: '+0.4pp', Icon: Percent },
    ];
  }, [months]);

  const tooltipStyle = {
    backgroundColor: theme.card,
    border: `1px solid ${theme.border}`,
    borderRadius: 8,
    color: theme.text,
  };

  // Recharts paints legend label text in the series colour, and `wrapperStyle`
  // loses to the per-item span. A formatter is the only override that holds.
  const legendInk = useCallback(
    (value) => <span style={{ color: theme.text }}>{value}</span>,
    [theme.text],
  );

  // Same trap on Pie: a label function returning a bare string inherits the
  // slice's <Cell> fill. Return an element and set `fill` explicitly.
  const renderShareLabel = useCallback(
    ({ name, percent, x, y, textAnchor }) => (
      <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central"
        fill={theme.text} fontSize={12}>
        {`${name} ${(percent * 100).toFixed(0)}%`}
      </text>
    ),
    [theme.text],
  );

  return (
    <div className="min-h-screen w-full p-6" style={{ backgroundColor: theme.page, color: theme.text }}>
      <div
        className="mb-5 flex items-center justify-between rounded-lg px-6 py-6"
        style={{ backgroundColor: KNAUF.brand.accessibleBlue }}
      >
        <div className="flex items-center gap-6">
          <KnaufWordmark height={24} fill="#FFFFFF" />
          <span className="text-sm font-medium" style={{ color: KNAUF.ink.accentOnBrand }}>
            Performance Dashboard
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="dark" className="text-xs" style={{ color: KNAUF.ink.accentOnBrand }}>Dark</Label>
          <Switch id="dark" checked={dark} onCheckedChange={setDark} />
        </div>
      </div>

      <div className="mb-5 flex items-center gap-3">
        <span className="text-sm font-medium" style={{ color: theme.muted }}>Time range</span>
        <ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v)}>
          {Object.keys(RANGES).map((r) => (
            <ToggleGroupItem key={r} value={r} className="px-4">{r}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ label, value, delta, Icon }) => (
          <Card key={label} className="p-4" style={{ backgroundColor: theme.card, borderColor: theme.border }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: theme.muted }}>{label}</span>
              <Icon size={18} style={{ color: KNAUF.brand.cyanBlue }} aria-hidden="true" />
            </div>
            <div className="mt-2 text-2xl font-bold" style={{ color: theme.text }}>{value}</div>
            <div className="mt-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.text }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: KNAUF.status.success }} aria-hidden="true" />
              {delta} vs prior period
            </div>
          </Card>
        ))}

        <Card
          className="p-4 md:col-span-2 lg:col-span-2"
          style={{ backgroundColor: theme.card, borderColor: theme.border }}
        >
          <h3 className="text-sm font-semibold" style={{ color: theme.text }}>Revenue &amp; orders trend</h3>
          <p className="mb-3 text-xs" style={{ color: theme.muted }}>
            Indexed to 100 at {indexed[0]?.m ?? '—'}
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={indexed} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} />
                <XAxis dataKey="m" stroke={theme.grid} tick={{ fill: theme.muted, fontSize: 12 }} />
                <YAxis stroke={theme.grid} tick={{ fill: theme.muted, fontSize: 12 }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value, name, entry) =>
                    name === 'Revenue'
                      ? [`${value.toFixed(1)} (€${entry.payload.revenue}M)`, name]
                      : [`${value.toFixed(1)} (${entry.payload.orders.toLocaleString()})`, name]
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
                <Line type="monotone" dataKey="revenueIdx" name="Revenue" stroke={theme.palette[0]} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="ordersIdx" name="Orders" stroke={theme.palette[1]} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          className="p-4 md:col-span-2 lg:col-span-2"
          style={{ backgroundColor: theme.card, borderColor: theme.border }}
        >
          <h3 className="mb-3 text-sm font-semibold" style={{ color: theme.text }}>Revenue by product line</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DATA.breakdown} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
                <XAxis dataKey="name" stroke={theme.grid} tick={{ fill: theme.muted, fontSize: 12 }} />
                <YAxis stroke={theme.grid} tick={{ fill: theme.muted, fontSize: 12 }} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: theme.page }} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
                <Bar dataKey="value" name="Revenue (€M)" radius={[4, 4, 0, 0]}>
                  {DATA.breakdown.map((d, i) => <Cell key={d.name} fill={theme.palette[i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          className="p-4 md:col-span-2 lg:col-span-4"
          style={{ backgroundColor: theme.card, borderColor: theme.border }}
        >
          <h3 className="mb-3 text-sm font-semibold" style={{ color: theme.text }}>Regional share</h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendInk} />
                <Pie
                  data={DATA.share}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  label={renderShareLabel}
                >
                  {DATA.share.map((d, i) => <Cell key={d.name} fill={theme.palette[i]} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
```

---
# KPI Dashboard template

## When to use this template

Reach for this when the artifact is an **interactive analytics dashboard**: a header wordmark bar, a filter row (time range) that drives `useState`, a row of KPI stat-tiles, and three recharts panels (trend line, category breakdown bars, share donut). It is the right skeleton whenever the ask is "show me metrics over time with filters and charts." For a static print report or slides, prefer the report template instead — those may commit to the light look, whereas this dashboard supports the viewer's dark theme via a `dark` toggle.

## Brand + layout guidance

- **One token object.** Every exact hex lives in `const KNAUF`. Never hardcode a color anywhere else — charts read from it via `fill`/`stroke` props, surfaces via `style={{}}`. Tailwind classes handle *only* layout/spacing/type scale (`grid`, `gap-4`, `p-4`, `h-72`, `text-sm`). No bracket/arbitrary values, ever.
- **Wordmark, not a logo image.** External images are blocked, so the brand is a styled TEXT wordmark ("KARL") in a Regal-Blue top bar. Do not attempt an `<img>` logo.
- **Light default, dark-capable.** Start light (white surface, Cerulean primary). The `dark` Switch swaps surfaces to `KNAUF.surface.dark*` and the chart palette to `KNAUF.categoricalDark`. Keep both readable.
- **Charts.** Every `<ResponsiveContainer>` sits in a parent with an explicit height utility (`h-64`/`h-72 w-full`). Assign the categorical palette in **fixed index order** — never rank/cycle. Every chart has a `<Tooltip>` and a `<Legend>`; pie slices carry text labels so identity is never by color alone. Status colors (`success`/`warning`/`serious`/`critical`) are reserved for state, never a data series.
- **Grid.** `grid-cols-1 md:grid-cols-2 lg:grid-cols-4` — KPI tiles span single cells; charts span 2 or 4 columns via `md:col-span-2` / `lg:col-span-2`.

```tsx
import { useState, useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { TrendingUp, ShoppingCart, DollarSign, Percent } from 'lucide-react';
import { Card } from '/components/ui/card';
import { Switch } from '/components/ui/switch';
import { Label } from '/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '/components/ui/toggle-group';

const KNAUF = {
  brand: { cerulean: '#0099DE', regalBlue: '#003778', shakespeare: '#55B7DA' },
  ink: { primary: '#0F1A2A', muted: '#5B6770', mutedOnDark: '#9FB0BF', onDark: '#E6EEF5' },
  surface: {
    light: '#FFFFFF', lightAlt: '#F4F8FB', border: '#DCE6EE',
    dark: '#0F1720', darkAlt: '#16212E', darkBorder: '#26333F',
  },
  categoricalLight: ['#0099DE', '#E86D1F', '#009E86', '#7A4FB5', '#D64550', '#C98A00', '#C43A8B'],
  categoricalDark: ['#1C9CDB', '#C56420', '#12A78E', '#895FC4', '#DA5561', '#B8860B', '#C94E97'],
  status: { success: '#1F883D', warning: '#C98A00', serious: '#E8792A', critical: '#D64550' },
};

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
  const [dark, setDark] = useState(false);

  const months = useMemo(() => DATA.months.slice(-RANGES[range]), [range]);
  const palette = dark ? KNAUF.categoricalDark : KNAUF.categoricalLight;

  const kpis = useMemo(() => {
    const rev = months.reduce((s, r) => s + r.revenue, 0);
    const ord = months.reduce((s, r) => s + r.orders, 0);
    const conv = months.reduce((s, r) => s + r.conv, 0) / months.length;
    return [
      { label: 'Revenue', value: `€${rev.toFixed(0)}M`, delta: '+8.4%', Icon: DollarSign },
      { label: 'Orders', value: ord.toLocaleString(), delta: '+5.1%', Icon: ShoppingCart },
      { label: 'Avg. Order', value: `€${(rev * 1000 / ord).toFixed(1)}k`, delta: '+3.2%', Icon: TrendingUp },
      { label: 'Conversion', value: `${conv.toFixed(1)}%`, delta: '+0.4pp', Icon: Percent },
    ];
  }, [months]);

  const surface = dark ? KNAUF.surface.darkAlt : KNAUF.surface.light;
  const border = dark ? KNAUF.surface.darkBorder : KNAUF.surface.border;
  const text = dark ? KNAUF.ink.onDark : KNAUF.ink.primary;
  const muted = dark ? KNAUF.ink.mutedOnDark : KNAUF.ink.muted;
  const grid = dark ? KNAUF.surface.darkBorder : KNAUF.surface.border;
  const tooltipStyle = { background: surface, border: `1px solid ${border}`, borderRadius: 8, color: text };

  return (
    <div className="min-h-screen w-full p-6" style={{ background: dark ? KNAUF.surface.dark : KNAUF.surface.lightAlt, color: text }}>
      <div className="mb-5 flex items-center justify-between rounded-lg px-5 py-3"
        style={{ background: KNAUF.brand.regalBlue, color: KNAUF.ink.onDark }}>
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-extrabold tracking-tight">KARL</span>
          <span className="text-sm font-medium" style={{ color: KNAUF.brand.shakespeare }}>Performance Dashboard</span>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="dark" className="text-xs" style={{ color: KNAUF.ink.onDark }}>Dark</Label>
          <Switch id="dark" checked={dark} onCheckedChange={setDark} />
        </div>
      </div>

      <div className="mb-5 flex items-center gap-3">
        <span className="text-sm font-medium" style={{ color: muted }}>Time range</span>
        <ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v)}>
          {Object.keys(RANGES).map((r) => (
            <ToggleGroupItem key={r} value={r} className="px-4">{r}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {kpis.map(({ label, value, delta, Icon }) => (
          <Card key={label} className="p-4" style={{ background: surface, borderColor: border }}>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: muted }}>{label}</span>
              <Icon size={18} style={{ color: KNAUF.brand.cerulean }} />
            </div>
            <div className="mt-2 text-2xl font-bold" style={{ color: text }}>{value}</div>
            <div className="mt-1 text-xs font-medium" style={{ color: KNAUF.status.success }}>{delta}</div>
          </Card>
        ))}

        <Card className="p-4 md:col-span-2 lg:col-span-2" style={{ background: surface, borderColor: border }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: text }}>Revenue & orders trend</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={months} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                <XAxis dataKey="m" stroke={muted} fontSize={12} />
                <YAxis stroke={muted} fontSize={12} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Line type="monotone" dataKey="revenue" name="Revenue (€M)" stroke={palette[0]} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="orders" name="Orders" stroke={palette[1]} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4 md:col-span-2 lg:col-span-2" style={{ background: surface, borderColor: border }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: text }}>Revenue by product line</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DATA.breakdown} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
                <XAxis dataKey="name" stroke={muted} fontSize={12} />
                <YAxis stroke={muted} fontSize={12} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: dark ? KNAUF.surface.dark : KNAUF.surface.lightAlt }} />
                <Legend />
                <Bar dataKey="value" name="Revenue (€M)" radius={[4, 4, 0, 0]}>
                  {DATA.breakdown.map((d, i) => <Cell key={d.name} fill={palette[i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4 md:col-span-2 lg:col-span-4" style={{ background: surface, borderColor: border }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: text }}>Regional share</h3>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Pie data={DATA.share} dataKey="value" nameKey="name" cx="50%" cy="50%"
                  innerRadius={60} outerRadius={100} paddingAngle={2}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {DATA.share.map((d, i) => <Cell key={d.name} fill={palette[i]} />)}
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

---

# Knauf chart colour

The raw brand palette **fails** the chart gates, because the brand secondaries are
light "not for text" background colours: on white, `#FFD25C` is 1.44:1, `#CFD7D9`
1.46:1 and `#87C15F` 2.14:1 — all below the 3:1 floor a data mark needs. `#004B46`
is far too dark for the series lightness band and so low in chroma it reads grey.

So chart series are **brand-derived steps**, not brand-literal hexes. That is a
brand-faithful outcome, not a deviation: the brand book assigns those colours to
fills and backgrounds, which is exactly where they stay.

## Categorical — fixed order, both modes

Assign by **series index**: series 0 takes slot 1, series 1 takes slot 2, and so on.
Never by rank or by value — a filter that changes the series count must not repaint
the survivors.

| Slot | Hue | Hex | Origin | on `#FFFFFF` | on `#0F1720` |
|---|---|---|---|---|---|
| 1 | cyan blue | `#0099DE` | brand-literal, unchanged | 3.18 | 5.68 |
| 2 | orange | `#D96400` | ← Knauf Orange `#F06E00`, darkened | 3.64 | 4.96 |
| 3 | teal | `#009184` | ← Knauf Dark Green `#004B46`, lightened + chroma raised | 3.90 | 4.63 |
| 4 | violet | `#7A4FB5` | **extension** — no brand origin | 5.81 | 3.10 |
| 5 | green | `#5A9A32` | ← Knauf Light Green `#87C15F`, darkened | 3.44 | 5.24 |
| 6 | magenta | `#C43A8B` | **extension** — no brand origin | 4.86 | 3.72 |
| 7 | amber | `#B8860B` | ← Knauf Yellow `#FFD25C`, darkened | 3.25 | 5.55 |

Why each derivation was necessary — these are the gates that failed, not taste:

- `#F06E00` → `#D96400`: brand-literal orange passes every light-mode gate, but sits
  at OKLCH L 0.684, above the 0.67 **dark-mode** ceiling. Darkening is what lets one
  set of steps serve both modes.
- `#004B46` → `#009184`: L 0.372 is below the 0.43 light floor **and** chroma 0.065 is
  below the 0.10 floor, so it reads as grey and stops doing identity work.
- `#87C15F` → `#5A9A32`: 2.14:1 on white, below the 3:1 mark floor.
- `#FFD25C` → `#B8860B`: L 0.881, far above the band, and 1.44:1.

**Measured verdict — all gates PASS in both modes, with one set of steps:**

| Gate | Light (`#FFFFFF`) | Dark (`#0F1720`) |
|---|---|---|
| Lightness band | all 7 inside L 0.43–0.77 | all 7 inside L 0.48–0.67 |
| Chroma floor | all 7 ≥ 0.10 | all 7 ≥ 0.10 |
| CVD separation (worst adjacent) | `#009184`↔`#D96400` ΔE 12.7 protan / 12.5 tritan | same |
| Normal-vision floor (worst adjacent) | `#7A4FB5`↔`#009184` ΔE 23.4 | same |
| Contrast vs surface | all 7 ≥ 3:1 | all 7 ≥ 3:1 |

There is **no dark palette to maintain.** Only the surfaces and ink swap.

## The all-pairs forms

Scatter, bubble, choropleth and small multiples put *any* two marks side by side,
so they are judged on every pair, not just neighbours. The natural 1-2-3 prefix
**fails** there: `#009184` ↔ `#0099DE` is ΔE 13.6 to normal vision, below the 15
floor — two blues too close together when nothing separates them on screen.

Validated exception, in both modes — use slots **1, 2 and 4**:

`#0099DE`, `#D96400`, `#7A4FB5` — worst all-pairs ΔE 12.4 (CVD) / 20.0 (normal).

**Hard cap of three series** in those forms. A fourth means folding the tail into
"Other", faceting into small multiples, or changing chart form — not adding a colour.

## Ordinal vs sequential

Two different jobs that the same cerulean ramp can serve, with different rules.

- **Ordinal** — discrete ordered marks: funnel stages, size tiers, cohort buckets.
  Every step must be *readable*, so the lightest step still clears 2:1.
  `#66BCE8`, `#0099DE`, `#0077B0`, `#00527A` — monotone lightness, adjacent ΔL ≥ 0.06,
  light end 2.12:1, single hue (7° spread). Passes.
- **Sequential** — continuous magnitude: heatmaps, choropleths. Here the lightest
  step legitimately means "near zero" and may recede into the surface.
  `#E5F3FB`, `#B3DCF3`, `#66BCE8`, `#0099DE`, `#0077B0`, `#00527A`.

Do not use the 6-step sequential ramp for ordinal marks — `#E5F3FB` is 1.13:1 on
white and vanishes.

When two sequential contexts appear at once, the second takes the next categorical
hue (orange) as its own one-hue ramp.

## Chart ink — the brand constraint that shapes everything

Because `lightGreen`, `orange`, `yellow` and `grey` are "not for text", **no chart
label, value, axis, tick or legend entry ever takes a series colour.**

| Element | Token |
|---|---|
| Data labels, values, chart title | `theme.text` |
| Axis labels, ticks, captions, footnotes | `theme.muted` |
| Gridlines, baseline | `theme.grid` (`#CFD7D9` light / `#26333F` dark) |
| Table header fill, zebra rows | `surface.neutral` `#CFD7D9` |

`#CFD7D9` is **never** a series. It is the neutral, and a neutral that also appears
as data reads as "missing" or "other" wherever it lands.

Other rules that hold regardless of palette:

- **One axis.** Never two y-scales. Two measures of different magnitude → two charts,
  small multiples, or index both to a common base.
- A legend is always present for two or more series; up to four are also directly
  labelled, so identity is never carried by colour alone. A single series needs no
  legend — the title names it.
- Give `<ResponsiveContainer>` a parent with an explicit height (`h-72 w-full`,
  `h-80 w-full`), or it collapses to zero.
- Keep pie and donut charts to four or five slices with direct labels. Colouring
  each bar of a single-series bar chart is only legitimate when the axis tick already
  names it — otherwise it is colour without identity.

## Status colours

`success` `#1F883D`, `warning` `#C98A00`, `serious` `#E8792A`, `critical` `#D64550`.

Reserved for state. **Never a data series** — a status colour that also means
"series 4" makes both unreadable.

**Never white text on these fills.** Measured white-on-fill: success 4.52, warning
2.95, serious 2.92, critical 4.35 — three of the four fail AA for normal text. The
pattern that works everywhere, and satisfies "never colour alone" at the same time:

```tsx
// Status chip: ink on a light tint, with a status-coloured ring and dot.
<span
  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
  style={{ color: theme.text, backgroundColor: theme.card, borderColor: KNAUF.status[tone] }}
>
  <span
    className="h-1.5 w-1.5 rounded-full"
    style={{ backgroundColor: KNAUF.status[tone] }}
    aria-hidden="true"
  />
  {label}
</span>
```

## Re-validating

Every number above came from the `dataviz` skill's `scripts/validate_palette.js`,
run four ways. The script is not bundled here — with code execution off nothing
could run it, and every skill file is uploaded to the sandbox on each prime, so
carrying it would be paid weight. Change a hex, re-run all four, and paste the
output back into this file:

```
node scripts/validate_palette.js "<comma-separated hexes>" --mode light --surface "#FFFFFF"
node scripts/validate_palette.js "<comma-separated hexes>" --mode dark  --surface "#0F1720"
node scripts/validate_palette.js "<slots 1,2,4>"            --mode light --surface "#FFFFFF" --pairs all
node scripts/validate_palette.js "<ordinal ramp>" --ordinal  --mode light --surface "#FFFFFF"
```

## Non-React media

The same values, expressed for other renderers.

**matplotlib** — set the cycler once, save headless:

```python
import matplotlib as mpl, matplotlib.pyplot as plt
KNAUF = ['#0099DE','#D96400','#009184','#7A4FB5','#5A9A32','#C43A8B','#B8860B']
mpl.rcParams['axes.prop_cycle'] = mpl.cycler(color=KNAUF)
mpl.rcParams['axes.edgecolor'] = '#CFD7D9'
mpl.rcParams['text.color'] = '#0F1A2A'
```

**Inline SVG** — put the hexes straight on `fill`/`stroke`; keep `<text>` on
`#0F1A2A` (labels) and `#5B6770` (axes).

**Mermaid** — one line is enough; do not build a full theme block:
`%%{init: {'theme':'base','themeVariables':{'primaryColor':'#0099DE','lineColor':'#5B6770','primaryTextColor':'#0F1A2A'}}}%%`

---
name: karl-artifacts
description: >-
  Building KARL artifacts (the live preview panel): React, HTML, SVG, Mermaid,
  Markdown. Use when creating or iterating an interactive UI, dashboard, chart,
  diagram, or Knauf-branded report or slide deck — or when deciding artifact vs.
  plain chat.
argument-hint: "[what to build or change]"
user-invocable: true
version: "2.0.0"
---

# KARL Artifacts: choosing well and building previews that render

Your system instructions already define the artifact directive syntax, the allowed
types, and the library allowlist — follow them exactly and never restate or wrap
them. This skill adds what they leave out: how to choose a type, what breaks
previews, how to iterate, and how to make it look like Knauf.

## Choose the right type

| You are producing | Type | Why |
|---|---|---|
| Interactive UI, dashboard, calculator, form — anything with state or a chart | `application/vnd.react` | Tailwind + recharts + shadcn/ui are available; the only type with interactivity and styling batteries included |
| A complete standalone web page the user will save/host, or something needing a cdnjs library (d3, chart.js) | `text/html` | Single self-contained file with its own CSS/JS; the only type allowed to load external scripts (from `cdnjs.cloudflare.com` only) |
| Architecture, flow, sequence, ER, or Gantt diagrams | `application/vnd.mermaid` | Renders with zoom/pan; far cheaper to iterate than hand-drawing boxes |
| A logo, icon, or static illustration | `image/svg+xml` | Rendered directly; set a `viewBox`, omit fixed width/height |
| A document deliverable: report, policy, plan, spec | `text/markdown` | Rendered document the user can copy/export |

Rules of thumb:

- Charting real data → react + recharts. Drawing structure/process → mermaid. Never hand-draw charts in SVG.
- No interactivity and no styling needed → markdown beats html.
- Code you are explaining, or that the user will run elsewhere → a plain fenced code block in chat, not an artifact.
- Numbers you have already computed → embed them as `const DATA = [...]`.

## Top preview-breaking mistakes

1. **Importing something that isn't available.** There is no `npm install`. The
   allowlist for `application/vnd.react` is: `react` (incl. hooks), `lucide-react`,
   `recharts`, `three`, `date-fns`, `react-day-picker`, and shadcn/ui imported from
   `/components/ui/<name>` — never `/components/<name>` or `@/components/ui/<name>`.
   Anything else (zod, axios, lodash, d3, framer-motion, styled-components,
   react-hook-form, …) will not resolve. If the idea needs a missing library:
   implement the small piece by hand, switch to `text/html` + a cdnjs script, or say
   it can't be previewed and give a plain code block.
2. **`fetch()` to external APIs, or `<img src="https://…">`.** The preview has no
   reliable network. Embed data as `const DATA = [...]`; use
   `/api/placeholder/{w}/{h}` for images. The one exception is the Knauf wordmark,
   which is inline SVG and therefore needs no network at all.
3. **Tailwind arbitrary values** (`h-[600px]`, `bg-[#0099DE]`, `text-[13px]`). Your
   system instructions forbid them explicitly. Use scale classes (`h-96`, `w-full`)
   for layout, and a `style={{}}` prop for exact colours — which is what the Knauf
   token pattern below does anyway, and which keeps rendering correctly even if the
   Tailwind CDN fails to load.
4. **Recharts without a sized parent.** Wrap `<ResponsiveContainer>` in an element
   with an explicit height (`className="h-72 w-full"`), or set width/height props.
5. **Mermaid parse errors from special characters.** Quote labels containing
   `()[]{}:;` as `A["Label (detail)"]`; stick to well-supported diagram types
   (flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, pie).
6. **Missing default export or required props** on the react root component.
7. **Renaming the identifier on an edit** (see next section).

Tailwind note: utilities are injected for **both** the react and the standalone-HTML
preview. For `text/html` prefer inline `<style>` anyway — the user will save and host
that file somewhere that injects nothing.

## Iterating: update in place, don't spawn siblings

- "Change / fix / add X" to something you already built → **same `identifier`**,
  re-emit the **complete** content. The panel keeps version history.
- New `identifier` only for a genuinely new, separate deliverable, or when the user
  explicitly asks for a variant to compare.
- Never invent `dashboard-v2`-style identifiers for revisions.
- Every update re-emits the whole artifact. A partial emission with "…rest unchanged"
  comments replaces the artifact with a broken fragment.

## Sizing and complexity

- One file only: no multi-file apps, no importing your own modules. If the request is
  app-sized, build the single highest-value screen and offer follow-ups rather than
  emitting a truncated monolith.
- Keep embedded datasets small (dozens of rows). For big data, aggregate first and
  embed the aggregate.
- Prefer several small self-contained components composed under one root over one
  giant render function.

## Design and accessibility floor

- Semantic HTML (`button` for actions, `label htmlFor` on every input, ordered
  headings); keep keyboard focus visible.
- Ensure text/background contrast; never encode meaning by colour alone — add a
  label, an icon, or a legend. This applies to status chips and KPI deltas too.
- The preview follows the user's light/dark preference — don't hardcode near-white
  text/backgrounds that only work in one mode.
- Default to a clean layout: page padding (`p-6`), constrained width
  (`max-w-4xl mx-auto`), a consistent spacing scale. shadcn/ui `Card`, `Tabs`,
  `Table`, `Badge` give a professional look for almost no effort.

## Knauf brand — read karl-brand first

**Before writing any branded deliverable, load the token source:**

```
read_file  skills/karl-brand/SKILL.md
```

It carries the official colour system with provenance, the ink/surface tokens, the
dark-mode pairs, and the validated chart palette. Copy its `KNAUF` const and
`useKnaufTheme` into the artifact verbatim, as the first block. Then, if the chart is
anything beyond a plain bar or line, also read
`skills/karl-brand/references/charts.md`; for the wordmark, read
`skills/karl-brand/references/logo.md`.

**Quick card (mirror).** The authoritative source, with provenance, dark tokens and
the chart gates, is `skills/karl-brand/SKILL.md` — read it for any real deliverable.
Use this card only if that read fails, and say so in your reply.

- **Brand** — Cyan Blue `#0099DE` (primary, charts, key visual), Accessible Blue `#003778` (headings, structural bars; never the logo, never on dark), logo fill `#00A0E6`.
- **Ink** — `#0F1A2A` body, `#3A4A5C` secondary, `#5B6770` muted/captions; on dark `#E6EEF5` and `#9FB0BF`.
- **Surface** — `#FFFFFF` card, `#F4F8FB` page, `#DCE6EE` border; dark `#0F1720` page, `#16212E` card, `#26333F` border. Neutral fill `#CFD7D9`.
- **Charts (categorical, fixed order, both modes)** — `#0099DE`, `#D96400`, `#009184`, `#7A4FB5`, `#5A9A32`, `#C43A8B`, `#B8860B`.
- **Status (reserved — never a data series)** — success `#1F883D`, warning `#C98A00`, serious `#E8792A`, critical `#D64550`. Never white text on these fills.

**Applying it under the artifact constraints:**

- Tailwind here has no arbitrary values, so exact colours arrive via inline
  `style={{}}` and recharts `fill`/`stroke` props. Tailwind covers layout, spacing
  and type scale only.
- Read heading colour from the theme, never `KNAUF.brand.accessibleBlue` directly —
  `#003778` on a dark surface is 1.56:1.
- The wordmark is the **real inline SVG** from
  `skills/karl-brand/references/logo.md` — never an `<img>`, and never typed as text.
  Product naming sits beside the mark, not inside it.
- Charts keep the categorical order fixed by series index and always carry a legend
  or direct labels. Labels and axes wear ink tokens, never a series colour — which
  recharts does *not* give you for free: `<Legend>` needs a `formatter` and `<Pie>`
  needs a `label` that returns an element. See `charts.md`.

## Situation templates — read before building a branded deliverable

Copy-paste, constraint-checked skeletons live in this skill's `references/`. Each one
assumes `KNAUF` and `useKnaufTheme` are already in the artifact and introduces no
colour that is not already in the `KNAUF` const. Read order: **karl-brand → the
layout → (charts.md if needed)**.

- `skills/karl-artifacts/references/report.md` — data/analysis report (brand header, exec summary, KPI tiles, chart, findings table).
- `skills/karl-artifacts/references/slides.md` — navigable slide deck (title / section / bullets / chart layouts).
- `skills/karl-artifacts/references/dashboard.md` — KPI dashboard (range filter, stat tiles, trend/breakdown/share charts, light+dark).

Adapt the skeleton to the user's data — don't ship the sample data verbatim.

## Reading skill files

`read_file` resolves skill content at `skills/{skillName}/{path}` — note the plural
`skills/`. `SKILL.md` is served directly; anything under `references/` is fetched from
storage. This works whether or not code execution is enabled.

## When NOT to use an artifact

- One-off answers, explanations, and short snippets → chat markdown.
- Content you were asked to review or critique → comment in chat.
- Data analysis: summarize the findings in chat. If code execution is available,
  compute there and deliver files; otherwise reason it through and embed the
  resulting numbers in a react artifact.

When in doubt, answer in chat and offer an artifact as a follow-up.

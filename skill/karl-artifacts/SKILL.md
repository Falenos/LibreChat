---
name: karl-artifacts
description: >-
  Building KARL artifacts (the live preview panel): React, HTML, SVG, Mermaid,
  Markdown. Use when creating or iterating an interactive UI, dashboard, chart,
  diagram, or Knauf-branded report or slide deck — or when deciding artifact vs.
  plain chat.
argument-hint: "[what to build or change]"
user-invocable: true
version: "3.0.0"
---

# KARL Artifacts: choosing well and building previews that render

Reference material for building artifacts in KARL. The artifact directive syntax,
the allowed types and the library allowlist are already defined in the system
instructions and are not repeated here. What follows is what those leave out:
choosing a type, what breaks previews, how to iterate, and how to make it look
like Knauf.

## Choose the right type

| You are producing | Type | Why |
|---|---|---|
| **A presentation, slide deck, or pitch** | `application/vnd.react` | Slides need navigation and layout; there is no such thing as a markdown slide deck here. Use the `slides` template |
| **A branded report, briefing, one-pager, or exec summary** | `application/vnd.react` | Brand header, KPI tiles, charts and a findings table. Use the `report` template |
| Interactive UI, dashboard, calculator, form — anything with state or a chart | `application/vnd.react` | Tailwind + recharts + shadcn/ui are available; the only type with interactivity and styling batteries included |
| A complete standalone web page the user will save/host, or something needing a cdnjs library (d3, chart.js) | `text/html` | Single self-contained file with its own CSS/JS; the only type allowed to load external scripts (from `cdnjs.cloudflare.com` only) |
| Architecture, flow, sequence, ER, or Gantt diagrams | `application/vnd.mermaid` | Renders with zoom/pan; far cheaper to iterate than hand-drawing boxes |
| A logo, icon, or static illustration | `image/svg+xml` | Rendered directly; set a `viewBox`, omit fixed width/height |
| Plain unstyled prose the user will paste elsewhere: a policy, a plan, a spec, meeting notes | `text/markdown` | Rendered document the user can copy/export. No layout, no brand styling, no slides — if the deliverable needs any of those, it is a react artifact |

Before emitting `application/vnd.mermaid`, load and follow:

```
read_file  skills/karl-mermaid/SKILL.md
```

Rules of thumb:

- **A presentation is always react.** "Deck", "slides", "presentation", "pitch" and
  "walkthrough" all mean the `slides` reference and its prebuilt
  `/knauf/slides` renderer — never markdown and never a hand-written deck shell.
  The artifact supplies slide data; the renderer owns navigation, branding,
  responsive layout, light/dark colours, and PDF/PNG pagination.
- **"Document deliverable" is not a routing rule.** A deck and a branded report are document deliverables too, and both are react. Markdown is for output with no layout and no branding.
- Charting real data → react + recharts. Drawing structure/process → mermaid. Never hand-draw charts in SVG.
- No interactivity, no branding and no layout needed → markdown beats html.
- Code you are explaining, or that the user will run elsewhere → a plain fenced code block in chat, not an artifact.
- Numbers you have already computed → embed them as `const DATA = [...]`.

## Top preview-breaking mistakes

1. **Importing something that isn't available.** There is no `npm install`. The
   allowlist for `application/vnd.react` is: `react` (incl. hooks), `lucide-react`,
   `recharts`, `three`, `date-fns`, `react-day-picker`, and shadcn/ui imported from
   `/components/ui/<name>` — never `/components/<name>` or `@/components/ui/<name>`.
   Knauf brand tokens, fonts and the wordmark are prebuilt too: `/knauf/brand`,
   exporting `KNAUF`, `useKnaufTheme` and `KnaufWordmark`. Slide decks use
   `/knauf/slides`, exporting `KnaufSlideDeck`; do not rebuild its shell.
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
5. **Mermaid syntax errors.** Follow `karl-mermaid`, loaded above; it owns the
   version-specific syntax and repair rules.
6. **Missing default export or required props** on the react root component.
7. **Renaming the identifier on an edit** (see next section).

Tailwind note: utilities are injected for **both** the react and the standalone-HTML
preview. For `text/html` prefer inline `<style>` anyway and add
`<link rel="stylesheet" href="/knauf/fonts.css">` for Knauf typography in the KARL
preview. A separately hosted export must serve the supplied font files and equivalent
`@font-face` rules itself.

## Iterating: update in place, don't spawn siblings

- "Change / fix / add X" to something already built → keep the **same
  `identifier`**. When `edit_artifact` is available, call it with the current
  revision token and the smallest exact, unique old/new replacements. After a
  successful call, do not re-emit the artifact or repeat its source; confirm the
  change briefly.
- New `identifier` only for a genuinely new, separate deliverable, or when the user
  explicitly asks for a variant to compare.
- Never invent `dashboard-v2`-style identifiers for revisions.
- A full artifact re-emission is the fallback only when `edit_artifact` is
  unavailable, rejects the change, or the request is a broad rewrite that cannot
  be expressed safely as exact replacements. In that fallback, emit the complete
  artifact; never emit a partial fragment with "…rest unchanged" comments.

## Sizing and complexity

- One file only: no multi-file apps, and no authoring extra files of your own — the
  prebuilt modules (`/components/ui/*`, `/knauf/brand`, `/knauf/slides`) are the only imports beyond the
  library allowlist above. If the request is
  app-sized, build the single highest-value screen and offer follow-ups rather than
  emitting a truncated monolith.
- Keep embedded datasets small (dozens of rows). For big data, aggregate first and
  embed the aggregate.
- Prefer several small self-contained components composed under one root over one
  giant render function.

## Design and accessibility floor

- Semantic HTML (`button` for actions, `label htmlFor` on every input, ordered
  headings); keep keyboard focus visible.
- **Treat every background and its foreground as one pair.** A surface is not themed
  until its heading, body and muted text come from the matching row below:

  | Surface | Background | Heading / body / muted text |
  |---|---|---|
  | Theme-aware page or card | `theme.page` / `theme.card` | `theme.heading` / `theme.text` / `theme.muted` |
  | Fixed white logo header | `KNAUF.surface.card` | `KNAUF.ink.heading` / `KNAUF.ink.primary` / `KNAUF.ink.muted` |
  | Brand-blue title field | `KNAUF.brand.accessibleBlue` | `#FFFFFF` / `#FFFFFF` / `KNAUF.ink.accentOnBrand` |

  Never pair a fixed light surface (`#FFFFFF`, `KNAUF.surface.card`, a white
  shadcn card) with `theme.text`, `theme.heading` or `theme.muted`: those become
  light ink in dark mode and disappear on white. Conversely, never put fixed
  light-mode ink on `theme.card` when that card can become dark.
- One `dark` state drives `useKnaufTheme(dark)` and every theme-aware surface and
  text token. Do not combine that state with Tailwind `dark:*`, inherited shadcn
  text colours, or a second theme detector. For a visible Light/Dark toggle, test
  every card, label, chart axis, tooltip and disabled control in both positions.
- Ensure normal text reaches 4.5:1 against its immediate background (3:1 for large
  text). Never encode meaning by colour alone — add a label, icon or legend. This
  applies to status chips and KPI deltas too.
- Default to a clean layout: page padding (`p-6`), constrained width
  (`max-w-4xl mx-auto`), a consistent spacing scale. shadcn/ui `Card`, `Tabs`,
  `Table` and `Badge` give a professional look for almost no effort. Each lives in
  its own file — there is no barrel, so `from '/components/ui'` does not resolve and
  the preview will not load. These four are the whole set worth reaching for, and
  these are their exact imports and export names:

  ```tsx
  import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '/components/ui/card';
  import { Tabs, TabsList, TabsTrigger, TabsContent } from '/components/ui/tabs';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from '/components/ui/table';
  import { Badge } from '/components/ui/badge';
  ```

  Note `TabsList`, not `TabList`. Import only what you use. For anything outside
  these four, build it from plain elements and Tailwind rather than guessing at a
  path — an import that does not resolve takes the whole artifact down, while a
  hand-built component merely looks plainer.

## Knauf brand — read karl-brand first

Before writing a branded deliverable, load the token source:

```
read_file  skills/karl-brand/SKILL.md
```

That skill alone owns colour meaning, accessibility pairs, typography, charts, and
logo rules. Do not mirror its token table here or in an artifact.

- Standard React artifacts import `KNAUF`, `useKnaufTheme`, and `KnaufWordmark`
  from `/knauf/brand` rather than re-declaring them.
- Slide decks import only `KnaufSlideDeck` from `/knauf/slides`; it already consumes
  `/knauf/brand` and keeps the entire header white around the official wordmark.
- For non-deck charts beyond a plain bar or line, also read
  `skills/karl-brand/references/charts.md`.
- For HTML or SVG, read `skills/karl-brand/references/logo.md`; never type, redraw,
  or use an image placeholder for the wordmark.

## Situation templates — read before building a branded deliverable

Focused contracts live in this skill's `references/`. Read only the one matching the
deliverable. Read order: **karl-brand → the layout → charts.md if needed**.

- `skills/karl-artifacts/references/report.md` — data/analysis report (brand header, exec summary, KPI tiles, chart, findings table).
- `skills/karl-artifacts/references/slides.md` — data-only slide deck using the platform renderer.
- `skills/karl-artifacts/references/dashboard.md` — KPI dashboard (range filter, stat tiles, trend/breakdown/share charts, light+dark).

Adapt the skeleton to the user's data — don't ship the sample data verbatim.

## Reading skill files

`read_file` resolves skill content at `skills/{skillName}/{path}` — note the plural
`skills/`. `SKILL.md` is served directly; anything under `references/` is fetched from
storage. This works whether or not code execution is enabled.

## When NOT to use an artifact

- One-off answers, explanations, and short snippets → chat markdown.
- Content you were asked to review or critique → comment in chat.
- Data analysis: summarize the findings in chat, then embed the computed numbers
  in a react artifact as `const DATA = [...]`. There is no code-execution sandbox
  and no file output on KARL, so never offer to compute elsewhere or to deliver a
  file.

When the request is genuinely borderline, answer in chat and offer an artifact as a
follow-up. When it is not borderline — a deck, a report, a dashboard, a diagram —
build it rather than offering to.

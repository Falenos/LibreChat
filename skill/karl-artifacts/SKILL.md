---
name: karl-artifacts
description: >-
  Guidance for building KARL artifacts (the live preview panel). Use when
  creating or updating an interactive UI, React component, dashboard, HTML
  page, SVG graphic, Mermaid diagram, or any rendered visual preview — or when
  deciding whether content belongs in an artifact or in plain chat markdown.
  Covers picking the right artifact type, the fixed React library allowlist and
  the top preview-breaking mistakes, embedding data instead of fetching it, and
  iterating on an existing artifact instead of spawning duplicates.
argument-hint: "[what to build or change]"
user-invocable: true
version: "1.0.0"
---

# KARL Artifacts: choosing well and building previews that render

Your system instructions already define the artifact directive syntax, the
allowed types, and the library allowlist — follow them exactly and never
restate or wrap them. This skill adds what they leave out: how to choose a
type, what breaks previews, and how to iterate.

## Choose the right type

| You are producing | Type | Why |
|---|---|---|
| Interactive UI, dashboard, calculator, form — anything with state or charts of embedded data | `application/vnd.react` | Tailwind + recharts + shadcn/ui are available; the only type with interactivity and styling batteries included |
| A complete standalone web page the user will save/host, or something needing a cdnjs library (d3, chart.js) | `text/html` | Single self-contained file with its own CSS/JS; the only type allowed to load external scripts (from `cdnjs.cloudflare.com` only) |
| Architecture, flow, sequence, ER, or Gantt diagrams | `application/vnd.mermaid` | Renders with zoom/pan; far cheaper to iterate than hand-drawing boxes |
| A logo, icon, or static illustration | `image/svg+xml` | Rendered directly; set a `viewBox`, omit fixed width/height |
| A document deliverable: report, policy, plan, spec | `text/markdown` | Rendered document the user can copy/export |

Rules of thumb:
- Charting real data → react + recharts. Drawing structure/process → mermaid. Never hand-draw charts in SVG.
- No interactivity and no styling needed → markdown beats html.
- Code you are explaining, or that the user will run elsewhere → a plain fenced code block in chat, not an artifact.
- Results computed in the code sandbox → return tables/numbers in chat, or embed the computed values into a react artifact as `const` data.

## Top preview-breaking mistakes

Each of these blanks or crashes the preview:

1. **Importing anything outside the react allowlist** in your instructions (axios, lodash, zod, d3, framer-motion, styled-components, react-router, …). There is no `npm install`. If the idea needs a missing library: implement the small piece by hand, switch to `text/html` + a cdnjs script, or say it can't be previewed and give a plain code block.
2. **`fetch()` to external APIs, or `<img src="https://…">`.** The preview has no reliable network. Embed data as `const DATA = [...]` and use `/api/placeholder/{w}/{h}` for images.
3. **Tailwind arbitrary values** (`h-[600px]`, `bg-[#0a0a0a]`). Use scale classes (`h-96`, `w-full`) or a `style={{}}` prop for genuinely custom values.
4. **Recharts without a sized parent.** Wrap `<ResponsiveContainer>` in an element with an explicit height (`className="h-72 w-full"`), or set width/height props on the chart.
5. **Mermaid parse errors from special characters.** Quote labels containing `()[]{}:;` as `A["Label (detail)"]`; stick to well-supported diagram types (flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, pie).
6. **Missing default export or required props** on the react root component.
7. **Renaming the identifier on an edit** (see next section).

Tailwind note: utilities are auto-injected only for `application/vnd.react` previews. For `text/html`, write inline `<style>` CSS — the Tailwind CDN is not an allowed external host.

## Iterating: update in place, don't spawn siblings

- "Change / fix / add X" to something you already built → **same `identifier`**, re-emit the **complete** content. The panel keeps version history.
- New `identifier` only for a genuinely new, separate deliverable, or when the user explicitly asks for a variant to compare.
- Never invent `dashboard-v2`-style identifiers for revisions.
- Every update re-emits the whole artifact. A partial emission with "…rest unchanged" comments replaces the artifact with a broken fragment.

## Sizing and complexity

- One file only: no multi-file apps, no importing your own modules. If the request is app-sized, build the single highest-value screen and offer follow-ups rather than emitting a truncated monolith.
- Keep embedded datasets small (dozens of rows). For big data, aggregate first (in the code sandbox if available) and embed the aggregate.
- Prefer several small self-contained components composed under one root over one giant render function.

## Design and accessibility floor

- Semantic HTML (`button` for actions, `label htmlFor` on every input, ordered headings); keep keyboard focus visible.
- Ensure text/background contrast; never encode chart meaning by color alone — add labels or a legend.
- The preview follows the user's light/dark preference — don't hardcode near-white text/backgrounds that only work in one mode.
- Default to a clean neutral layout: page padding (`p-6`), constrained width (`max-w-4xl mx-auto`), a consistent spacing scale. shadcn/ui `Card`, `Tabs`, `Table`, `Badge` give a professional look for almost no effort.

## When NOT to use an artifact

- One-off answers, explanations, and short snippets → chat markdown.
- Data analysis → run it in the sandbox, deliver files, and summarize in chat.
- Content you were asked to review or critique → comment in chat.

When in doubt, answer in chat and offer an artifact as a follow-up.

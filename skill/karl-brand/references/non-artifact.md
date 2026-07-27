# Brand outside the preview panel

The tokens in `skills/karl-brand/SKILL.md` are not artifact-specific. Every medium
below draws from the same `KNAUF` const; what changes is how much styling the medium
can carry.

## Plain chat markdown

Chat markdown has **no styling**. There is no colour channel, so brand expression is
**structural**:

- A clear heading hierarchy, one idea per section.
- Bold row labels in tables; numeric columns aligned and consistently rounded.
- A closing context line where it earns its place — `Source: …`, `As of: …`, or a
  confidentiality note.

**Do not emit inline HTML or `<span style="…">` into chat to fake brand colour.** It
either renders as literal text or is stripped, and both look broken. If the answer
genuinely needs colour, that is the signal it should be an artifact.

## Documents

Applies to `text/markdown` artifacts and to `.docx` / `.odt` deliverables.

- Title, then a one-paragraph summary a reader can stop after, then detail.
- Heading order is never skipped — `#` → `##` → `###`.
- Tables get a header row filled `surface.neutral` `#CFD7D9` with `ink.primary`
  `#0F1A2A` text (11.96:1) wherever the format supports fills.
- Close with a footer line: document owner, date, and confidentiality if relevant.

Office previews render through a sanitised static HTML pipeline
(`packages/api/src/files/documents/html.ts`), so token hexes survive as inline CSS —
but the licensed Knauf fonts do not travel. Keep the Arial/system stack.

## Decks outside the slide artifact

Same grammar as the slide template: title → section divider → bullets → chart.

- Title and section slides: `#003778` field, white type, `ink.accentOnBrand`
  `#66BCE8` for the subtitle (5.46:1 on that field).
- Content slides: white or `surface.page` `#F4F8FB`, headings in `ink.heading`.
- One idea per slide. If a slide needs a second idea, it needs to be two slides.
- The wordmark appears once on the title slide and small in the footer — see
  `skills/karl-brand/references/logo.md`.

## Email and signatures

- **Inline CSS only.** No `<style>` block, no webfonts — mail clients strip both.
- `Arial, Helvetica, sans-serif`, `#003778` headings on white, body `#0F1A2A`.
- Table fills in `#CFD7D9`; never coloured fills behind body text.
- Keep to a single column at ~600px; assume images are blocked by default.
- The wordmark as inline SVG where the client supports it — many do not, so provide
  a plain-text fallback. That fallback is the **one** place typed naming is acceptable.

## Spreadsheets

- Header row: `#CFD7D9` fill, `#0F1A2A` text, bold.
- Primary series `#0099DE`; further series follow `KNAUF.categorical` in order.
- Conditional formatting uses `KNAUF.status`, always with an icon or a text column
  beside it — never colour alone, since a colour-only cell is invisible to a
  screen reader and to anyone printing in greyscale.
- No green, yellow or orange fills behind text that must be read.

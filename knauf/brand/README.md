# Knauf brand kit (KK20-243)

Source-of-truth design assets for KARL. **Reference material only** — this directory is
excluded from the Docker build context by [`.dockerignore`](../../.dockerignore), so
nothing here is available at runtime.

## Provenance

| | |
|---|---|
| Delivered as | `KK20-243_attachments.zip` — 18 files, 26,835,532 bytes |
| Received | 2026-07-27 |
| Jira | KK20-243 |
| Contents here | 17 files (`KNAUFLogo2024sRGB (1).png` dropped — byte-identical duplicate of `KNAUFLogo2024sRGB.png`, verified with `cmp`) |

`logo.svg` from the delivery was renamed to `logos/KNAUFLogo2024-alt-styled.svg` — the
original filename said nothing about what it was, and it is easily confused with
`client/public/assets/logo.svg`, which is a completely different (upstream LibreChat) mark.

## Licence and usage constraints

- **Internal Knauf Group use only.** Not open-source, and not covered by the repository
  LICENSE, which applies to the LibreChat-derived code.
- **The fonts are licensed, not free.** Do NOT embed `fonts/Knauf fonts.7z` in the web
  client, do NOT self-host it, do NOT ship it to browsers, and do NOT reference it from
  artifact templates without written confirmation of the web-embedding licence from the
  brand owner. Until then, KARL's UI and every artifact template use the system/Arial
  stack — which is brand-compliant anyway: the official colour sheet sets its own type in
  `Arial, Helvetica, sans-serif`.
- Logos must not be recoloured outside the two sanctioned fills, stretched, rotated, or
  placed on insufficient-contrast backgrounds. See `guidelines/`.
- The `KILogo_*` files are the **Knauf Insulation** sub-brand. Do not mix them with the
  primary `KNAUFLogo*` marks on the same surface.

## What is actually shipped

Runtime assets live at upstream paths and are tracked in [`SEAMS.md`](../../SEAMS.md)
under Static Assets:

- `client/public/assets/knauf-logo.png` — landing + top bar
- `client/public/assets/knauf-social-preview.png` — OG/Twitter card
- `client/public/assets/{favicon-16x16,favicon-32x32,apple-touch-icon-180x180}.png`

The palette and the wordmark path are additionally transcribed **as text** into
[`skill/karl-brand/SKILL.md`](../../skill/karl-brand/SKILL.md) and
[`skill/karl-brand/references/logo.md`](../../skill/karl-brand/references/logo.md), because
a sandboxed artifact preview can load neither a binary asset nor a network request. That
transcription is what agent-authored deliverables use.

**If a colour there and a colour here disagree, `colours/` wins — fix the skill.** The
authoritative digital values are in `colours/Knauf Colors.html`; the print references are
in `colours/KNAUF_FinalColours_PsoCV3_0.pdf`.

One inconsistency to know about, already resolved in the skill: the colour sheet lists
Knauf Cyan Blue as `#0099DE` while giving its RGB as 0,160,230, which is `#00A0E6`. The
ruling is `#0099DE` for digital surfaces and charts, `#00A0E6` for the logo mark fill only
— the latter is what the official SVG uses.

## Adding a runtime asset

1. Export from here into `client/public/assets/`.
2. Add a SEAMS.md → Static Assets row (what it is, and why it is Knauf-only).
3. Reference it by absolute path (`/assets/...`) — upstream `ConvoIcon` only dispatches to
   its URL renderer for values containing `http`, so a relative path falls through to the
   endpoint-icon fallback.

Note that a runtime asset still does not reach artifact previews. Those are sandboxed with
no reliable network, which is why the wordmark is transcribed as an inline SVG path.

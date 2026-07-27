# The Knauf wordmark

Earlier guidance told you to render a *text* wordmark, because the logo lived at
`/assets/knauf-logo.png` and a sandboxed preview cannot load it. **That is obsolete.**

The official wordmark is a single-path SVG. Embedding the path inline needs **zero
network**, so the real mark works in every artifact type. Never type the wordmark.

## The mark

This is the only copy of the path data. Everything below refers back to it.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 283.4646 143.4898"
     role="img" aria-label="Knauf" focusable="false">
  <path fill="#00A0E6" d="M197.5438,118.3649c18.5564,0,26.0413-5.926,28.0685-20.4293l9.3562-66.746h-19.0242l-9.3562,67.3698c-0.4678,3.5868-2.6509,5.1463-7.0171,5.1463s-6.0815-1.5595-5.6137-5.1463l9.5121-67.3698h-19.0242l-9.3562,66.746C173.0618,112.5948,179.6112,118.3649,197.5438,118.3649z M141.5628,87.0193l11.2274-41.4823h1.7153l-3.1187,41.4823H141.5628z M115.2096,116.3376h18.5564l4.0543-15.127h12.4749l-1.0916,15.127h18.7123l3.5865-85.1479h-31.3432L115.2096,116.3376z M57.5132,116.3376H75.134l5.9256-41.9501h1.0916l10.2918,41.9501h17.9326l12.0071-85.1479h-17.6208l-6.2374,44.1334h-1.0916l-9.9799-44.1334H69.5203L57.5132,116.3376z M0,116.3376h19.0242l5.3018-37.2717h1.8712l7.1731,37.2717h19.3361L43.974,71.1125L63.31,31.1897H44.1299L27.6007,65.1865h-1.4034L35.3975,0H16.3733L0,116.3376z M247.7308,143.4898l9.5365-67.6988h18.4005l2.0272-14.3473h-18.4005l2.1831-15.9067h19.9598l2.0272-14.3473h-38.984l-15.7739,112.3001H247.7308z"/>
</svg>
```

The aspect ratio is 283.4646 × 143.4898 (≈1.975:1). Size by height and let width
follow; never set both and never stretch.

## React — `KnaufWordmark`

Declare it once near the top of the artifact, then use it wherever the mark appears.
Copy this block whole — the path data is repeated here deliberately so you never
have to transcribe it between sections.

```tsx
function KnaufWordmark({ height = 28, fill = '#FFFFFF' }) {
  return (
    <svg
      viewBox="0 0 283.4646 143.4898"
      height={height}
      width={height * 1.9755}
      role="img"
      aria-label="Knauf"
      focusable="false"
    >
      <path fill={fill} d="M197.5438,118.3649c18.5564,0,26.0413-5.926,28.0685-20.4293l9.3562-66.746h-19.0242l-9.3562,67.3698c-0.4678,3.5868-2.6509,5.1463-7.0171,5.1463s-6.0815-1.5595-5.6137-5.1463l9.5121-67.3698h-19.0242l-9.3562,66.746C173.0618,112.5948,179.6112,118.3649,197.5438,118.3649z M141.5628,87.0193l11.2274-41.4823h1.7153l-3.1187,41.4823H141.5628z M115.2096,116.3376h18.5564l4.0543-15.127h12.4749l-1.0916,15.127h18.7123l3.5865-85.1479h-31.3432L115.2096,116.3376z M57.5132,116.3376H75.134l5.9256-41.9501h1.0916l10.2918,41.9501h17.9326l12.0071-85.1479h-17.6208l-6.2374,44.1334h-1.0916l-9.9799-44.1334H69.5203L57.5132,116.3376z M0,116.3376h19.0242l5.3018-37.2717h1.8712l7.1731,37.2717h19.3361L43.974,71.1125L63.31,31.1897H44.1299L27.6007,65.1865h-1.4034L35.3975,0H16.3733L0,116.3376z M247.7308,143.4898l9.5365-67.6988h18.4005l2.0272-14.3473h-18.4005l2.1831-15.9067h19.9598l2.0272-14.3473h-38.984l-15.7739,112.3001H247.7308z" />
    </svg>
  );
}
```

Call site: `<KnaufWordmark height={28} fill="#FFFFFF" />`

Never shorten, re-type, or "clean up" the `d` string. It is 880 characters of
coordinate data with no redundancy — any edit silently deforms the letterforms,
and there is no error to tell you.

## `text/html`

Paste the `<svg>` from the block above directly into the markup and size it in CSS:

```css
.knauf-mark { height: 28px; width: auto; display: block; }
```

## `image/svg+xml`

Ship the block above as the whole file. Keep `xmlns` and `viewBox`; omit `width`
and `height` so the mark scales to its container.

## Fill and placement rules

| Background | Fill | Ratio |
|---|---|---|
| The `#003778` brand bar | `#FFFFFF` | 11.55 |
| White or a light surface | `#00A0E6` | 2.93 — logotype exemption |

**Never `#003778`** — the brand book states Accessible Blue is never used for the
logo. The 2.93:1 figure is deliberate and legal: WCAG 1.4.11 exempts logotypes from
the contrast requirement. Do not "fix" it by darkening the mark, and do not reuse
`#00A0E6` for anything that is not the logo.

Placement:

- Product naming — "KARL", a deck title, a report title — is a **separate text label
  beside the mark**, divided by a hairline or a gap. Never fused into it, never
  re-typeset as part of the logo. A logo is not typography you edit.
- Leave clear space around the mark at least equal to the height of the "K".
- Minimum height 20px on screen; below that the counters close up.
- Never rotate, stretch, skew, outline, add a shadow, or place the mark on a busy
  or low-contrast fill.

## Do not use

- The PNG and EPS assets in the brand kit. They are binary, unreachable from a
  preview, and not needed — the inline SVG is the only form an artifact can consume.
- The kit's alternate `logo.svg` (viewBox `0 0 473.7 294.4`). It carries its fill in
  a `<style>.st0{…}</style>` block, which inline means a class-name collision with
  the host page, a fill you cannot parameterise, and a `<style>` tag inside JSX.
- `/assets/logo.svg` in the app — that is still the upstream LibreChat mark, not Knauf.

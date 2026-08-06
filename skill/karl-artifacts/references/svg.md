# Native SVG artwork

Use `image/svg+xml` only for logos, icons, diagrams, and self-contained vector illustrations, including small declarative animations. Use React for interactive UI or controlled animation, Mermaid for structural diagrams, and PNG/PDF for full pages and slide decks. Do not convert HTML or React to SVG, and never present a screenshot embedded in SVG as editable vector artwork.

## Source contract

- Emit one well-formed XML document with one `<svg>` root and no prose inside the artifact.
- Set `xmlns="http://www.w3.org/2000/svg"` and a meaningful finite `viewBox`; omit fixed `width` and `height`. Reject a missing, empty, invalid, zero-area, `NaN` or `Infinity` viewBox.
- Use real vector paths, shapes, text, and groups. Do not embed raster payloads.
- Use explicit presentation attributes or inline fills and strokes from approved brand values. Do not rely on CSS variables, external stylesheets, or inherited KARL light/dark theme values. Create explicit light and dark variants when both are required.
- Give every definition, gradient, mask, and clip path a unique stable ID. Check for duplicate IDs and broken `url(#id)` or fragment references.
- Include a concise `<title>` and `<desc>` for accessibility.
- Preserve editable copy as `<text>`. State that approved fonts must be installed in Illustrator or Photoshop; do not silently outline text or embed licensed fonts.

## Security and compatibility

- No `script` elements or event-handler attributes such as `onload`.
- No `javascript:` URLs, remote references, external `href`, or external resources.
- No `foreignObject` elements.
- No `image` elements, including data-URI raster images.
- Avoid filters, blend modes, complex masks, browser-only CSS, and experimental constructs unless explicitly requested and tested in the target editor.
- Keep coordinates finite and conservative. Check malformed XML, multiple roots, duplicate IDs, and unresolved internal references before delivery.
- Keep the UTF-8 source below the artifact limit of 4 MiB.

## Declarative animation

- Use no-JavaScript platform primitives only: internal CSS keyframes or SVG `<animate>`, `<animateTransform>`, `<animateMotion>`, and `<set>`. The script and event-handler ban still applies.
- Prefer internal CSS for transforms and opacity so `@media (prefers-reduced-motion: reduce)` can disable the motion. A `<style>` block may contain only local selectors, keyframes, and media queries — no `@import`, external URL, or remote font.
- Give the artwork a meaningful static base state. Animation must enhance that state, never carry the only copy, status, or instruction.
- Default to one finite sequence that completes within five seconds. Set an explicit duration and final state (`animation-fill-mode: forwards` or `fill="freeze"`). Do not use `repeatCount="indefinite"`; route looping, pause/play controls, user-triggered motion, and presentation timelines to React.
- Never flash more than three times in one second. Avoid large zoom, parallax, or sweeping motion that can trigger vestibular discomfort.
- Keep timing deterministic. PNG and PDF export capture one still frame after the preview settles; the downloaded SVG preserves the animation source. Make the state at five seconds useful and complete.
- Keep animated IDs and timing references unique and stable. Avoid event-chained or cross-element timing such as `other.end`; use explicit `begin`, `dur`, `values`, and `keyTimes`.

## Raster references and vector tracing

- “Convert/vectorize this PNG or JPEG” means tracing or recreating shapes, not ordinary export. Never wrap the pixels in `<image>` or a data URI and call the result vector artwork.
- For a simple flat icon, logo-like mark, line drawing, or scan, recreate it with real paths, shapes, and text. Preserve the original aspect ratio and state that an automatic or visual trace is approximate.
- Do not trace a complex photograph, texture, gradient-heavy image, or detailed generated picture into path soup. Keep it raster, or ask for a deliberately simplified poster/icon interpretation.
- Do not claim to have run VTracer, Potrace, ImageTracer, or another tracing library unless that tool is actually available in the current runtime. Any tracer output must still pass every source, security, accessibility, size, ID, and reference rule in this document.
- Optimizing existing SVG and vectorizing raster input are different operations. Optimization must not remove titles, descriptions, animation elements, final states, or referenced IDs.

## Knauf wordmark

Before using the Knauf wordmark, read `skills/karl-brand/references/logo.md`. Use its official approved vector path and rules. Never type, redraw, trace, or approximate the wordmark.

The downloaded `.svg` is the source of truth. PNG and PDF are render alternatives; they do not replace or regenerate the vector source.

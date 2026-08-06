# Native SVG artwork

Use `image/svg+xml` only for logos, icons, diagrams, and static vector illustrations. Use React for interactive UI, Mermaid for structural diagrams, and PNG/PDF for full pages and slide decks. Do not convert HTML or React to SVG, and never present a screenshot embedded in SVG as editable vector artwork.

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

## Knauf wordmark

Before using the Knauf wordmark, read `skills/karl-brand/references/logo.md`. Use its official approved vector path and rules. Never type, redraw, trace, or approximate the wordmark.

The downloaded `.svg` is the source of truth. PNG and PDF are render alternatives; they do not replace or regenerate the vector source.

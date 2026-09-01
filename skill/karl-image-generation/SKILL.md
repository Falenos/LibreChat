---
name: karl-image-generation
description: Create or edit images with Karl. Use for image generation, reference-image edits, compositing, posters, infographics, portraits, product visuals, illustrations, in-image text, or choosing GPT Image quality, dimensions, and format.
---

# Karl Image Generation

## Workflow routing

| Request                                                            | Tool             | Inputs                                                           |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------- |
| New image based only on text                                       | `image_gen_oai`  | Prompt only                                                      |
| Any request depending on an uploaded or previously generated image | `image_edit_oai` | Prompt plus every relevant visible image ID, in the user's order |

Image IDs must come from visible conversation context, never inference. One request produces one image call and one result unless the user explicitly asks for variants.

## Prompt recipe

A controllable prompt follows: intended use → scene/background → subject → composition → concrete details → style/medium → constraints.

- State viewpoint, framing, subject placement, lighting, materials, texture, palette, and mood when they matter.
- For photographs, say `photorealistic` and describe the visual result. Treat camera specifications as high-level look guidance, not exact physical simulation.
- Literal in-image text belongs in quotes with requested typography and placement. Text rendering is not guaranteed; the visible result must be checked before claiming exactness.
- An edit prompt names the change and the invariants: identity, geometry, layout, branding, camera, and background.
- For multiple references, identify their roles in the prompt: `Image 1: base scene`, `Image 2: subject`, `Image 3: style reference`.
- Prefer a clean first result followed by small single-change iterations over one overloaded prompt.

## Select output settings

| Need                                               | Quality  | Size                                         | Format                                         |
| -------------------------------------------------- | -------- | -------------------------------------------- | ---------------------------------------------- |
| Fast draft, thumbnail, iteration                   | `low`    | `1024x1024` or requested 1024-class aspect   | `jpeg` for photos; `png` otherwise             |
| Normal final asset                                 | `medium` | `1024x1024`, `1536x1024`, or `1024x1536`     | `jpeg` for photos; `png` for graphics/text     |
| Dense text, identity, brand-critical detail, print | `high`   | requested size; use 2K/4K only when explicit | `png` unless photographic size/latency matters |

- Prefer square when aspect ratio is unspecified; square is typically fastest.
- `output_compression: 85` is the normal JPEG setting; a higher value makes a smaller, more compressed file. Compression does not apply to PNG.
- Karl's current Azure GPT Image 2 API supports PNG and JPEG, not WebP or transparent output. Background is `auto` or `opaque`.
- Treat output above `2560x1440` as experimental. Avoid 2K/4K cost and latency unless the use case needs it.
- Karl's current image-edit tool does not expose an `input_fidelity` control. Reference preservation comes from explicit edit invariants, not a promised fidelity mode.

## Preserve Knauf branding

Knauf-branded visuals take their palette and wordmark treatment from `skills/karl-brand/SKILL.md`. Exact logos come from brand assets rather than image-model approximations.

## Finish honestly

A successful result is already visible, so the accompanying response stays brief. An error or empty result is a failure, never a completed image.

import type { ExtendedJsonSchema } from '~/tools/registry/definitions';

/** Model-visible output controls shared by GPT Image 2 generation and editing. */
export const gptImage2OutputProperties: Record<string, ExtendedJsonSchema> = {
  quality: {
    type: 'string',
    enum: ['auto', 'low', 'medium', 'high'],
    default: 'auto',
    description:
      'Rendering quality. Use low for fast drafts, medium for normal final assets, and high only for detail-, text-, identity-, or print-critical output.',
  },
  size: {
    type: 'string',
    pattern: '^(?:auto|[1-9]\\d{2,3}x[1-9]\\d{2,3})$',
    default: 'auto',
    description:
      'Output size. Popular choices: 1024x1024 square, 1536x1024 landscape, 1024x1536 portrait, 2048x2048 2K square, 2048x1152 2K landscape, 3840x2160 4K landscape, 2160x3840 4K portrait. Custom edges must be multiples of 16, each at most 3840, aspect ratio at most 3:1, and total pixels 655360-8294400. Prefer 1024-class output unless the user explicitly needs 2K/4K.',
  },
  output_format: {
    type: 'string',
    enum: ['png', 'jpeg'],
    default: 'png',
    description: 'Output format. Use jpeg for opaque photographs and png for graphics or text.',
  },
  output_compression: {
    type: 'integer',
    minimum: 0,
    maximum: 100,
    default: 85,
    description: 'JPEG compression level. Ignored for PNG; 0 is no compression and 100 is maximum.',
  },
  background: {
    type: 'string',
    enum: ['auto', 'opaque'],
    default: 'auto',
    description:
      'Background behavior. The configured Azure GPT Image 2 API does not support transparent output.',
  },
};

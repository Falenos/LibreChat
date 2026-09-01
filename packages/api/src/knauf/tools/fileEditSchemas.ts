import type { ExtendedJsonSchema } from '~/tools/registry/definitions';

// [knauf] KK20-297 — schemas for request-scoped IDML/XML inspection and edits.
export const editIdmlSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['inspect', 'replace_text'],
      description: 'Inspect story text or export an IDML with exact story-text edits.',
    },
    filename: {
      type: 'string',
      maxLength: 255,
      description:
        'Exact attached IDML filename. Omit to inspect or replace across all attached IDML files.',
    },
    query: {
      type: 'string',
      maxLength: 10000,
      description: 'Optional case-sensitive text filter for inspect.',
    },
    offset: { type: 'integer', minimum: 0, description: 'Inspect result offset. Defaults to 0.' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Inspect result limit per file. Defaults to 50.',
    },
    replacements: {
      type: 'array',
      maxItems: 100,
      description: 'Exact text replacements. Ambiguous matches require replace_all=true.',
      items: {
        type: 'object',
        properties: {
          find: { type: 'string', minLength: 1, maxLength: 100000 },
          replace: { type: 'string', maxLength: 100000 },
          replace_all: { type: 'boolean', description: 'Replace every exact occurrence.' },
        },
        required: ['find', 'replace'],
        additionalProperties: false,
      },
    },
    segment_edits: {
      type: 'array',
      maxItems: 100,
      description:
        'Replace whole segments returned by inspect. Select one filename when using this field.',
      items: {
        type: 'object',
        properties: {
          segment_id: { type: 'string', pattern: '^s\\d+-c\\d+(?:-p\\d+)?$' },
          text: { type: 'string', maxLength: 100000 },
        },
        required: ['segment_id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['action'],
  additionalProperties: false,
};

export const editXmlSchema: ExtendedJsonSchema = {
  ...editIdmlSchema,
  properties: {
    ...editIdmlSchema.properties,
    action: {
      type: 'string',
      enum: ['inspect', 'replace_text'],
      description: 'Inspect XML text nodes or export XML with exact text-node edits.',
    },
    filename: {
      type: 'string',
      maxLength: 255,
      description: 'Exact attached XML filename. Omit to inspect or replace across all XML files.',
    },
    segment_edits: {
      type: 'array',
      maxItems: 100,
      description:
        'Replace whole XML text nodes only when the user explicitly supplies a segment_id returned by inspect; never infer a segment_id from a text-only request or use one to bypass ambiguity. Select one filename when using this field.',
      items: {
        type: 'object',
        properties: {
          segment_id: { type: 'string', pattern: '^x\\d+$' },
          text: { type: 'string', maxLength: 100000 },
        },
        required: ['segment_id', 'text'],
        additionalProperties: false,
      },
    },
  },
};
// End [knauf]

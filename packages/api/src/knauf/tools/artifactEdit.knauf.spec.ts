import { getToolDefinition } from '~/tools/registry/definitions';

describe('[knauf] edit_artifact tool contract', () => {
  it('exposes exact replacements and a required server revision token', () => {
    const definition = getToolDefinition('edit_artifact');

    expect(definition).toEqual(
      expect.objectContaining({
        name: 'edit_artifact',
        toolType: 'builtin',
        description: expect.stringContaining('Do not re-emit'),
        schema: expect.objectContaining({
          type: 'object',
          required: ['identifier', 'expected_sha256', 'replacements'],
          properties: expect.objectContaining({
            identifier: expect.objectContaining({ type: 'string' }),
            expected_sha256: expect.objectContaining({ type: 'string' }),
            replacements: expect.objectContaining({ type: 'array', minItems: 1, maxItems: 25 }),
          }),
        }),
      }),
    );
  });
});

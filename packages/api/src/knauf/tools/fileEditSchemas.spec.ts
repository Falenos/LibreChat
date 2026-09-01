/// <reference types="jest" />
import { getToolDefinition } from '../../tools/registry/definitions';
import { editIdmlSchema, editXmlSchema } from './fileEditSchemas';

describe('[knauf] IDML edit schema', () => {
  it.each(['s0-c0', 's0-c0-p0', 's12-c34-p56'])('accepts parser segment id %s', (segmentId) => {
    const segmentEdits = editIdmlSchema.properties?.segment_edits as {
      items?: { properties?: { segment_id?: { pattern?: string } } };
    };
    const pattern = segmentEdits.items?.properties?.segment_id?.pattern;

    expect(pattern).toBeDefined();
    expect(new RegExp(pattern as string).test(segmentId)).toBe(true);
  });
});

describe('[knauf] XML edit schema', () => {
  it('reserves segment edits for user-selected segment ids', () => {
    const segmentEdits = editXmlSchema.properties?.segment_edits as { description?: string };

    expect(segmentEdits.description).toContain('user explicitly supplies');
    expect(segmentEdits.description).toContain('never infer');
  });

  it('tells the model to refuse attribute edits without calling the tool', () => {
    const description = getToolDefinition('edit_xml')?.description;

    expect(description).toContain('Attribute editing is unsupported');
    expect(description).toContain('do not call this tool for an attribute edit');
    expect(description).toContain('no output file was created');
  });
});

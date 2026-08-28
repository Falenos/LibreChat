/// <reference types="jest" />
import { editIdmlSchema } from './fileEditSchemas';

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

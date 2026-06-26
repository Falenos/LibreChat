/**
 * [knauf] KK20-194 — guards the open_url registry definition.
 *
 * open_url is a Knauf-only structured tool and was originally absent from the
 * registry, so `getToolDefinition('open_url')` returned undefined and the
 * model-facing definitions path silently skipped it (the model never received
 * its schema). This test fails if that regression is ever reintroduced.
 */
import { getToolDefinition, openUrlSchema, openUrlDescription } from './definitions';

describe('[knauf] open_url registry definition', () => {
  it('is resolvable via getToolDefinition', () => {
    const def = getToolDefinition('open_url');
    expect(def).toBeDefined();
    expect(def?.name).toBe('open_url');
    expect(def?.toolType).toBe('builtin');
  });

  it('exposes the canonical schema requiring a url', () => {
    const def = getToolDefinition('open_url');
    expect(def?.schema).toBe(openUrlSchema);
    expect(def?.schema.required).toEqual(['url']);
    expect(def?.schema.properties?.url?.type).toBe('string');
  });

  it('carries the untrusted-content framing in its description', () => {
    const def = getToolDefinition('open_url');
    expect(def?.description).toBe(openUrlDescription);
    expect(def?.description).toContain('UNTRUSTED_WEB_CONTENT');
  });
});

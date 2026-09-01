import { gptImage2OutputProperties } from './imageOptions';

describe('[knauf] GPT Image 2 tool schema', () => {
  it('exposes current output controls and excludes unsupported transparency', () => {
    expect(gptImage2OutputProperties.quality.enum).toEqual(['auto', 'low', 'medium', 'high']);
    expect(gptImage2OutputProperties.output_format.enum).toEqual(['png', 'jpeg']);
    expect(gptImage2OutputProperties.output_compression).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 100,
    });
    expect(gptImage2OutputProperties.background.enum).toEqual(['auto', 'opaque']);
    expect(gptImage2OutputProperties.size.pattern).toBeDefined();
  });
});

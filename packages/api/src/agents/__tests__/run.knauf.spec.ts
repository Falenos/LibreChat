// [knauf] Tests for applyKnaufResponseStyle helper (KK20-128).
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { applyKnaufResponseStyle, buildLangfuseConfig } from '../run';

describe('buildLangfuseConfig', () => {
  it('disables trace capture when provider input contains an image', () => {
    const privateImage = 'data:image/png;base64,aW1hZ2UtYnl0ZXM=';
    const messages = [
      new HumanMessage({
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: privateImage } },
        ],
      }),
    ];

    const config = buildLangfuseConfig('tenant-secret', 'message-1', messages);

    expect(config).toEqual({ enabled: false });
    expect(JSON.stringify(config)).not.toContain(privateImage);
    expect(JSON.stringify(config)).not.toContain('tenant-secret');
  });

  it('preserves ordinary text-run correlation', () => {
    const config = buildLangfuseConfig('tenant-1', 'message-1', [new HumanMessage('hello')]);

    expect(config).toEqual({
      deterministicTraceId: true,
      metadata: {
        'librechat.source.message.id': 'message-1',
        'librechat.tenant.id': 'tenant-1',
      },
      tags: ['tenant:tenant-1'],
    });
  });
});

describe('applyKnaufResponseStyle', () => {
  it('is a no-op when neither flag is set', () => {
    const cfg: Record<string, unknown> = {
      provider: 'openAI',
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    };
    const before = { ...cfg };
    applyKnaufResponseStyle(cfg);
    expect(cfg).toEqual(before);
  });

  it('builds reasoning object from flat reasoning_effort when knauf_show_reasoning is true', () => {
    const cfg: Record<string, unknown> = {
      provider: 'openAI',
      knauf_show_reasoning: true,
      reasoning_effort: 'high',
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg.useResponsesApi).toBe(true);
    expect(cfg.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(cfg).not.toHaveProperty('reasoning_effort');
    expect(cfg).not.toHaveProperty('reasoning_summary');
    expect(cfg).not.toHaveProperty('knauf_show_reasoning');
    expect(cfg).not.toHaveProperty('knauf_fast_mode');
  });

  it('defaults effort to medium when no reasoning_effort is set', () => {
    const cfg: Record<string, unknown> = {
      knauf_show_reasoning: true,
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(cfg.useResponsesApi).toBe(true);
  });

  it('preserves an existing flat reasoning_summary value', () => {
    const cfg: Record<string, unknown> = {
      knauf_show_reasoning: true,
      reasoning_effort: 'low',
      reasoning_summary: 'detailed',
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg.reasoning).toEqual({ effort: 'low', summary: 'detailed' });
    expect(cfg).not.toHaveProperty('reasoning_summary');
  });

  it('preserves an already-built reasoning object', () => {
    const cfg: Record<string, unknown> = {
      knauf_show_reasoning: true,
      reasoning: { effort: 'low', summary: 'concise' },
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg.reasoning).toEqual({ effort: 'low', summary: 'concise' });
    expect(cfg.useResponsesApi).toBe(true);
  });

  it('strips all reasoning keys when knauf_fast_mode is true', () => {
    const cfg: Record<string, unknown> = {
      provider: 'openAI',
      knauf_fast_mode: true,
      reasoning_effort: 'high',
      reasoning_summary: 'auto',
      reasoning: { effort: 'high' },
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg).not.toHaveProperty('reasoning_effort');
    expect(cfg).not.toHaveProperty('reasoning_summary');
    expect(cfg).not.toHaveProperty('reasoning');
    expect(cfg).not.toHaveProperty('knauf_fast_mode');
    expect(cfg.provider).toBe('openAI');
  });

  it('lets fast mode win when both flags are on (cost ceiling)', () => {
    const cfg: Record<string, unknown> = {
      knauf_fast_mode: true,
      knauf_show_reasoning: true,
      reasoning_effort: 'high',
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg).not.toHaveProperty('reasoning_effort');
    expect(cfg).not.toHaveProperty('reasoning_summary');
    expect(cfg).not.toHaveProperty('reasoning');
    expect(cfg.useResponsesApi).toBe(true);
    expect(cfg).not.toHaveProperty('knauf_fast_mode');
    expect(cfg).not.toHaveProperty('knauf_show_reasoning');
  });

  it('ignores non-boolean truthy values on the marker keys', () => {
    const cfg: Record<string, unknown> = {
      knauf_fast_mode: 'yes',
      knauf_show_reasoning: 1,
      reasoning_effort: 'high',
    };
    applyKnaufResponseStyle(cfg);
    expect(cfg.reasoning_effort).toBe('high');
    expect(cfg).not.toHaveProperty('reasoning');
    expect(cfg).not.toHaveProperty('useResponsesApi');
    expect(cfg).not.toHaveProperty('knauf_fast_mode');
    expect(cfg).not.toHaveProperty('knauf_show_reasoning');
  });
});
// End [knauf]

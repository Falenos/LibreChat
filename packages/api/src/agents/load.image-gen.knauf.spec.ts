// [knauf] KK20-168 — Tier 5 overlay tests for the `image_gen` toggle
// wiring in loadAgent and loadEphemeralAgent. Asserts the two `[knauf]`
// blocks in packages/api/src/agents/load.ts: the persistent-agent gate
// that strips `image_gen_oai`/`image_edit_oai` when the per-chat toggle is
// OFF, and the ephemeral-agent branch that pushes `image_gen_oai` when
// ON. Lives at an upstream-class path because Jest discovers tests
// alongside the code they exercise; retire with the toggle if upstream
// ever adopts a per-chat image-gen control.
import { loadAgent, loadEphemeralAgent } from './load';
import type { LoadAgentDeps } from './load';
import type { Agent } from 'librechat-data-provider';
// End [knauf]

const noopDeps = (agent: Partial<Agent> | null): LoadAgentDeps => ({
  getAgent: async () => (agent ?? null) as Agent | null,
  getMCPServerTools: async () => null,
});

function makeReq(image_gen?: boolean) {
  return {
    user: { id: 'user_test' },
    body: image_gen === undefined ? {} : { ephemeralAgent: { image_gen } },
  };
}

describe('[knauf] loadAgent — per-chat image_gen gate', () => {
  it('strips image_gen_oai and image_edit_oai when the toggle is OFF', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['file_search', 'image_gen_oai', 'image_edit_oai'],
    };
    const result = await loadAgent(
      {
        req: makeReq(false),
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual(['file_search']);
  });

  it('strips both tools when the toggle is undefined (default OFF)', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['image_gen_oai', 'image_edit_oai'],
    };
    const result = await loadAgent(
      {
        req: makeReq(undefined),
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual([]);
  });

  it('keeps image_gen_oai when the toggle is ON', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['file_search', 'image_gen_oai', 'image_edit_oai'],
    };
    const result = await loadAgent(
      {
        req: makeReq(true),
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual(['file_search', 'image_gen_oai', 'image_edit_oai']);
  });

  it('leaves the tools array untouched when the agent does not have image_gen_oai', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['file_search', 'web_search'],
    };
    const result = await loadAgent(
      {
        req: makeReq(false),
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual(['file_search', 'web_search']);
  });
});

describe('[knauf] loadEphemeralAgent — image_gen branch', () => {
  it('pushes image_gen_oai when ephemeralAgent.image_gen === true', async () => {
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user_test' },
          body: { ephemeralAgent: { image_gen: true } },
        },
        endpoint: 'azureOpenAI',
      },
      noopDeps(null),
    );
    expect(result?.tools).toContain('image_gen_oai');
  });

  it('does not push image_gen_oai when the flag is unset', async () => {
    const result = await loadEphemeralAgent(
      {
        req: { user: { id: 'user_test' }, body: {} },
        endpoint: 'azureOpenAI',
      },
      noopDeps(null),
    );
    expect(result?.tools ?? []).not.toContain('image_gen_oai');
  });
});

// [knauf] KK20-194 — pins the open_url default-enable wiring in
// loadEphemeralAgent. The ephemeral-agent branch in
// packages/api/src/agents/load.ts pushes `open_url` unconditionally so the
// main Karl chat (and every ephemeral/quick chat) can read a pasted URL
// without the user building a custom agent. The persistent-agent default is
// seeded at agent-creation time (api/server/controllers/agents/v1.js), not in
// loadAgent, so this spec also guards that the persistent loadAgent path is
// left untouched (deliberate removal in the builder must stick). Lives at an
// upstream-class path because Jest discovers tests alongside the code they
// exercise; retire with the tool if upstream ever ships a native URL reader.
import { loadAgent, loadEphemeralAgent } from './load';
import type { LoadAgentDeps } from './load';
import type { Agent } from 'librechat-data-provider';
// End [knauf]

const noopDeps = (agent: Partial<Agent> | null): LoadAgentDeps => ({
  getAgent: async () => (agent ?? null) as Agent | null,
  getMCPServerTools: async () => null,
});

describe('[knauf] loadEphemeralAgent — open_url default-enable', () => {
  it('pushes open_url even when no ephemeral tools are toggled', async () => {
    const result = await loadEphemeralAgent(
      {
        req: { user: { id: 'user_test' }, body: {} },
        endpoint: 'azureOpenAI',
      },
      noopDeps(null),
    );
    expect(result?.tools).toContain('open_url');
  });

  it('does not duplicate open_url', async () => {
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user_test' },
          body: { ephemeralAgent: { web_search: true, file_search: true } },
        },
        endpoint: 'azureOpenAI',
      },
      noopDeps(null),
    );
    const occurrences = (result?.tools ?? []).filter((t) => t === 'open_url');
    expect(occurrences).toHaveLength(1);
  });
});

describe('[knauf] loadAgent — persistent path is not force-seeded with open_url', () => {
  it('leaves a stored agent without open_url untouched (removal sticks)', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['file_search'],
    };
    const result = await loadAgent(
      {
        req: { user: { id: 'user_test' }, body: {} },
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual(['file_search']);
    expect(result?.tools).not.toContain('open_url');
  });

  it('preserves open_url when the agent already has it stored', async () => {
    const stored: Partial<Agent> = {
      id: 'agent_persistent',
      tools: ['open_url', 'file_search'],
    };
    const result = await loadAgent(
      {
        req: { user: { id: 'user_test' }, body: {} },
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      noopDeps(stored),
    );
    expect(result?.tools).toEqual(['open_url', 'file_search']);
  });
});

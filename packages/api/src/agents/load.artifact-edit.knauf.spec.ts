// [knauf] NO-TICKET — runtime edit_artifact availability for default chats and
// Agent Builder agents; the internal tool is never persisted in builder config.
import type { Agent } from 'librechat-data-provider';
import { loadAgent, loadEphemeralAgent } from './load';
import type { LoadAgentDeps } from './load';

const deps = (agent: Partial<Agent> | null): LoadAgentDeps => ({
  getAgent: async () => (agent ?? null) as Agent | null,
  getMCPServerTools: async () => null,
});

describe('[knauf] artifact edit tool availability', () => {
  it('adds edit_artifact to artifact-enabled default chats', async () => {
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: { artifacts: 'default' } },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools).toContain('edit_artifact');
  });

  it('adds edit_artifact to artifact-enabled agent-builder agents without persisting it', async () => {
    const stored = {
      id: 'agent_persistent',
      artifacts: 'default',
      tools: ['file_search'],
    } as Partial<Agent>;
    const result = await loadAgent(
      {
        req: { user: { id: 'user-1' }, body: {} },
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      deps(stored),
    );

    expect(result?.tools).toEqual(['file_search', 'edit_artifact']);
    expect(stored.tools).toEqual(['file_search']);
  });

  it('does not expose edit_artifact when artifacts are disabled', async () => {
    const result = await loadEphemeralAgent(
      {
        req: { user: { id: 'user-1' }, body: { ephemeralAgent: {} } },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools ?? []).not.toContain('edit_artifact');
  });
});
// End [knauf]

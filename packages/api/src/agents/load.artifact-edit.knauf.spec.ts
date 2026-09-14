// [knauf] NO-TICKET — runtime edit_artifact availability for default chats and
// Agent Builder agents; the internal tool is never persisted in builder config.
import type { Agent } from 'librechat-data-provider';
import type { LoadAgentDeps } from './load';
import { loadAgent, loadEphemeralAgent, filterSkillPrimedRequestScopedTools } from './load';

const deps = (agent: Partial<Agent> | null): LoadAgentDeps => ({
  getAgent: async () => (agent ?? null) as Agent | null,
  getMCPServerTools: async () => null,
});

describe('[knauf] artifact edit tool availability', () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      KNAUF_FILE_TRANSLATION_ENABLED: 'true',
      AZURE_TRANSLATOR_ENDPOINT: 'https://translator.example.test',
      AZURE_TRANSLATOR_KEY: 'test-key',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

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

    expect(result?.tools).toEqual(['file_search', 'edit_artifact', 'translation_status']);
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

  // KK20-297: file translation is request-scoped, never persisted.
  it.each([
    'datasheet.idml',
    'brief.docx',
    'deck.pptx',
    'sheet.xlsx',
    'scan.pdf',
    'copy.md',
    'labels.json',
    'catalog.xml',
    'art.svg',
    'photo.webp',
  ])('adds translate_file when the current message attaches %s', async (filename) => {
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: {
            ephemeralAgent: {},
            files: [{ file_id: 'file-1', filename, type: '' }],
          },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools).toContain('translate_file');
    expect(result?.tools).toContain('translation_status');
  });

  it('does not expose translate_file for source code reported as text/plain', async () => {
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: {
            ephemeralAgent: {},
            files: [{ file_id: 'source-1', filename: 'component.tsx', type: 'text/plain' }],
          },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools).not.toContain('translate_file');
  });

  it('adds edit_idml only when the current message attaches IDML', async () => {
    const withIdml = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: {}, files: [{ file_id: 'idml-1', filename: 'sample.idml' }] },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );
    const withDocx = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: {}, files: [{ file_id: 'docx-1', filename: 'sample.docx' }] },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(withIdml?.tools).toContain('edit_idml');
    expect(withDocx?.tools).not.toContain('edit_idml');
  });

  it('adds edit_xml only when the current message attaches XML', async () => {
    const withXml = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: {}, files: [{ file_id: 'xml-1', filename: 'sample.xml' }] },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );
    const withJson = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: {}, files: [{ file_id: 'json-1', filename: 'sample.json' }] },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(withXml?.tools).toEqual(expect.arrayContaining(['translate_file', 'edit_xml']));
    expect(withJson?.tools).toContain('translate_file');
    expect(withJson?.tools).not.toContain('edit_xml');
  });

  it('adds translate_file to a persistent runtime clone without changing stored tools', async () => {
    const stored = { id: 'agent_persistent', tools: ['file_search'] } as Partial<Agent>;
    const result = await loadAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: {
            files: [
              {
                file_id: 'idml-1',
                filename: 'datasheet',
                type: 'application/vnd.adobe.indesign-idml-package',
              },
            ],
          },
        },
        agent_id: 'agent_persistent',
        endpoint: 'agents',
      },
      deps(stored),
    );

    expect(result?.tools).toEqual([
      'file_search',
      'translation_status',
      'translate_file',
      'edit_idml',
    ]);
    expect(stored.tools).toEqual(['file_search']);
  });

  it('keeps translate_file disabled when the rollout switch is off', async () => {
    process.env.KNAUF_FILE_TRANSLATION_ENABLED = 'false';
    const result = await loadEphemeralAgent(
      {
        req: {
          user: { id: 'user-1' },
          body: { ephemeralAgent: {}, files: [{ file_id: 'file-1', filename: 'brief.docx' }] },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );
    process.env.KNAUF_FILE_TRANSLATION_ENABLED = 'true';

    expect(result?.tools).not.toContain('translate_file');
    expect(result?.tools).not.toContain('translation_status');
  });

  it('keeps durable translation jobs addressable on later messages without attachments', async () => {
    const result = await loadEphemeralAgent(
      {
        req: { user: { id: 'user-1' }, body: { ephemeralAgent: {} } },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools).toContain('translation_status');
    expect(result?.tools).not.toContain('translate_file');
  });

  it('does not expose artifact-returning file tools on compatibility APIs', async () => {
    const result = await loadEphemeralAgent(
      {
        req: {
          originalUrl: '/api/agents/v1/chat/completions',
          user: { id: 'user-1' },
          body: {
            ephemeralAgent: {},
            files: [{ file_id: 'idml-1', filename: 'sample.idml' }],
          },
        },
        endpoint: 'azureOpenAI',
      },
      deps(null),
    );

    expect(result?.tools).not.toEqual(
      expect.arrayContaining(['translate_file', 'translation_status', 'edit_idml']),
    );
  });
});
// End [knauf]

// [knauf] KK20-297 — a skill's `allowed-tools` frontmatter (e.g.
// `karl-file-translation/SKILL.md` declaring `translate_file`) must not bypass
// the per-request grant computed by `getRequestScopedFileTools`.
describe('[knauf] filterSkillPrimedRequestScopedTools', () => {
  it('drops a skill-primed request-scoped tool that was not granted for this request', () => {
    const result = filterSkillPrimedRequestScopedTools(['translate_file'], []);
    expect(result).toEqual([]);
  });

  it('keeps a skill-primed request-scoped tool that was granted for this request', () => {
    const result = filterSkillPrimedRequestScopedTools(
      ['translate_file'],
      ['translate_file', 'translation_status'],
    );
    expect(result).toEqual(['translate_file']);
  });

  it('leaves non-request-scoped tools untouched regardless of grants', () => {
    const result = filterSkillPrimedRequestScopedTools(['execute_code', 'read_file'], []);
    expect(result).toEqual(['execute_code', 'read_file']);
  });

  it('filters a mixed list, keeping ordinary tools and only granted request-scoped tools', () => {
    const result = filterSkillPrimedRequestScopedTools(
      ['execute_code', 'translate_file', 'edit_idml', 'read_file'],
      ['edit_idml'],
    );
    expect(result).toEqual(['execute_code', 'edit_idml', 'read_file']);
  });
});
// End [knauf]

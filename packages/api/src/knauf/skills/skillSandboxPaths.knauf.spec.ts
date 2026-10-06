import { Types } from 'mongoose';
import { Readable } from 'stream';
import { Constants } from '@librechat/agents';
import type {
  ToolExecuteBatchRequest,
  ToolExecuteResult,
  ToolCallRequest,
} from '@librechat/agents';
import type { ToolExecuteOptions } from '~/agents/handlers';
import { describeSkillSandboxMount, skillSandboxPath } from './skillSandboxPaths';
import { createToolExecuteHandler } from '~/agents/handlers';

function invokeHandler(
  handler: ReturnType<typeof createToolExecuteHandler>,
  toolCalls: ToolCallRequest[],
): Promise<ToolExecuteResult[]> {
  return new Promise((resolve, reject) => {
    const request: ToolExecuteBatchRequest = { toolCalls, resolve, reject };
    handler.handle('on_tool_execute', request);
  });
}

const SKILL_ID = new Types.ObjectId();
const skill = {
  _id: SKILL_ID as unknown as never,
  name: 'karl-docx',
  body: '# Word files',
  fileCount: 1,
  version: 1,
};

describe('[knauf] skill sandbox paths (KK20-397)', () => {
  it('names the real mount path of a bundled file', () => {
    expect(skillSandboxPath('karl-brand', 'sandbox/knauf-fonts.zip')).toBe(
      '/mnt/data/karl-brand/sandbox/knauf-fonts.zip',
    );
  });

  it('says nothing when priming was not attempted, and says so plainly when it failed', () => {
    expect(describeSkillSandboxMount('karl-docx', null)).toBe('');
    expect(describeSkillSandboxMount('karl-docx', [])).toContain('could not be placed');
  });

  it('tells the model where a primed skill’s files are, via the skill tool result', async () => {
    const req = { user: { id: 'user-1' } };
    const handler = createToolExecuteHandler({
      loadTools: jest.fn(async () => ({
        loadedTools: [],
        configurable: { codeEnvAvailable: true, req },
      })),
      getSkillByName: jest.fn(async () => skill),
      listSkillFiles: jest.fn(async () => [
        {
          relativePath: 'scripts/karl_docx.py',
          filename: 'karl_docx.py',
          filepath: '/app/skill/karl-docx/scripts/karl_docx.py',
          source: 'deployment',
          bytes: 9,
        },
      ]) as unknown as ToolExecuteOptions['listSkillFiles'],
      getStrategyFunctions: jest.fn(() => ({
        getDownloadStream: jest.fn(async () => Readable.from(Buffer.from('print(1)\n'))),
      })) as unknown as ToolExecuteOptions['getStrategyFunctions'],
      batchUploadCodeEnvFiles: jest.fn(async () => ({
        storage_session_id: 'karl-00000000000000000000000000000000',
        files: [
          { fileId: 'f-md', filename: 'karl-docx/SKILL.md' },
          { fileId: 'f-py', filename: 'karl-docx/scripts/karl_docx.py' },
        ],
      })) as unknown as ToolExecuteOptions['batchUploadCodeEnvFiles'],
    });

    const [result] = await invokeHandler(handler, [
      { id: 'call_skill', name: Constants.SKILL_TOOL, args: { skillName: 'karl-docx' } },
    ]);

    expect(result.status).toBe('success');
    expect(result.content).toContain(
      'mounted read-only in the code sandbox under /mnt/data/karl-docx/',
    );
    expect(result.content).toContain('/mnt/data/karl-docx/scripts/karl_docx.py');
    expect(result.content).toContain('python3 -B');
  });

  it('points read_file’s bash hint for a binary skill file at the real mount path', async () => {
    const handler = createToolExecuteHandler({
      loadTools: jest.fn(async () => ({
        loadedTools: [],
        configurable: { accessibleSkillIds: [SKILL_ID] },
      })),
      getSkillByName: jest.fn(async () => skill),
      getSkillFileByPath: jest.fn(async () => ({
        relativePath: 'sandbox/knauf-fonts.zip',
        filename: 'knauf-fonts.zip',
        filepath: '/app/skill/karl-docx/sandbox/knauf-fonts.zip',
        source: 'deployment',
        mimeType: 'application/zip',
        bytes: 1024,
        isBinary: true,
      })) as unknown as ToolExecuteOptions['getSkillFileByPath'],
    });

    const [result] = await invokeHandler(handler, [
      {
        id: 'call_read',
        name: Constants.READ_FILE,
        args: { path: 'skills/karl-docx/sandbox/knauf-fonts.zip' },
      },
    ]);

    expect(result.content).toContain('/mnt/data/karl-docx/sandbox/knauf-fonts.zip');
    expect(result.content).not.toContain('/mnt/data/skills/');
  });
});

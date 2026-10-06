const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const mockAxios = jest.fn(async () => ({ data: PNG }));
jest.mock('axios', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockAxios(...(args as [])),
}));
jest.mock('~/auth/codeapi', () => ({ getCodeApiAuthHeaders: jest.fn(async () => ({})) }));

import { Constants } from '@librechat/agents';
import { createToolExecuteHandler } from '~/agents/handlers';
import type {
  ToolExecuteBatchRequest,
  ToolExecuteResult,
  ToolCallRequest,
} from '@librechat/agents';

function invoke(
  handler: ReturnType<typeof createToolExecuteHandler>,
  toolCalls: ToolCallRequest[],
): Promise<ToolExecuteResult[]> {
  return new Promise((resolve, reject) => {
    const request: ToolExecuteBatchRequest = { toolCalls, resolve, reject };
    handler.handle('on_tool_execute', request);
  });
}

const req = { user: { id: 'user-1' } };
const readCall = (path: string): ToolCallRequest =>
  ({
    id: 'call-read',
    name: Constants.READ_FILE,
    args: { path },
    codeSessionContext: {
      session_id: 'karl-x',
      files: [
        {
          id: 'file-1',
          name: '_karl_qa/sheet-1.png',
          storage_session_id: 'karl-00000000000000000000000000000000',
          kind: 'user',
        },
      ],
    },
  }) as unknown as ToolCallRequest;

describe('[knauf] visual QA through read_file (KK20-397)', () => {
  const previous = process.env.KNAUF_CODE_VISUAL_QA_ENABLED;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.KNAUF_CODE_VISUAL_QA_ENABLED;
    } else {
      process.env.KNAUF_CODE_VISUAL_QA_ENABLED = previous;
    }
    mockAxios.mockClear();
  });

  const build = () => {
    const toolEndCallback = jest.fn();
    const readSandboxFile = jest.fn();
    const handler = createToolExecuteHandler({
      loadTools: jest.fn(async () => ({
        loadedTools: [],
        configurable: { codeEnvAvailable: true, req },
      })),
      toolEndCallback,
      readSandboxFile,
    });
    return { handler, toolEndCallback, readSandboxFile };
  };

  it('returns the render as an image for the model and never re-saves it as an attachment', async () => {
    process.env.KNAUF_CODE_VISUAL_QA_ENABLED = 'true';
    const { handler, toolEndCallback, readSandboxFile } = build();
    const [result] = await invoke(handler, [readCall('/mnt/data/_karl_qa/sheet-1.png')]);
    expect(result.status).toBe('success');
    expect(result.content).toContain('Image: /mnt/data/_karl_qa/sheet-1.png');
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: 'arraybuffer',
        maxRedirects: 0,
        url: expect.stringContaining(
          '/download/karl-00000000000000000000000000000000/file-1?kind=user&id=user-1',
        ),
      }),
    );
    expect(toolEndCallback).not.toHaveBeenCalled();
    expect(readSandboxFile).not.toHaveBeenCalled();
  });

  it('keeps upstream behaviour for an ordinary image when the flag is off', async () => {
    const { handler } = build();
    const [result] = await invoke(handler, [readCall('/mnt/data/chart.png')]);
    expect(result.status).toBe('error');
    expect(mockAxios).not.toHaveBeenCalled();
  });
});

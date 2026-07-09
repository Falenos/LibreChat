/**
 * Knauf seam test — agent FileSearch uploads use the configured agents cap.
 *
 * Pins the `[knauf]` block inside `client/src/hooks/Files/useFileHandling.ts`:
 * agent-scoped `file_search` uploads pass validation with the agents endpoint
 * limit from config instead of overriding it in the client.
 */
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint, EToolResources } from 'librechat-data-provider';

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
});

const mockShowToast = jest.fn();
const mockMutate = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({
    showToast: mockShowToast,
  }),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn(() => jest.fn()),
  // v0.8.7: useFileHandling now reads `store.isTemporary` via useRecoilValue.
  // This spec renders the hook without a RecoilRoot and only asserts on the
  // resolved endpointFileConfig, so a fixed non-temporary value is sufficient.
  useRecoilValue: jest.fn(() => false),
}));

jest.mock('~/store', () => ({
  ephemeralAgentByConvoId: jest.fn(() => ({ key: 'mock-ephemeral-agent' })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: jest.fn(),
    refetchQueries: jest.fn(),
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: jest.fn(() => ({
    data: {
      endpoints: {
        agents: {
          fileLimit: 35,
          fileSizeLimit: 50,
          totalSizeLimit: 100,
        },
      },
    },
  })),
  useUploadFileMutation: jest.fn(() => ({
    mutate: mockMutate,
  })),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: jest.fn((key: string) => key),
  TranslationKeys: {},
}));
// v0.8.7: a dependency hook in the useFileHandling chain imports `{ useLocalize }` from the
// `~/hooks` barrel (not the specific module above), so mock the barrel export too.
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Files/useDelayedUploadToast', () => ({
  useDelayedUploadToast: () => ({
    startUploadTimer: jest.fn(),
    clearUploadTimer: jest.fn(),
  }),
}));

jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: jest.fn(async (file: File) => file),
}));

jest.mock('~/hooks/Files/useClientResize', () => ({
  __esModule: true,
  default: () => ({
    resizeImageIfNeeded: jest.fn(async (file: File) => ({ file, resized: false })),
  }),
}));

jest.mock('~/hooks/Files/useUpdateFiles', () => ({
  __esModule: true,
  default: () => ({
    addFile: jest.fn(),
    replaceFile: jest.fn(),
    updateFileById: jest.fn(),
    deleteFileById: jest.fn(),
  }),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
  removePreviewEntry: jest.fn(),
}));

const mockValidateFiles = jest.requireMock('~/utils').validateFiles as jest.Mock;

describe('useFileHandling — Knauf FileSearch configured count limit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function runValidation(toolResource: EToolResources) {
    const { useFileHandlingNoChatContext } = await import('~/hooks/Files/useFileHandling');
    const files = new Map();
    const setFiles = jest.fn();
    const { result } = renderHook(() =>
      useFileHandlingNoChatContext(
        {
          additionalMetadata: {
            agent_id: 'agent-1',
            tool_resource: toolResource,
          },
          endpointOverride: EModelEndpoint.agents,
          endpointTypeOverride: EModelEndpoint.agents,
        },
        {
          files,
          setFiles,
          conversation: null,
        },
      ),
    );

    await act(async () => {
      await result.current.handleFiles([
        new File(['hello'], 'knowledge.txt', { type: 'text/plain' }),
      ]);
    });

    return mockValidateFiles.mock.calls[0][0].endpointFileConfig;
  }

  it('uses the agents file count limit for agent FileSearch uploads', async () => {
    const endpointFileConfig = await runValidation(EToolResources.file_search);

    expect(endpointFileConfig.fileLimit).toBe(35);
    expect(endpointFileConfig.disabled).toBe(false);
    expect(endpointFileConfig.fileSizeLimit).toBeGreaterThan(0);
    expect(endpointFileConfig.supportedMimeTypes.length).toBeGreaterThan(0);
  });

  it('keeps the file count limit for non-FileSearch agent uploads', async () => {
    const endpointFileConfig = await runValidation(EToolResources.context);

    expect(endpointFileConfig.fileLimit).toBe(35);
  });
});

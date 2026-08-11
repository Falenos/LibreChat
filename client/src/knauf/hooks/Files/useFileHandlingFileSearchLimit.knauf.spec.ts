/**
 * Knauf seam test — agent FileSearch uploads use the configured agents policy.
 *
 * Pins the `[knauf]` block inside `client/src/hooks/Files/useFileHandling.ts`:
 * agent-scoped `file_search` uploads pass validation with the agents endpoint
 * limits from config instead of overriding them in the client.
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

// Deliberately NOT `requireActual` here, unlike the `~/utils` mock below: the real
// `~/data-provider` pulls in the whole TanStack Query layer and would need a
// QueryClientProvider around every render. Missing exports are added explicitly instead —
// `useGetEndpointsQuery` is needed because the import graph reaching this hook grew
// (upstream #12163, via the main merge) to include DragDropContext.
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: undefined })),
  useGetAgentByIdQuery: jest.fn(() => ({ data: undefined })),
  // [knauf] KK20-257 — `useKnaufCodeDestinationAllowed` reads the spec list to mirror the
  // server's `ephemeralAgent.execute_code || modelSpec.executeCode`. Default spec enables
  // code, matching librechat.yaml, so these suites exercise the production shape.
  useGetStartupConfig: jest.fn(() => ({
    data: { modelSpecs: { list: [{ name: 'karl', default: true, executeCode: true }] } },
  })),
  useGetFileConfig: jest.fn(() => ({
    data: {
      endpoints: {
        agents: {
          fileLimit: 0,
          fileSizeLimit: 50,
          totalSizeLimit: 0,
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

// Spread the real module rather than replacing it. This mock used to list only the five
// helpers the hook calls directly, which silently removed everything else `~/utils` exports
// — including `cn`. That was survivable only while nothing else in the import graph needed
// it; the upstream tool-call UI redesign (#12163, arriving via the main merge) pulled
// SourceHovercard into the chain `useFileHandling → useAgentToolPermissions → ~/Providers`,
// and the suite started failing with `(0, _utils.cn) is not a function` — a module-loading
// error with nothing to do with what these tests assert.
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
  removePreviewEntry: jest.fn(),
}));

const mockValidateFiles = jest.requireMock('~/utils').validateFiles as jest.Mock;

describe('useFileHandling — Knauf FileSearch configured upload policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function runValidation(toolResource: EToolResources, fileCount = 1) {
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
      await result.current.handleFiles(
        Array.from(
          { length: fileCount },
          (_, index) => new File(['hello'], `knowledge-${index}.txt`, { type: 'text/plain' }),
        ),
      );
    });

    return mockValidateFiles.mock.calls[0][0];
  }

  it('keeps agent FileSearch count and aggregate limits disabled for large batches', async () => {
    const validation = await runValidation(EToolResources.file_search, 12);
    const { endpointFileConfig, fileList } = validation;

    expect(endpointFileConfig.fileLimit).toBe(0);
    expect(endpointFileConfig.totalSizeLimit).toBe(0);
    expect(endpointFileConfig.disabled).toBe(false);
    expect(endpointFileConfig.fileSizeLimit).toBeGreaterThan(0);
    expect(endpointFileConfig.supportedMimeTypes.length).toBeGreaterThan(0);
    expect(fileList).toHaveLength(12);
  });

  it('keeps the same unlimited count policy for non-FileSearch agent uploads', async () => {
    const { endpointFileConfig } = await runValidation(EToolResources.context);

    expect(endpointFileConfig.fileLimit).toBe(0);
    expect(endpointFileConfig.totalSizeLimit).toBe(0);
  });
});

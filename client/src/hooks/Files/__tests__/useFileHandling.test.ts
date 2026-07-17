import { renderHook, act } from '@testing-library/react';
import {
  Constants,
  EModelEndpoint,
  EToolResources,
  getEndpointFileConfig,
} from 'librechat-data-provider';
// [knauf] KK20-227 — reset the module-level document-upload queue between tests.
import { _resetDocumentUploadQueue } from '../useFileHandling';
// End [knauf]

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  Object.defineProperty(global, 'Image', {
    writable: true,
    value: class {
      width = 640;
      height = 480;
      onload: (() => void) | null = null;

      set src(_src: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  });
});

const mockShowToast = jest.fn();
const mockSetFilesLoading = jest.fn();
// [knauf] KK20-227 — the document/image upload path now awaits `mutateAsync`
// (serialized multi-file uploads); point both mutation methods at one recording
// spy that resolves, so the existing formData assertions keep working.
const mockMutate = jest.fn((_formData: FormData) => Promise.resolve());
// End [knauf]
const mockAddFile = jest.fn();
const mockUpdateFileById = jest.fn();
const mockDeleteFileById = jest.fn();
let mockUploadOptions: {
  onError?: (error: unknown, body: FormData) => void;
} = {};
const mockProcessFileForUpload = jest.fn(
  async (_file: File, _quality?: number, _onProgress?: (progress: number) => void) => _file,
);
const mockLocalize = jest.fn((key: string) => key);

let mockConversation: Record<string, string | null | undefined> = {};
let mockIsTemporary = false;
let mockFileConfig: Record<string, unknown> | null = null;

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    files: new Map(),
    setFiles: jest.fn(),
    setFilesLoading: mockSetFilesLoading,
    conversation: mockConversation,
  })),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(() => ({
    showToast: mockShowToast,
  })),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn(() => jest.fn()),
  useRecoilValue: jest.fn(() => mockIsTemporary),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { isTemporary: { key: 'isTemporary' } },
  ephemeralAgentByConvoId: jest.fn(() => ({ key: 'mock' })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({
    getQueryData: jest.fn(),
    refetchQueries: jest.fn(),
  })),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: jest.fn(() => ({ data: mockFileConfig })),
  useUploadFileMutation: jest.fn((opts: typeof mockUploadOptions) => {
    mockUploadOptions = opts;
    return {
      mutate: mockMutate,
      // [knauf] KK20-227 — same spy so document/image uploads (mutateAsync) and
      // the assistant path (mutate) are both recorded by existing assertions.
      mutateAsync: mockMutate,
      // End [knauf]
    };
  }),
}));

jest.mock('~/hooks/useLocalize', () => {
  const fn = jest.fn(() => mockLocalize) as jest.Mock & {
    TranslationKeys: Record<string, never>;
  };
  fn.TranslationKeys = {};
  return { __esModule: true, default: fn, TranslationKeys: {} };
});

jest.mock('../useDelayedUploadToast', () => ({
  useDelayedUploadToast: jest.fn(() => ({
    startUploadTimer: jest.fn(),
    clearUploadTimer: jest.fn(),
  })),
}));

jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: mockProcessFileForUpload,
}));

jest.mock('../useClientResize', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    resizeImageIfNeeded: jest.fn(async (file: File) => ({ file, resized: false })),
  })),
}));

jest.mock('../useUpdateFiles', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    addFile: mockAddFile,
    replaceFile: jest.fn(),
    updateFileById: mockUpdateFileById,
    deleteFileById: mockDeleteFileById,
  })),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
}));

const mockValidateFiles = jest.requireMock('~/utils').validateFiles;

describe('useFileHandling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutate.mockImplementation((_formData: FormData) => Promise.resolve());
    mockProcessFileForUpload.mockImplementation(async (file: File) => file);
    mockConversation = {};
    mockIsTemporary = false;
    mockFileConfig = null;
    // [knauf] KK20-227 — clear the module-level upload queue so a deferred
    // upload from one test can't stall the next.
    _resetDocumentUploadQueue();
    // End [knauf]
  });

  const loadHook = async () => (await import('../useFileHandling')).default;

  // [knauf] KK20-227 — reserve all slots before asynchronous upload work so
  // overlapping picker/paste/drop actions cannot collectively exceed the cap.
  describe('overlapping file-limit enforcement', () => {
    beforeEach(() => {
      mockFileConfig = { endpoints: { default: { fileLimit: 5 } } };
    });

    it('accepts at most five files across overlapping handleFiles calls', async () => {
      let releaseUpload!: () => void;
      const uploadPending = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      mockMutate.mockReturnValue(uploadPending);
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const firstFiles = Array.from(
        { length: 4 },
        (_, index) => new File(['pdf'], `first-${index}.pdf`, { type: 'application/pdf' }),
      );
      const secondFiles = Array.from(
        { length: 4 },
        (_, index) => new File(['pdf'], `second-${index}.pdf`, { type: 'application/pdf' }),
      );

      await act(async () => {
        const first = result.current.handleFiles(firstFiles);
        const second = result.current.handleFiles(secondFiles);
        releaseUpload();
        await Promise.all([first, second]);
      });

      expect(mockAddFile).toHaveBeenCalledTimes(5);
      expect(mockLocalize).toHaveBeenCalledWith('com_knauf_file_limit_partial', {
        0: '1',
        1: '3',
        2: '5',
      });
    });

    it('does not claim overflow files were added when validation rejects the selection', async () => {
      mockValidateFiles.mockReturnValueOnce(false);
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const files = Array.from(
        { length: 6 },
        (_, index) => new File(['pdf'], `file-${index}.pdf`, { type: 'application/pdf' }),
      );

      await act(async () => {
        await result.current.handleFiles(files);
      });

      expect(mockAddFile).not.toHaveBeenCalled();
      expect(mockShowToast).not.toHaveBeenCalled();
    });
  });
  // End [knauf]

  describe('endpointOverride', () => {
    it('uploads non-HEIC images without running HEIC conversion', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const imageFile = new File(['maybe-heic'], 'photo.jpg', { type: 'image/jpeg' });

      await act(async () => {
        await result.current.handleFiles([imageFile]);
      });

      expect(mockProcessFileForUpload).not.toHaveBeenCalled();
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    it('uses conversation endpoint when no override is provided', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const configResult = getEndpointFileConfig({
        endpoint: 'openAI',
        endpointType: 'custom',
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(configResult);
    });

    it('uses endpointOverride for validation instead of conversation endpoint', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({ endpointOverride: EModelEndpoint.agents }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const agentsConfig = getEndpointFileConfig({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(agentsConfig);
    });

    it('falls back to conversation endpoint when endpointOverride is undefined', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'anthropic',
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling({ endpointOverride: undefined }));

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const anthropicConfig = getEndpointFileConfig({
        endpoint: 'anthropic',
        endpointType: undefined,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(anthropicConfig);
    });

    it('sends correct endpoint in upload form data when override is set', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('endpointType')).toBe(EModelEndpoint.agents);
      // [knauf] KK20-203 — the fork stamps the originating conversationId onto agent
      // uploads (see the dedicated "conversationId on chat file uploads" block below),
      // so this is 'convo-1' here where upstream asserts null.
      expect(formData.get('conversationId')).toBe('convo-1');
      // End [knauf]
    });

    it('does not enter assistants upload path when override is agents', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('message_file')).toBeNull();
      expect(formData.get('version')).toBeNull();
      expect(formData.get('model')).toBeNull();
      expect(formData.get('assistant_id')).toBeNull();
    });

    it('enters assistants path without override when conversation is assistants', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
        assistant_id: 'asst-456',
        model: 'gpt-4',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('assistants');
      expect(formData.get('message_file')).toBe('true');
    });

    it('falls back to "default" when no conversation endpoint and no override', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: null,
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('default');
      expect(formData.get('conversationId')).toBeNull();
    });

    it('sends temporary flag for temporary chat uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBe('true');
    });

    it('does not send temporary flag for assistant builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          additionalMetadata: { assistant_id: 'asst-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('assistant_id')).toBe('asst-123');
      // [knauf] KK20-203 — the originating conversationId is stamped onto builder
      // uploads too; upstream asserts null here.
      expect(formData.get('conversationId')).toBe('temporary-convo');
      // End [knauf]
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('does not send temporary flag for agent builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('agent_id')).toBe('agent-123');
      // [knauf] KK20-203 — the originating conversationId is stamped onto builder
      // uploads too; upstream asserts null here.
      expect(formData.get('conversationId')).toBe('temporary-convo');
      // End [knauf]
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('awaits HEIC conversion before uploading the converted file', async () => {
      const convertedFile = new File(['jpeg data'], 'photo.jpg', { type: 'image/jpeg' });
      mockProcessFileForUpload.mockImplementationOnce(
        async (_file: File, _quality?: number, onProgress?: (progress: number) => void) => {
          onProgress?.(1);
          return convertedFile;
        },
      );

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const heicFile = new File(['heic data'], 'photo.bin', { type: 'image/heic' });

      await act(async () => {
        await result.current.handleFiles([heicFile]);
      });

      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_info_heic_converting',
        status: 'info',
        duration: 3000,
      });
      expect(mockProcessFileForUpload).toHaveBeenCalledWith(heicFile, 0.9, expect.any(Function));
      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      const uploadedFile = formData.get('file') as File;
      expect(uploadedFile.name).toBe('photo.jpg');
      expect(uploadedFile.type).toBe('image/jpeg');
    });
  });

  // [knauf] Chat "Upload files" routes documents into File Search (file_search),
  // but images must drop tool_resource and take the vision path (the server rejects
  // images for the file_search resource). KK20-190.
  describe('image→vision tool_resource split', () => {
    beforeEach(() => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: EModelEndpoint.azureOpenAI,
        endpointType: undefined,
      };
    });

    it('drops tool_resource for an image when file_search is requested', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const imageFile = new File([new ArrayBuffer(1024)], 'pic.png', { type: 'image/png' });

      await act(async () => {
        await result.current.handleFiles([imageFile], EToolResources.file_search);
      });

      expect(mockAddFile).toHaveBeenCalledTimes(1);
      expect(mockAddFile.mock.calls[0][0].tool_resource).toBeUndefined();
    });

    it('keeps file_search tool_resource for a document', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const pdfFile = new File([new ArrayBuffer(1024)], 'doc.pdf', { type: 'application/pdf' });

      await act(async () => {
        await result.current.handleFiles([pdfFile], EToolResources.file_search);
      });

      expect(mockAddFile).toHaveBeenCalledTimes(1);
      expect(mockAddFile.mock.calls[0][0].tool_resource).toBe(EToolResources.file_search);
    });
  });
  // End [knauf]

  // [knauf] KK20-203 — chat uploads send the originating conversationId so the
  // server stamps it on the File record and chat deletion can cascade-clean it.
  describe('conversationId on chat file uploads', () => {
    it('appends the conversationId to the upload FormData', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: EModelEndpoint.azureOpenAI,
        endpointType: undefined,
      };
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const pdfFile = new File([new ArrayBuffer(1024)], 'doc.pdf', { type: 'application/pdf' });

      await act(async () => {
        await result.current.handleFiles([pdfFile], EToolResources.file_search);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData = mockMutate.mock.calls[0][0] as FormData;
      expect(formData.get('conversationId')).toBe('convo-1');
    });

    it('omits the conversationId for a brand-new (NEW_CONVO) chat', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: EModelEndpoint.azureOpenAI,
        endpointType: undefined,
      };
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const pdfFile = new File([new ArrayBuffer(1024)], 'doc.pdf', { type: 'application/pdf' });

      await act(async () => {
        await result.current.handleFiles([pdfFile], EToolResources.file_search);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData = mockMutate.mock.calls[0][0] as FormData;
      expect(formData.get('conversationId')).toBeNull();
    });
  });
  // End [knauf]

  // [knauf] KK20-227 — multi-file document uploads run one at a time so we don't
  // fire N concurrent RAG /embed (Azure DI OCR) calls, a primary trigger for the
  // silent OCR-less fallback. Removing the `await mutateAsync` reverts to
  // fire-and-forget and this test fails (both files dispatch immediately).
  describe('KK20-227 sequential multi-file upload', () => {
    // KK20-227: transient transport failures retry once; final failures
    // remain visible instead of silently disappearing from the attachment list.
    it('retries one transient document upload failure', async () => {
      jest.useFakeTimers();
      const transientError = { response: { status: 502 } };
      mockMutate.mockRejectedValueOnce(transientError).mockResolvedValueOnce(undefined);

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const file = new File([new ArrayBuffer(8)], 'retry.pdf', { type: 'application/pdf' });
      let upload: Promise<void>;

      await act(async () => {
        upload = result.current.handleFiles([file]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockMutate).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(1000);
        await upload;
      });
      expect(mockMutate).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
      mockMutate.mockImplementation(() => Promise.resolve());
    });

    it('does not retry a non-transient document upload failure', async () => {
      mockMutate.mockRejectedValueOnce({ response: { status: 400 } });

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const file = new File([new ArrayBuffer(8)], 'invalid.pdf', { type: 'application/pdf' });

      await act(async () => {
        await result.current.handleFiles([file]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      mockMutate.mockImplementation(() => Promise.resolve());
    });

    it('retains the document chip after the retry also fails', async () => {
      jest.useFakeTimers();
      const transientError = { response: { status: 502 } };
      mockMutate.mockImplementation(async (body: FormData) => {
        mockUploadOptions.onError?.(transientError, body);
        throw transientError;
      });

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const file = new File([new ArrayBuffer(8)], 'failed.pdf', { type: 'application/pdf' });
      let upload: Promise<void>;

      await act(async () => {
        upload = result.current.handleFiles([file]);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockDeleteFileById).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(1000);
        await upload;
      });

      expect(mockUpdateFileById).toHaveBeenCalledWith(expect.any(String), { progress: -1 });
      expect(mockDeleteFileById).not.toHaveBeenCalled();

      jest.useRealTimers();
      mockMutate.mockImplementation(() => Promise.resolve());
    });
    it('dispatches the next document upload only after the previous resolves', async () => {
      const resolvers: Array<() => void> = [];
      mockMutate.mockImplementation(() => new Promise<void>((resolve) => resolvers.push(resolve)));

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const f1 = new File([new ArrayBuffer(8)], 'a.pdf', { type: 'application/pdf' });
      const f2 = new File([new ArrayBuffer(8)], 'b.pdf', { type: 'application/pdf' });

      let finished = false;
      await act(async () => {
        void result.current.handleFiles([f1, f2]).then(() => {
          finished = true;
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      // The loop is blocked awaiting the first upload — only one dispatched.
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);

      await act(async () => {
        resolvers[0]?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      // First resolved → the second now dispatches.
      expect(mockMutate).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolvers[1]?.();
        await Promise.resolve();
      });
      expect(finished).toBe(true);

      mockMutate.mockImplementation(() => Promise.resolve());
    });

    it('serializes uploads across two overlapping handleFiles invocations', async () => {
      const resolvers: Array<() => void> = [];
      mockMutate.mockImplementation(() => new Promise<void>((resolve) => resolvers.push(resolve)));

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const f1 = new File([new ArrayBuffer(8)], 'a.pdf', { type: 'application/pdf' });
      const f2 = new File([new ArrayBuffer(8)], 'b.pdf', { type: 'application/pdf' });

      await act(async () => {
        // Two SEPARATE handleFiles calls — as a second file selection or another
        // uploader instance (drag/paste) would trigger. The module-level queue
        // must serialize them too, not just files within one call.
        void result.current.handleFiles([f1]);
        void result.current.handleFiles([f2]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Only the first upload dispatched; the second is queued behind it.
      expect(mockMutate).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolvers[0]?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      // First settled → the second now dispatches.
      expect(mockMutate).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolvers[1]?.();
        await Promise.resolve();
      });

      mockMutate.mockImplementation(() => Promise.resolve());
    });
  });
  // End [knauf]
});

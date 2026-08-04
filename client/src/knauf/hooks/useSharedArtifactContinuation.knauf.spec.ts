import fs from 'fs';
import path from 'path';
import { renderHook } from '@testing-library/react';
import {
  SHARED_ARTIFACT_PARAM,
  buildSharedArtifactPrompt,
  getSharedArtifactContinuationPath,
} from '~/knauf/utils/sharedArtifactContinuation';
import useSharedArtifactContinuation from './useSharedArtifactContinuation';

const mockSetValue = jest.fn();
const mockGetValues = jest.fn();
const mockSetSearchParams = jest.fn();
const mockShowToast = jest.fn();
const mockFocus = jest.fn();
const mockUseGetSharedMessages = jest.fn();
const mockLocalize = jest.fn((key: string) => key);
let mockSearchParams = new URLSearchParams();

jest.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

jest.mock('librechat-data-provider', () => ({
  Constants: { NEW_CONVO: 'new' },
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetSharedMessages: (...args: unknown[]) => mockUseGetSharedMessages(...args),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/common', () => ({
  NotificationSeverity: { ERROR: 'error' },
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => mockLocalize,
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: () => ({
    getValues: mockGetValues,
    setValue: mockSetValue,
  }),
}));

jest.mock('~/knauf/utils/artifactBody', () => ({
  extractSharedArtifactBody: (content: string) => content,
}));

describe('shared artifact continuation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams({ [SHARED_ARTIFACT_PARAM]: 'share-1' });
    mockGetValues.mockReturnValue('Add quarterly revenue.');
    mockUseGetSharedMessages.mockReturnValue({
      data: {
        kind: 'artifact',
        artifact: {
          title: 'KPI dashboard',
          type: 'application/vnd.react',
          language: 'tsx',
          content: 'export default function App() { return <main />; }',
        },
      },
      isError: false,
    });
  });

  it('imports only the shared snapshot into a reviewable new-chat draft', () => {
    const textAreaRef = { current: { focus: mockFocus } as unknown as HTMLTextAreaElement };

    renderHook(() => useSharedArtifactContinuation({ conversationId: 'new', textAreaRef }));

    expect(mockUseGetSharedMessages).toHaveBeenCalledWith('share-1', {
      enabled: true,
      retry: false,
    });
    expect(mockSetValue).toHaveBeenCalledWith(
      'text',
      expect.stringContaining('export default function App()'),
      { shouldDirty: true, shouldValidate: true },
    );
    const importedText = mockSetValue.mock.calls[0][1] as string;
    expect(importedText).toContain('com_knauf_artifact_continue_prompt');
    expect(importedText).toContain('"title":"KPI dashboard"');
    expect(importedText).toContain('Add quarterly revenue.');
    expect(importedText).not.toContain('source conversation');
    expect(mockFocus).toHaveBeenCalled();
    const cleanedParams = mockSetSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(cleanedParams.has(SHARED_ARTIFACT_PARAM)).toBe(false);
    expect(mockSetSearchParams.mock.calls[0][1]).toEqual({ replace: true });
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('is mounted by the chat composer', () => {
    const chatForm = fs.readFileSync(
      path.resolve(__dirname, '../../components/Chat/Input/ChatForm.tsx'),
      'utf8',
    );

    expect(chatForm).toContain('useSharedArtifactContinuation({ conversationId, textAreaRef });');
  });

  it('uses a collision-free source boundary and puts only the opaque ID in the URL', () => {
    const prompt = buildSharedArtifactPrompt(
      {
        title: 'Boundary test',
        type: 'text/plain',
        content: '--- KNAUF SHARED ARTIFACT SOURCE ---',
      },
      'Intro',
      'Request',
    );

    expect(prompt).toContain('--- KNAUF SHARED ARTIFACT SOURCE ----');
    expect(getSharedArtifactContinuationPath('share /?')).toBe(
      '/c/new?artifactShareId=share+%2F%3F',
    );
  });

  it('rejects conversation shares instead of importing their messages', () => {
    mockUseGetSharedMessages.mockReturnValue({
      data: { kind: 'conversation', messages: [{ text: 'private history' }] },
      isError: false,
    });

    renderHook(() =>
      useSharedArtifactContinuation({ conversationId: 'new', textAreaRef: { current: null } }),
    );

    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_knauf_artifact_continue_error',
      severity: 'error',
      showIcon: true,
    });
  });
});

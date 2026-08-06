import fs from 'fs';
import path from 'path';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SHARED_ARTIFACT_PENDING_OPEN } from '~/knauf/utils/sharedArtifactContinuation';
import useSharedArtifactContinuation from './useSharedArtifactContinuation';

const mockNavigateToConvo = jest.fn();
const mockSetSearchParams = jest.fn();
const mockShowToast = jest.fn();
const mockSetCurrentArtifactId = jest.fn();
const mockSetArtifactsVisibility = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockPostContinuation = jest.fn();
const mockLocalize = jest.fn((key: string) => key);
let mockSearchParams = new URLSearchParams();
let mockConversation = {
  conversationId: 'new',
  endpoint: 'agents',
  agent_id: 'recipient-agent',
  title: 'New Chat',
  createdAt: '',
  updatedAt: '',
};
let mockArtifacts: Record<string, unknown> = {};

jest.mock('react-router-dom', () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}));

jest.mock('~/hooks/Conversations/useNavigateToConvo', () => ({
  __esModule: true,
  default: () => ({ navigateToConvo: mockNavigateToConvo }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => mockArtifacts,
  useSetRecoilState: (atom: string) =>
    atom === 'currentArtifactId' ? mockSetCurrentArtifactId : mockSetArtifactsVisibility,
}));

jest.mock('librechat-data-provider', () => ({
  Constants: { NEW_CONVO: 'new' },
  QueryKeys: {
    allConversations: 'allConversations',
  },
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
  useChatContext: () => ({
    conversation: mockConversation,
  }),
}));

jest.mock('~/knauf/data-provider/data-service', () => ({
  postSharedArtifactContinuation: (...args: unknown[]) => mockPostContinuation(...args),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    artifactsState: 'artifactsState',
    currentArtifactId: 'currentArtifactId',
    artifactsVisibility: 'artifactsVisibility',
  },
}));

describe('shared artifact continuation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockSearchParams = new URLSearchParams({ artifactShareId: 'share-1' });
    mockConversation = {
      conversationId: 'new',
      endpoint: 'agents',
      agent_id: 'recipient-agent',
      title: 'New Chat',
      createdAt: '',
      updatedAt: '',
    };
    mockArtifacts = {};
    mockPostContinuation.mockResolvedValue({
      conversation: {
        conversationId: 'recipient-conversation-1',
        endpoint: 'agents',
        title: 'Shared deck',
        createdAt: '2026-08-04',
        updatedAt: '2026-08-04',
      },
      messages: [{ messageId: 'artifact-message-1' }],
      artifactId: 'shared-artifact-1',
    });
  });

  it('clones the snapshot into an owned conversation and navigates without putting code in chat', async () => {
    renderHook(() => useSharedArtifactContinuation({ conversationId: 'new' }));

    await waitFor(() => expect(mockNavigateToConvo).toHaveBeenCalled());

    expect(mockPostContinuation).toHaveBeenCalledWith('share-1', mockConversation);
    expect(mockNavigateToConvo).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'recipient-conversation-1' }),
      { currentConvoId: 'new' },
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith(['allConversations']);
    expect(mockSetSearchParams).toHaveBeenCalledWith(expect.any(URLSearchParams), {
      replace: true,
    });
    expect(JSON.parse(sessionStorage.getItem(SHARED_ARTIFACT_PENDING_OPEN) ?? '{}')).toEqual({
      conversationId: 'recipient-conversation-1',
      artifactId: 'shared-artifact-1',
    });
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('opens the cloned artifact as soon as its persisted message registers it', () => {
    mockSearchParams = new URLSearchParams();
    mockConversation = { ...mockConversation, conversationId: 'recipient-conversation-1' };
    mockArtifacts = { 'shared-artifact-1': { content: 'exact snapshot' } };
    sessionStorage.setItem(
      SHARED_ARTIFACT_PENDING_OPEN,
      JSON.stringify({
        conversationId: 'recipient-conversation-1',
        artifactId: 'shared-artifact-1',
      }),
    );

    act(() => {
      renderHook(() =>
        useSharedArtifactContinuation({ conversationId: 'recipient-conversation-1' }),
      );
    });

    expect(mockSetCurrentArtifactId).toHaveBeenCalledWith('shared-artifact-1');
    expect(mockSetArtifactsVisibility).toHaveBeenCalledWith(true);
    expect(sessionStorage.getItem(SHARED_ARTIFACT_PENDING_OPEN)).toBeNull();
  });

  it('removes the share locator and reports a clone failure', async () => {
    mockPostContinuation.mockRejectedValue(new Error('failed'));

    renderHook(() => useSharedArtifactContinuation({ conversationId: 'new' }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());

    expect(mockNavigateToConvo).not.toHaveBeenCalled();
    const cleanedParams = mockSetSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(cleanedParams.has('artifactShareId')).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_knauf_artifact_continue_error',
      severity: 'error',
      showIcon: true,
    });
  });

  it('is mounted by the chat composer', () => {
    const chatForm = fs.readFileSync(
      path.resolve(__dirname, '../../components/Chat/Input/ChatForm.tsx'),
      'utf8',
    );

    expect(chatForm).toContain('useSharedArtifactContinuation({ conversationId });');
  });
});

// [knauf] message submission analytics seam coverage
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { dispatchAdobeAppInteraction } from '~/knauf/analytics/adobe';
import useChatFunctions from '../useChatFunctions';

// End [knauf]

const mockNavigate = jest.fn();
const mockSetRecoilState = jest.fn();
const mockResetRecoilState = jest.fn();
const mockSetFilesToDelete = jest.fn();
const mockGetEphemeralAgent = jest.fn();
const mockGetSender = jest.fn();
const mockGetExpiry = jest.fn();
const mockQueryClient = {
  getQueryData: jest.fn(),
};

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(() => false),
  useResetRecoilState: jest.fn(() => mockResetRecoilState),
  useSetRecoilState: jest.fn(() => mockSetRecoilState),
  // v0.8.7: useChatFunctions builds drainPendingManualSkills/drainPendingQuotes via
  // useRecoilCallback (and useFocusRegeneratedResponse uses it too). The returned
  // callback must yield an array — `manualSkills.length`/`quotes.length` are read on it.
  useRecoilCallback: jest.fn(() => jest.fn(() => [])),
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => ({
  __esModule: true,
  default: () => mockSetFilesToDelete,
}));

jest.mock('~/hooks/Conversations/useGetSender', () => ({
  __esModule: true,
  default: () => mockGetSender,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: { key: 'isTemporary' },
    isSubmittingFamily: jest.fn((index) => ({ key: `isSubmittingFamily-${index}` })),
    showStopButtonByIndex: jest.fn((index) => ({ key: `showStopButtonByIndex-${index}` })),
    latestMessageFamily: jest.fn((index) => ({ key: `latestMessageFamily-${index}` })),
  },
  useGetEphemeralAgent: () => mockGetEphemeralAgent,
}));

jest.mock('~/data-provider', () => ({
  startupConfigKey: (isAuthenticated: boolean) => ['startupConfig', isAuthenticated],
}));

jest.mock('~/hooks/Input/useUserKey', () => ({
  __esModule: true,
  default: () => ({ getExpiry: mockGetExpiry }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('~/utils', () => ({
  createDualMessageContent: jest.fn(() => []),
  logger: {
    dir: jest.fn(),
    log: jest.fn(),
  },
}));

jest.mock('~/knauf/analytics/adobe', () => ({
  dispatchAdobeAppInteraction: jest.fn(),
}));

function renderUseChatFunctions(overrides = {}) {
  return renderHook(() =>
    useChatFunctions({
      conversation: {
        conversationId: 'conversation-1',
        endpoint: EModelEndpoint.azureOpenAI,
        model: 'gpt-5.4',
      } as TConversation,
      files: new Map(),
      getMessages: () => [],
      isSubmitting: false,
      latestMessage: null,
      setFiles: jest.fn(),
      setMessages: jest.fn(),
      setSubmission: jest.fn(),
      ...overrides,
    }),
  );
}

describe('useChatFunctions — Knauf analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEphemeralAgent.mockReturnValue(null);
    mockGetSender.mockReturnValue('KARL');
    mockGetExpiry.mockReturnValue('expiry-key');
    mockQueryClient.getQueryData.mockImplementation((key) => {
      if (Array.isArray(key) && key[0] === QueryKeys.endpoints) {
        return {
          [EModelEndpoint.azureOpenAI]: {
            type: EModelEndpoint.azureOpenAI,
          },
        };
      }

      if (Array.isArray(key) && key[0] === 'startupConfig') {
        return { modelSpecs: { list: [] } };
      }

      return undefined;
    });
  });

  it('emits a privacy-safe interaction when a user message is submitted', () => {
    const { result } = renderUseChatFunctions();

    act(() => {
      result.current.ask({ text: 'Customer-sensitive message content' });
    });

    expect(dispatchAdobeAppInteraction).toHaveBeenCalledWith({
      action: 'send_chat_message',
      component: 'chat_composer',
      eventSpecification: 'send_chat_message',
      pageSection: 'chat',
    });
  });

  it('does not count regenerate or continue actions as new user message submissions', () => {
    const { result } = renderUseChatFunctions();

    act(() => {
      result.current.ask({ text: 'Repeat previous content' }, { isRegenerate: true });
      result.current.ask({ text: 'Continue response' }, { isContinued: true });
    });

    expect(dispatchAdobeAppInteraction).not.toHaveBeenCalled();
  });
});

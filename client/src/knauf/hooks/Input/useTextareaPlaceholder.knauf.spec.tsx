import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import useTextarea from '~/hooks/Input/useTextarea';

const mockUseChatContext = jest.fn();
const mockGetEntity = jest.fn();
const mockGetSender = jest.fn();
const mockGetEntityName = jest.fn();
const mockSetActivePrompt = jest.fn();
let mockAgentsMap: Record<string, unknown> = {};

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn((atom) => {
    if (atom?.key === 'latestMessageFamily-0') {
      return null;
    }

    return true;
  }),
  useRecoilState: jest.fn(() => [undefined, mockSetActivePrompt]),
  // v0.8.7: useTextarea's dependency graph now calls useRecoilCallback +
  // selectorFamily (both absent from the pre-v0.8.7 mock).
  useRecoilCallback: jest.fn(() => jest.fn()),
  selectorFamily: jest.fn(() => jest.fn()),
}));

// v0.8.7: useTextarea → useLatestMessage → useMessagesCacheSelect reads the query cache,
// so the hook now needs a query client at render time.
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: jest.fn(() => []) }),
  useQuery: () => ({ data: null }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    enterToSend: { key: 'enterToSend' },
    latestMessageFamily: jest.fn((index) => ({ key: `latestMessageFamily-${index}` })),
    activePromptByIndex: jest.fn((index) => ({ key: `activePromptByIndex-${index}` })),
    // v0.8.7: useTextarea → useLatestMessage now reads these atoms/families too.
    conversationIdByIndex: jest.fn((index) => ({ key: `conversationIdByIndex-${index}` })),
    messagesSiblingIdxFamily: jest.fn((id) => ({ key: `messagesSiblingIdxFamily-${id}` })),
    customShortcuts: { key: 'customShortcuts' },
  },
}));

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: () => mockUseChatContext(),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('~/Providers/AssistantsMapContext', () => ({
  useAssistantsMapContext: () => ({}),
}));

jest.mock('~/hooks/Conversations/useGetSender', () => ({
  __esModule: true,
  default: () => mockGetSender,
}));

jest.mock('~/hooks/Files/useFileHandling', () => ({
  __esModule: true,
  default: () => ({ handleFiles: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useInteractionHealthCheck: () => jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    if (key === 'com_endpoint_message_new') {
      return `Message ${values?.[0] ?? ''}`;
    }

    if (key === 'com_endpoint_ai') {
      return 'AI';
    }

    return key;
  },
}));

jest.mock('~/utils', () => ({
  forceResize: jest.fn(),
  insertTextAtCursor: jest.fn(),
  getEntity: (...args: unknown[]) => mockGetEntity(...args),
  getEntityName: (...args: unknown[]) => mockGetEntityName(...args),
  checkIfScrollable: jest.fn(() => false),
}));

function renderUseTextarea(conversation: Partial<TConversation>) {
  const textAreaRef = { current: document.createElement('textarea') };
  const submitButtonRef = { current: document.createElement('button') };

  mockUseChatContext.mockReturnValue({
    index: 0,
    conversation,
    isSubmitting: false,
    filesLoading: false,
    setFilesLoading: jest.fn(),
  });

  renderHook(() =>
    useTextarea({
      textAreaRef,
      submitButtonRef,
      setIsScrollable: jest.fn(),
    }),
  );

  act(() => {
    jest.advanceTimersByTime(100);
  });

  return textAreaRef.current;
}

describe('useTextarea — Knauf composer placeholder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockAgentsMap = {};
    mockGetSender.mockReturnValue('GPT-5.4');
    mockGetEntity.mockReturnValue({ entity: null, isAgent: false, isAssistant: false });
    mockGetEntityName.mockImplementation(({ name }) => name);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('uses Karl for the default Karl model-spec chat', () => {
    const textarea = renderUseTextarea({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-5.4',
      spec: 'karl',
    });

    expect(textarea).toHaveAttribute('placeholder', 'Message Karl');
  });

  it('uses Karl for Karl personality model-spec chats', () => {
    const textarea = renderUseTextarea({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-5.4',
      spec: 'karl-personality-balanced',
    });

    expect(textarea).toHaveAttribute('placeholder', 'Message Karl');
  });

  it('does not infer Karl from runtime model names without a stored spec', () => {
    const textarea = renderUseTextarea({
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-5.4',
    });

    expect(textarea).toHaveAttribute('placeholder', 'Message GPT-5.4');
  });

  it('keeps custom agent names', () => {
    mockAgentsMap = { 'agent-1': { id: 'agent-1' } };
    mockGetEntity.mockReturnValue({
      entity: { name: 'Finance Assistant' },
      isAgent: true,
      isAssistant: false,
    });

    const textarea = renderUseTextarea({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent-1',
      model: 'gpt-5.4',
      spec: 'karl',
    });

    expect(textarea).toHaveAttribute('placeholder', 'Message Finance Assistant');
  });
});

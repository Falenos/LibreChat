import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import ContentRender from '~/components/Messages/ContentRender';
import MessageParts from '~/components/Chat/Messages/MessageParts';
import MessageRender from '~/components/Chat/Messages/ui/MessageRender';

jest.mock('jotai', () => ({
  useAtomValue: jest.fn(() => 'text-base'),
}));

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(() => false),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    maximizeChatSpace: 'maximizeChatSpace',
  },
}));

jest.mock('~/store/fontSize', () => ({
  fontSizeAtom: 'fontSizeAtom',
}));

jest.mock('~/Providers', () => {
  const ReactActual = jest.requireActual('react');
  return {
    MessageContext: ReactActual.createContext({}),
  };
});

jest.mock('~/utils', () => {
  return {
    cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(' '),
    getHeaderPrefixForScreenReader: () => 'Assistant:',
    getMessageAriaLabel: () => 'Assistant message',
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    key === 'com_knauf_powered_by_model' ? `Powered by ${values?.[0]}` : key,
  useContentMetadata: () => ({ hasParallelContent: false }),
  useAttachments: () => ({ attachments: undefined, searchResults: undefined }),
  useMessageActions: () => ({
    ask: jest.fn(),
    edit: false,
    index: 0,
    agent: undefined,
    assistant: undefined,
    enterEdit: jest.fn(),
    conversation: {
      conversationId: 'conversation-1',
      endpoint: 'openAI',
      model: 'azure-gpt-runtime',
    },
    messageLabel: 'GPT-5.4',
    handleFeedback: jest.fn(),
    handleContinue: jest.fn(),
    latestMessageId: 'message-1',
    copyToClipboard: jest.fn(),
    regenerateMessage: jest.fn(),
    latestMessageDepth: 0,
  }),
  useMessageHelpers: () => ({
    ask: jest.fn(),
    edit: false,
    index: 0,
    agent: undefined,
    isLast: true,
    assistant: undefined,
    enterEdit: jest.fn(),
    handleScroll: jest.fn(),
    conversation: {
      conversationId: 'conversation-1',
      endpoint: 'openAI',
      model: 'azure-gpt-runtime',
    },
    isSubmitting: false,
    latestMessageId: 'message-1',
    handleContinue: jest.fn(),
    copyToClipboard: jest.fn(),
    regenerateMessage: jest.fn(),
  }),
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="message-icon" />,
}));

jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: () => <div data-testid="message-content" />,
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: () => <div data-testid="content-parts" />,
}));

jest.mock('~/components/Chat/Messages/ui/PlaceholderRow', () => ({
  __esModule: true,
  default: () => <div data-testid="placeholder-row" />,
}));

jest.mock('~/components/Chat/Messages/SiblingSwitch', () => ({
  __esModule: true,
  default: () => <div data-testid="sibling-switch" />,
}));

jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => <div data-testid="hover-buttons" />,
}));

jest.mock('~/components/Chat/Messages/MultiMessage', () => ({
  __esModule: true,
  default: () => null,
}));

const assistantMessage = {
  messageId: 'message-1',
  conversationId: 'conversation-1',
  parentMessageId: 'parent-1',
  sender: 'GPT-5.4',
  text: 'Answer',
  isCreatedByUser: false,
  createdAt: '2026-06-16T10:05:00.000Z',
  children: [],
  depth: 0,
  content: [{ type: 'text', text: 'Answer' }],
} as unknown as TMessage;

const userMessage = {
  messageId: 'user-message-1',
  conversationId: 'conversation-1',
  parentMessageId: 'parent-0',
  sender: 'Zahar',
  text: 'Question',
  isCreatedByUser: true,
  createdAt: '2026-06-16T09:55:00.000Z',
  children: [],
  depth: 0,
  content: [{ type: 'text', text: 'Question' }],
} as unknown as TMessage;

const responseWithoutCreatedAt = {
  ...assistantMessage,
  messageId: 'message-2',
  createdAt: undefined,
  updatedAt: '2026-06-16T10:06:00.000Z',
} as unknown as TMessage;

const formatExpectedTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

describe('message chrome integration', () => {
  it('uses Karl heading and timestamp in active ContentRender path', () => {
    const { container } = render(
      <ContentRender
        message={assistantMessage}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={0}
        siblingCount={1}
        setSiblingIdx={jest.fn()}
        isSubmitting={false}
        chatContext={
          {
            isSubmitting: false,
          } as never
        }
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by azure-gpt-runtime');
    expect(screen.queryByText('Powered by azure-gpt-runtime')).not.toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-06-16T10:05:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent(
      formatExpectedTimestamp('2026-06-16T10:05:00.000Z'),
    );
  });

  it('uses Karl heading and timestamp in MessageRender', () => {
    const { container } = render(
      <MessageRender
        message={assistantMessage}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={0}
        siblingCount={1}
        setSiblingIdx={jest.fn()}
        isSubmitting={false}
        chatContext={
          {
            isSubmitting: false,
          } as never
        }
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by azure-gpt-runtime');
    expect(screen.queryByText('Powered by azure-gpt-runtime')).not.toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-06-16T10:05:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent(
      formatExpectedTimestamp('2026-06-16T10:05:00.000Z'),
    );
  });

  it('uses Karl heading and timestamp in MessageParts', () => {
    const { container } = render(
      <MessageParts
        message={assistantMessage}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={0}
        siblingCount={1}
        setSiblingIdx={jest.fn()}
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by azure-gpt-runtime');
    expect(screen.queryByText('Powered by azure-gpt-runtime')).not.toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-06-16T10:05:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent(
      formatExpectedTimestamp('2026-06-16T10:05:00.000Z'),
    );
  });

  it('uses fallback timestamp fields for assistant responses', () => {
    const { container } = render(
      <MessageRender
        message={responseWithoutCreatedAt}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={0}
        siblingCount={1}
        setSiblingIdx={jest.fn()}
        isSubmitting={false}
        chatContext={
          {
            isSubmitting: false,
          } as never
        }
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by azure-gpt-runtime');
    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-06-16T10:06:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent(
      formatExpectedTimestamp('2026-06-16T10:06:00.000Z'),
    );
  });

  it('shows date and time on user messages too', () => {
    const { container } = render(
      <MessageParts
        message={userMessage}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={0}
        siblingCount={1}
        setSiblingIdx={jest.fn()}
      />,
    );

    expect(container.querySelector('time')).toHaveAttribute('dateTime', '2026-06-16T09:55:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent(
      formatExpectedTimestamp('2026-06-16T09:55:00.000Z'),
    );
  });
});

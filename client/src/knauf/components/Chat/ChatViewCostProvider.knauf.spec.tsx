import React from 'react';
import { render, screen } from '@testing-library/react';
import ChatView from '~/components/Chat/ChatView';

const mockUseParams = jest.fn();

jest.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
}));

jest.mock('react-hook-form', () => ({
  useForm: () => ({}),
}));

jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

jest.mock('librechat-data-provider', () => ({
  Constants: { NEW_CONVO: 'new' },
  buildTree: jest.fn(),
}));

jest.mock('~/Providers', () => {
  const React = require('react');
  return {
    ChatContext: React.createContext(null),
    AddedChatContext: React.createContext(null),
    ChatFormProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useFileMapContext: () => ({}),
  };
});

jest.mock('~/hooks', () => ({
  useAddedResponse: () => ({}),
  useAdaptiveSSE: jest.fn(),
  useChatHelpers: () => ({ getMessages: jest.fn(), isSubmitting: false }),
  useResumeOnLoad: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: () => ({ data: null, isLoading: false }),
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/knauf/components/Chat/KnaufCostContext', () => ({
  KnaufChatCostProvider: ({
    children,
    conversationId,
  }: {
    children: React.ReactNode;
    conversationId?: string | null;
  }) => (
    <div data-testid="knauf-cost-provider" data-conversation-id={conversationId ?? ''}>
      {children}
    </div>
  ),
}));

jest.mock('~/components/Chat/Input/ConversationStarters', () => () => (
  <div data-testid="conversation-starters" />
));
jest.mock('~/components/Chat/Messages/MessagesView', () => () => <div data-testid="messages" />);
jest.mock('~/components/Chat/Presentation', () => ({ children }: { children: React.ReactNode }) => (
  <div data-testid="presentation">{children}</div>
));
jest.mock('~/components/Chat/Input/ChatForm', () => () => <div data-testid="chat-form" />);
jest.mock('~/components/Chat/Landing', () => () => <div data-testid="landing" />);
jest.mock('~/components/Chat/Header', () => () => <div data-testid="header" />);
jest.mock('~/components/Chat/Footer', () => () => <div data-testid="footer" />);

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    centerFormOnLanding: 'centerFormOnLanding',
    submissionByIndex: () => 'submissionByIndex',
  },
}));

describe('[knauf] ChatView cost provider seam', () => {
  beforeEach(() => {
    mockUseParams.mockReset();
  });

  it('wraps the chat surface with the current conversation cost provider', () => {
    mockUseParams.mockReturnValue({ conversationId: 'conversation-1' });

    render(<ChatView />);

    expect(screen.getByTestId('knauf-cost-provider')).toHaveAttribute(
      'data-conversation-id',
      'conversation-1',
    );
    expect(screen.getByTestId('chat-form')).toBeInTheDocument();
  });
});

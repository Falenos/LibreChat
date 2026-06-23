import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import HoverButtons from '~/components/Chat/Messages/HoverButtons';

jest.mock('recoil', () => ({
  useRecoilState: jest.fn(() => [false, jest.fn()]),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    textToSpeech: 'textToSpeech',
  },
}));

jest.mock('@librechat/client', () => ({
  Clipboard: () => <span data-testid="copy-icon" />,
  CheckMark: () => <span data-testid="check-icon" />,
  ContinueIcon: () => <span data-testid="continue-icon" />,
  EditIcon: () => <span data-testid="edit-icon" />,
  RegenerateIcon: () => <span data-testid="regenerate-icon" />,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGenerationsByLatest: jest.fn(() => ({
    hideEditButton: false,
    regenerateEnabled: false,
    continueSupported: false,
    forkingSupported: true,
    isEditableEndpoint: true,
  })),
}));

jest.mock('~/components/Conversations', () => ({
  Fork: () => <button type="button" data-testid="fork-action" />,
}));

jest.mock('~/components/Chat/Messages/Feedback', () => ({
  __esModule: true,
  default: () => <div data-testid="feedback-buttons" />,
}));

const message = {
  messageId: 'message-1',
  conversationId: 'conversation-1',
  parentMessageId: 'parent-1',
  text: 'Answer',
  isCreatedByUser: false,
  createdAt: '2026-06-16T10:05:00.000Z',
} as TMessage;

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'openAI',
  model: 'gpt-5.4',
} as TConversation;

describe('HoverButtons Knauf behavior', () => {
  it('hides edit and fork controls while keeping copy and feedback actions', () => {
    render(
      <HoverButtons
        index={0}
        isEditing={false}
        enterEdit={jest.fn()}
        copyToClipboard={jest.fn()}
        conversation={conversation}
        isSubmitting={false}
        message={message}
        regenerate={jest.fn()}
        handleContinue={jest.fn()}
        latestMessageId="message-1"
        isLast={true}
        handleFeedback={jest.fn()}
      />,
    );

    expect(screen.getByTitle('com_ui_copy_to_clipboard')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-buttons')).toBeInTheDocument();
    expect(screen.queryByTitle('com_ui_edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fork-action')).not.toBeInTheDocument();
  });
});

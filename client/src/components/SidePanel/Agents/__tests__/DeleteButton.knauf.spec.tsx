// [knauf] Seam test for the Adobe data-layer app_interaction event emitted
// after successful agent deletion.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DeleteButton from '../DeleteButton';
// End [knauf]

const mockDispatchAdobeAppInteraction = jest.fn();
const mockShowToast = jest.fn();
const mockResetForm = jest.fn();
const mockSetConversation = jest.fn();
const mockDeleteMutate = jest.fn();

jest.mock('~/knauf/analytics/adobe', () => ({
  dispatchAdobeAppInteraction: (payload: unknown) => mockDispatchAdobeAppInteraction(payload),
}));

jest.mock('~/data-provider', () => ({
  useDeleteAgentMutation: (options: {
    onSuccess: (_data: unknown, vars: { agent_id: string }, context: unknown) => void;
  }) => ({
    mutate: (vars: { agent_id: string }) => {
      mockDeleteMutate(vars);
      options.onSuccess(undefined, vars, [{ id: 'remaining-agent' }]);
    },
  }),
}));

jest.mock('~/common', () => ({
  isEphemeralAgent: (agentId: string | null | undefined) => !agentId,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationAgentIdByIndex: () => 'conversation-agent-id-atom',
    conversationByIndex: () => 'conversation-atom',
  },
}));

jest.mock('react-hook-form', () => ({
  useFormContext: () => ({ reset: mockResetForm }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => 'other-agent',
  useSetRecoilState: () => mockSetConversation,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  OGDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTemplate: ({
    selection,
    title,
  }: {
    selection: { selectHandler: () => void; selectText: string };
    title: string;
  }) => (
    <div aria-label={title}>
      <button type="button" onClick={selection.selectHandler}>
        {selection.selectText}
      </button>
    </div>
  ),
  OGDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TrashIcon: () => <span data-testid="trash-icon" />,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

describe('[knauf] DeleteButton analytics', () => {
  beforeEach(() => {
    mockDeleteMutate.mockClear();
    mockDispatchAdobeAppInteraction.mockClear();
    mockShowToast.mockClear();
    mockResetForm.mockClear();
    mockSetConversation.mockClear();
  });

  it('dispatches an app_interaction after successful agent deletion', () => {
    render(
      <DeleteButton
        agent_id="agent-123"
        setCurrentAgentId={jest.fn()}
        createMutation={{ data: undefined, isLoading: false, reset: jest.fn() } as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_delete' }));

    expect(mockDeleteMutate).toHaveBeenCalledWith({ agent_id: 'agent-123' });
    expect(mockDispatchAdobeAppInteraction).toHaveBeenCalledWith({
      action: 'delete_agent',
      component: 'agent_builder',
      eventSpecification: 'delete_agent',
      pageSection: 'agent_builder',
    });
  });
});

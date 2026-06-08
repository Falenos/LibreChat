// [knauf] Seam test for the Adobe data-layer app_interaction event emitted
// by the chat attachment menu.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecoilRoot } from 'recoil';
import AttachFileMenu from '../AttachFileMenu';
// End [knauf]

const mockDispatchAdobeAppInteraction = jest.fn();
const mockHandleFileChange = jest.fn();

jest.mock('~/hooks', () => ({
  useAgentCapabilities: () => ({
    codeEnabled: false,
    contextEnabled: false,
    fileSearchEnabled: false,
  }),
  useAgentToolPermissions: () => ({
    codeAllowedByAgent: false,
    fileSearchAllowedByAgent: false,
    provider: undefined,
  }),
  useFileHandlingNoChatContext: () => ({ handleFileChange: mockHandleFileChange }),
  useGetAgentsConfig: () => ({ agentsConfig: {} }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  useSharePointFileHandlingNoChatContext: () => ({
    downloadProgress: 0,
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { sharePointFilePickerEnabled: false } }),
}));

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: () => null,
}));

jest.mock('~/knauf/analytics/adobe', () => ({
  dispatchAdobeAppInteraction: (payload: unknown) => mockDispatchAdobeAppInteraction(payload),
}));

jest.mock('~/utils', () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(' '),
}));

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock('@librechat/client', () => ({
  AttachmentIcon: () => <span data-testid="attachment-icon" />,
  DropdownPopup: ({ trigger }: { trigger: React.ReactNode }) => <div>{trigger}</div>,
  FileUpload: ({
    children,
    handleFileChange,
  }: {
    children: React.ReactNode;
    handleFileChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <div>
      <input data-testid="file-input" type="file" onChange={handleFileChange} />
      {children}
    </div>
  ),
  SharePointIcon: () => <span data-testid="sharepoint-icon" />,
  TooltipAnchor: ({ render: rendered }: { render: React.ReactNode }) => rendered,
}));

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileMenu
          conversationId="conversation-1"
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          conversation={null}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('[knauf] AttachFileMenu analytics', () => {
  beforeEach(() => {
    mockDispatchAdobeAppInteraction.mockClear();
    mockHandleFileChange.mockClear();
  });

  it('dispatches an app_interaction when a local chat file is selected', () => {
    renderMenu();

    fireEvent.change(screen.getByTestId('file-input'), {
      target: {
        files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })],
      },
    });

    expect(mockHandleFileChange).toHaveBeenCalled();
    expect(mockDispatchAdobeAppInteraction).toHaveBeenCalledWith({
      action: 'upload_chat_file',
      component: 'chat_composer',
      eventSpecification: 'upload_chat_file',
      pageSection: 'chat',
    });
  });
});

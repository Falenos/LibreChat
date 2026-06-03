// [knauf] Seam test for the Adobe data-layer app_interaction event emitted
// by the simple chat attachment fallback.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import AttachFile from '../AttachFile';
// End [knauf]

const mockDispatchAdobeAppInteraction = jest.fn();
const mockHandleFileChange = jest.fn();

jest.mock('~/hooks', () => ({
  useFileHandlingNoChatContext: () => ({ handleFileChange: mockHandleFileChange }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/knauf/analytics/adobe', () => ({
  dispatchAdobeAppInteraction: (payload: unknown) => mockDispatchAdobeAppInteraction(payload),
}));

jest.mock('~/utils', () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(' '),
}));

jest.mock('@librechat/client', () => ({
  AttachmentIcon: () => <span data-testid="attachment-icon" />,
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
  TooltipAnchor: ({ render: rendered }: { render: React.ReactNode }) => rendered,
}));

describe('[knauf] AttachFile analytics', () => {
  beforeEach(() => {
    mockDispatchAdobeAppInteraction.mockClear();
    mockHandleFileChange.mockClear();
  });

  it('dispatches an app_interaction when a local chat file is selected', () => {
    render(
      <AttachFile
        files={new Map()}
        setFiles={() => {}}
        setFilesLoading={() => {}}
        conversation={null}
      />,
    );

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

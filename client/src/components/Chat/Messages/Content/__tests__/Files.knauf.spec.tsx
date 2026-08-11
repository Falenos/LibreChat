// [knauf] Message file images retain identity for authenticated URL recovery. (NO-TICKET)
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TAttachment, TFile, TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ fileId }: { fileId?: string }) => <div data-testid="image" data-file-id={fileId} />,
}));

jest.mock('../FilePreviewDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../Parts/Attachment', () => ({
  __esModule: true,
  default: ({ attachment }: { attachment?: TAttachment }) => (
    <div data-testid="artifact" data-file-id={(attachment as Partial<TFile>)?.file_id} />
  ),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: () => null,
}));

describe('Files image recovery contract', () => {
  it('passes the message file id to Image', () => {
    const message = {
      files: [
        {
          file_id: 'message-image-1',
          filename: 'photo.png',
          filepath: '/api/share/share-1/files/message-image-1',
          type: 'image/png',
        },
      ],
    } as TMessage;

    render(<Files message={message} />);

    expect(screen.getByTestId('image')).toHaveAttribute('data-file-id', 'message-image-1');
  });

  it('routes SVG message files to the artifact surface instead of Image', () => {
    const message = {
      files: [
        {
          file_id: 'message-svg-1',
          filename: 'diagram.svg',
          filepath: '/uploads/diagram.svg',
          type: 'image/svg+xml',
        },
      ],
    } as TMessage;

    render(<Files message={message} />);

    expect(screen.getByTestId('artifact')).toHaveAttribute('data-file-id', 'message-svg-1');
    expect(screen.queryByTestId('image')).not.toBeInTheDocument();
  });
});
// End [knauf]

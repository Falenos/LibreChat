// [knauf] Message file images retain identity for authenticated URL recovery. (NO-TICKET)
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import Files from '../Files';

jest.mock('../Image', () => ({
  __esModule: true,
  default: ({ fileId }: { fileId?: string }) => <div data-testid="image" data-file-id={fileId} />,
}));

jest.mock('../FilePreviewDialog', () => ({
  __esModule: true,
  default: () => null,
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
});
// End [knauf]

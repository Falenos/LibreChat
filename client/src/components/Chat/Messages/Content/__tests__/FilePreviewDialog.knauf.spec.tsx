// [knauf] KK20-221 seam test — protects the oversized-file preview gate (Fix A)
// and the abort-on-close cancellation (Fix B). If either seam is removed the
// dialog goes back to buffering large files inline (freeze) or leaking the
// in-flight download after close.
import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { render, screen, act } from '@testing-library/react';
import FilePreviewDialog from '../FilePreviewDialog';
// End [knauf]

const mockRefetch = jest.fn(() => Promise.resolve({ data: null }));
const mockCancelQueries = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ cancelQueries: mockCancelQueries }),
}));

jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: mockRefetch }),
  useSharedFileDownload: () => ({ refetch: mockRefetch }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: undefined }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    (
      ({
        com_knauf_file_preview_too_large: 'This file is too large to preview here.',
        com_ui_download: 'Download',
        com_ui_loading: 'Loading',
        com_ui_preview_unavailable: 'Preview not available',
      }) as Record<string, string>
    )[key] ?? key,
}));

jest.mock('~/utils', () => ({
  logger: { error: jest.fn() },
  sortPagesByRelevance: (pages: number[]) => pages,
  triggerDownload: jest.fn(),
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  // Never reaches the text-preview branch in these tests; render nothing.
  default: () => null,
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => ({ id: 'user-1' }),
}));

jest.mock('~/store', () => ({ __esModule: true, default: { user: 'user-atom' } }));

jest.mock('@librechat/client', () => ({
  OGDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const baseProps = {
  onOpenChange: jest.fn(),
  fileName: 'huge.pdf',
  fileId: 'file-123',
  fileType: 'application/pdf',
};

const ELEVEN_MB = 11 * 1024 * 1024;
const ONE_MB = 1 * 1024 * 1024;

beforeEach(() => {
  mockRefetch.mockClear();
  mockCancelQueries.mockClear();
});

describe('FilePreviewDialog — KK20-221 oversized-file gate', () => {
  it('does not auto-download a file above the inline-preview size limit', async () => {
    await act(async () => {
      render(<FilePreviewDialog {...baseProps} open fileSize={ELEVEN_MB} />);
    });

    expect(screen.getByText('This file is too large to preview here.')).toBeInTheDocument();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('still previews a normally-sized file (gate does not over-block)', async () => {
    await act(async () => {
      render(<FilePreviewDialog {...baseProps} open fileSize={ONE_MB} />);
    });

    expect(screen.queryByText('This file is too large to preview here.')).not.toBeInTheDocument();
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('previews a file whose size is unknown (undefined is not blocked)', async () => {
    await act(async () => {
      render(<FilePreviewDialog {...baseProps} open fileSize={undefined} />);
    });

    expect(mockRefetch).toHaveBeenCalled();
  });
});

describe('FilePreviewDialog — KK20-221 abort on close', () => {
  it('cancels the in-flight download query when the dialog closes', async () => {
    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<FilePreviewDialog {...baseProps} open fileSize={ONE_MB} />));
    });

    expect(mockCancelQueries).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<FilePreviewDialog {...baseProps} open={false} fileSize={ONE_MB} />);
    });

    expect(mockCancelQueries).toHaveBeenCalledWith([QueryKeys.fileDownload, 'file-123']);
  });
});

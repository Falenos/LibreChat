import React from 'react';
import { FileSources } from 'librechat-data-provider';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LogLink from '../LogLink';

const mockShowToast = jest.fn();
const mockDownloadFromApi = jest.fn();
const mockDownloadFromUrl = jest.fn();
const mockTriggerDownload = jest.fn();
const mockUseFileDownload = jest.fn();
let mockShareContext: { shareId?: string } = {};
let mockMessageContext: { isLatestMessage?: boolean; isSubmitting?: boolean } = {};
let mockConversationSubmitting = false;

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useFileDownload: (...args: unknown[]) => {
    mockUseFileDownload(...args);
    return { refetch: mockDownloadFromApi };
  },
  useCodeOutputDownload: () => ({ refetch: mockDownloadFromUrl }),
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => mockShareContext,
  useMessageContext: () => mockMessageContext,
  useMessagesViewContext: () => ({ isSubmitting: mockConversationSubmitting }),
}));

jest.mock('~/hooks', () => ({
  AuthContext: require('react').createContext({ user: { id: 'current-user' } }),
  useLocalize: () => (key: string) => (key === 'com_ui_download_error' ? 'Download failed' : key),
}));

jest.mock('~/utils', () => ({
  isHttpDownloadTarget: (target?: string | null) => /^https?:\/\//i.test(target ?? ''),
  triggerDownload: (...args: Parameters<typeof mockTriggerDownload>) =>
    mockTriggerDownload(...args),
}));

describe('LogLink download routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShareContext = {};
    mockMessageContext = {};
    mockConversationSubmitting = false;
  });

  it('navigates directly to http URLs when no stored file metadata is available', async () => {
    const filename = 'report.pptx';
    render(
      <LogLink href="https://cdn.example.com/uploads/report.pptx" filename={filename}>
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'https://cdn.example.com/uploads/report.pptx',
        'report.pptx',
      );
    });

    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
  });

  it('keeps a generated download unavailable until the conversation stream finishes', () => {
    mockConversationSubmitting = true;

    render(
      <LogLink href="https://cdn.example.com/uploads/report.pptx" filename="report.pptx">
        report.pptx
      </LogLink>,
    );

    const link = screen.getByRole('link', { name: 'report.pptx' });
    expect(link).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(link);

    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it('uses the authorized file download route when stored metadata is available', async () => {
    const filename = 'file.pdf';
    mockDownloadFromApi.mockResolvedValue({ data: 'https://cdn.example.com/signed/file.pdf' });

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename={filename}
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'https://cdn.example.com/signed/file.pdf',
        'file.pdf',
      );
    });
    expect(mockDownloadFromApi).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  // [knauf] KK20-366 — tool-result links share the hook-level guard while signed URLs resolve.
  it('ignores a second click while an authenticated download is pending', async () => {
    let resolveDownload: (value: { data: string }) => void;
    mockDownloadFromApi.mockImplementation(
      () =>
        new Promise<{ data: string }>((resolve) => {
          resolveDownload = resolve;
        }),
    );

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename="file.pdf"
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        file.pdf
      </LogLink>,
    );

    const link = screen.getByRole('link', { name: 'file.pdf' });
    fireEvent.click(link);
    fireEvent.click(link);

    expect(mockDownloadFromApi).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute('aria-busy', 'true');

    resolveDownload!({ data: 'https://cdn.example.com/signed/file.pdf' });

    await waitFor(() => {
      expect(link).toHaveAttribute('aria-busy', 'false');
    });
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
  });

  // [knauf] KK20-366 — translated attachments can be streamed before their file.user metadata.
  it('uses the authenticated user for a newly streamed stored file without attachment metadata', async () => {
    mockDownloadFromApi.mockResolvedValue({ data: 'https://cdn.example.com/signed/file.pdf' });

    render(
      <LogLink
        file_id="file-1"
        filename="file.pdf"
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        file.pdf
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'file.pdf' }));

    await waitFor(() => {
      expect(mockUseFileDownload).toHaveBeenCalledWith(
        'current-user',
        'file-1',
        expect.objectContaining({ source: FileSources.cloudfront }),
      );
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'https://cdn.example.com/signed/file.pdf',
        'file.pdf',
      );
    });
  });

  it('routes downloads through the share-scoped route in a shared view', async () => {
    mockShareContext = { shareId: 'share-9' };
    const filename = 'file.pdf';

    render(
      <LogLink href="/api/share/share-9/files/file-1" file_id="file-1" filename={filename}>
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        '/api/share/share-9/files/file-1/download',
        'file.pdf',
      );
    });
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
    expect(mockDownloadFromUrl).not.toHaveBeenCalled();
  });

  it('keeps legacy code-output handles on the blob download path', async () => {
    const filename = 'legacy.txt';
    mockDownloadFromUrl.mockResolvedValue({ data: 'blob:https://app.example.com/file' });

    render(
      <LogLink
        href="/api/files/code/download/session-1/file-1"
        filename={filename}
        source={FileSources.execute_code}
      >
        {filename}
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: filename }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith(
        'blob:https://app.example.com/file',
        'legacy.txt',
      );
    });
    expect(mockDownloadFromUrl).toHaveBeenCalledTimes(1);
    expect(mockDownloadFromApi).not.toHaveBeenCalled();
  });

  // [knauf] KK20-366 — failures must be visible and leave the caller free to retry.
  it('shows a localized error when the authenticated download request fails', async () => {
    mockDownloadFromApi.mockRejectedValue(new Error('temporary storage failure'));

    render(
      <LogLink
        user="user-1"
        file_id="file-1"
        filename="file.pdf"
        source={FileSources.cloudfront}
        href="https://cdn.example.com/uploads/file.pdf"
      >
        file.pdf
      </LogLink>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'file.pdf' }));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'Download failed',
      });
    });
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });
});

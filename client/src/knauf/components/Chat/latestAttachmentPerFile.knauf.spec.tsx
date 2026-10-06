import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { AttachmentGroup } from '~/components/Chat/Messages/Content/Parts/Attachment';
import { latestAttachmentPerFile } from './latestAttachmentPerFile';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: () => ({ style: {}, ref: { current: null } }),
}));

jest.mock('~/components/Chat/Messages/Content/Parts/LogLink', () => ({
  useAttachmentLink: () => ({
    isDownloading: false,
    isDownloadDisabled: false,
    handleDownload: jest.fn(),
  }),
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file }: { file: { filename?: string } }) => (
    <div data-testid="file-container">{file.filename ?? ''}</div>
  ),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'File' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
}));

const file = (fileId: string | undefined, filename: string, extra: object = {}): TAttachment =>
  ({
    file_id: fileId,
    filename,
    filepath: `/files/${filename}`,
    ...extra,
  }) as unknown as TAttachment;

describe('[knauf] latestAttachmentPerFile', () => {
  it('keeps the last attachment of a file written by several runs', () => {
    const first = file('f1', 'report.zip', { toolCallId: 'run-1' });
    const second = file('f1', 'report.zip', { toolCallId: 'run-2' });
    expect(latestAttachmentPerFile([first, second])).toEqual([second]);
  });

  it('keeps distinct files, in the order of their last occurrence', () => {
    const a1 = file('a', 'a.zip', { toolCallId: 'run-1' });
    const b = file('b', 'b.zip');
    const a2 = file('a', 'a.zip', { toolCallId: 'run-2' });
    expect(latestAttachmentPerFile([a1, b, a2])).toEqual([b, a2]);
  });

  it('leaves attachments without a file_id alone', () => {
    const anonymous = [file(undefined, 'x.zip'), file(undefined, 'x.zip')];
    expect(latestAttachmentPerFile(anonymous)).toHaveLength(2);
  });

  it('returns the same array when nothing repeats', () => {
    const list = [file('a', 'a.zip'), file('b', 'b.zip')];
    expect(latestAttachmentPerFile(list)).toBe(list);
  });
});

describe('[knauf] AttachmentGroup renders one card per file', () => {
  it('shows a file rebuilt in two code runs once', () => {
    render(
      <AttachmentGroup
        attachments={[
          file('f1', 'knauf-dummy-test.zip', { toolCallId: 'run-1' }),
          file('f1', 'knauf-dummy-test.zip', { toolCallId: 'run-2' }),
        ]}
      />,
    );
    expect(screen.getAllByTestId('file-container')).toHaveLength(1);
  });

  it('still shows two different files', () => {
    render(<AttachmentGroup attachments={[file('a', 'a.zip'), file('b', 'b.zip')]} />);
    expect(screen.getAllByTestId('file-container')).toHaveLength(2);
  });
});

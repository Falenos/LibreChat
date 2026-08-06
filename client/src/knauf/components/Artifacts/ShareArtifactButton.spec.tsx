import { act, fireEvent, render, screen } from '@testing-library/react';
import copy from 'copy-to-clipboard';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Artifact } from '~/common';
import ShareArtifactButton, { getArtifactShareLocator } from './ShareArtifactButton';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
let mutationOptions!: {
  onSuccess?: (share: { _id: string; shareId: string; conversationId: string }) => void;
};

jest.mock('copy-to-clipboard', () => ({
  __esModule: true,
  default: jest.fn(() => true),
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  TooltipAnchor: ({ render }: { render: ReactNode }) => render,
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useCreateArtifactSharedLinkMutation: (options: typeof mutationOptions) => {
    mutationOptions = options;
    return { mutate: mockMutate, isLoading: false };
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  buildShareLinkUrl: (shareId: string) => `https://karl.example/share/${shareId}`,
}));

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: 'artifact-1',
  lastUpdateTime: 0,
  messageId: 'message-1',
  title: 'Artifact',
  type: 'text/markdown',
  content: '# Artifact',
  ...overrides,
});

describe('getArtifactShareLocator', () => {
  it('uses the server file id for generated file artifacts', () => {
    expect(
      getArtifactShareLocator(
        artifact({ sourceFileId: 'file-1', language: 'markdown', index: undefined }),
      ),
    ).toEqual({
      kind: 'file',
      fileId: 'file-1',
      type: 'text/markdown',
      language: 'markdown',
    });
  });

  it('uses the document-order index for inline directives', () => {
    expect(getArtifactShareLocator(artifact({ index: 2 }))).toEqual({
      kind: 'directive',
      index: 2,
    });
  });

  it('uses the immutable revision before the mutable directive locator', () => {
    expect(
      getArtifactShareLocator({
        ...artifact({ index: 2 }),
        knaufRevision: { identifier: 'dashboard', version: 3 },
      } as Artifact & { knaufRevision: { identifier: string; version: number } }),
    ).toEqual({ kind: 'revision', identifier: 'dashboard', version: 3 });
  });

  it('does not create an unverifiable client-content locator', () => {
    expect(getArtifactShareLocator(artifact({ index: undefined }))).toBeNull();
  });
});

describe('ShareArtifactButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates and copies a view-only link without opening an access form', () => {
    render(<ShareArtifactButton artifact={artifact({ index: 0 })} conversationId="convo-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_artifact_share_title' }));

    expect(mockMutate).toHaveBeenCalledWith({
      conversationId: 'convo-1',
      messageId: 'message-1',
      locator: { kind: 'directive', index: 0 },
    });

    act(() => {
      mutationOptions.onSuccess?.({
        _id: 'shared-link-id',
        shareId: 'share-1',
        conversationId: 'convo-1',
      });
    });

    expect(copy).toHaveBeenCalledWith('https://karl.example/share/share-1', {
      format: 'text/plain',
    });
    expect(screen.queryByText('com_ui_shared_link_manage_access')).not.toBeInTheDocument();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_link_copied' }),
    );
  });
});

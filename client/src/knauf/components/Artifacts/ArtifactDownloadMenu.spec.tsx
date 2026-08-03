import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import ArtifactDownloadMenu from './ArtifactDownloadMenu';

const mockPostArtifactExport = jest.fn();
const mockTriggerDownload = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: Readonly<{ children: ReactNode }>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  DropdownMenu: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
  DropdownMenuContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: Readonly<{ children: ReactNode; onSelect: () => void }>) => (
    <button role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Artifacts/useArtifactProps', () => ({
  __esModule: true,
  default: () => ({ fileKey: 'App.tsx' }),
}));

jest.mock('~/Providers/EditorContext', () => ({
  useCodeState: () => ({ currentCode: 'export default () => <main>Edited</main>;' }),
}));

jest.mock('~/knauf/data-provider/data-service', () => ({
  postArtifactExport: (...args: unknown[]) => mockPostArtifactExport(...args),
}));

jest.mock('~/utils/downloadFile', () => ({
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
}));

const artifact = {
  id: 'artifact-1',
  title: 'Quarterly status',
  type: 'application/vnd.react',
  content: 'export default () => <main>Original</main>;',
  lastUpdateTime: 1,
};

describe('ArtifactDownloadMenu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostArtifactExport.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:artifact-export'),
    });
  });

  it('downloads the current edited source', () => {
    render(<ArtifactDownloadMenu artifact={artifact} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_source' }));

    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:artifact-export', 'App.tsx');
    expect(mockPostArtifactExport).not.toHaveBeenCalled();
  });

  it('requests a rendered PNG and downloads the returned blob', async () => {
    render(<ArtifactDownloadMenu artifact={artifact} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_png' }));

    await waitFor(() =>
      expect(mockPostArtifactExport).toHaveBeenCalledWith(
        {
          title: 'Quarterly status',
          type: 'application/vnd.react',
          content: 'export default () => <main>Edited</main>;',
          language: undefined,
        },
        'png',
        undefined,
      ),
    );
    expect(mockTriggerDownload).toHaveBeenCalledWith(
      'blob:artifact-export',
      'Quarterly status.png',
    );
  });

  it('uses the public shared-link export endpoint for recipients', async () => {
    render(<ArtifactDownloadMenu artifact={artifact} shareId="share-1" />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_pdf' }));

    await waitFor(() =>
      expect(mockPostArtifactExport).toHaveBeenCalledWith(expect.any(Object), 'pdf', 'share-1'),
    );
  });
});

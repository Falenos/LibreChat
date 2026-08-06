import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import ArtifactDownloadMenu from './ArtifactDownloadMenu';

const mockPostArtifactExport = jest.fn();
const mockTriggerDownload = jest.fn();
const mockShowToast = jest.fn();
let mockCurrentCode: string | undefined;

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
  useCodeState: () => ({ currentCode: mockCurrentCode }),
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
    mockCurrentCode = 'export default () => <main>Edited</main>;';
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

  it.each([
    ['owner', undefined],
    ['shared', 'share-1'],
  ])('downloads %s native SVG as the exact Unicode vector source', async (_view, shareId) => {
    const content =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Grüße</text></svg>';
    mockCurrentCode = content;
    render(
      <ArtifactDownloadMenu
        artifact={{ ...artifact, title: ' ../Brand:*? ', type: 'image/svg+xml', content }}
        shareId={shareId}
      />,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_svg' }));

    const blob = (URL.createObjectURL as jest.Mock).mock.calls[0][0] as Blob;
    const source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(blob.type).toBe('image/svg+xml');
    expect(source).toBe(content);
    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:artifact-export', '_Brand___.svg');
    expect(mockPostArtifactExport).not.toHaveBeenCalled();
  });

  it('uses artifact.svg when the native SVG title is empty or hostile', () => {
    mockCurrentCode = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';
    render(
      <ArtifactDownloadMenu
        artifact={{ ...artifact, title: '<>:"/\\|?*\u0000', type: 'image/svg+xml' }}
      />,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_svg' }));

    expect(mockTriggerDownload).toHaveBeenCalledWith('blob:artifact-export', 'artifact.svg');
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

  it('exports artifact content before the code editor initializes', async () => {
    mockCurrentCode = '';
    render(<ArtifactDownloadMenu artifact={artifact} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'com_knauf_artifact_download_png' }));

    await waitFor(() =>
      expect(mockPostArtifactExport).toHaveBeenCalledWith(
        expect.objectContaining({ content: artifact.content }),
        'png',
        undefined,
      ),
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

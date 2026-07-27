import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import KnaufCodeExportActions from './KnaufCodeExportActions';
import CodeBar from '~/components/Messages/Content/CodeBar';
import FloatingCodeBar from '~/components/Messages/Content/FloatingCodeBar';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Messages/Content/useCopyCode', () => () => ({
  isCopied: false,
  handleCopy: jest.fn(),
  buttonRef: { current: null },
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => <button type="button" />,
}));

jest.mock('~/components/Messages/Content/LangIcon', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Messages/Content/RunCode', () => ({
  __esModule: true,
  default: () => null,
}));

describe('[knauf] KnaufCodeExportActions', () => {
  const originalBlob = global.Blob;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalWindowOpen = window.open;
  let clickSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:generated-code'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    clickSpy.mockRestore();
    Object.defineProperty(global, 'Blob', { configurable: true, value: originalBlob });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    window.open = originalWindowOpen;
  });

  it('downloads the exact code with the language-specific filename and MIME type', () => {
    const BlobMock = jest.fn(() => ({ type: 'text/x-python;charset=utf-8' }));
    Object.defineProperty(global, 'Blob', { configurable: true, value: BlobMock });
    const code = document.createElement('code');
    code.textContent = 'print("hello")\n';

    render(<KnaufCodeExportActions lang="python" codeRef={{ current: code }} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download' }));

    expect(BlobMock).toHaveBeenCalledWith(['print("hello")\n'], {
      type: 'text/x-python;charset=utf-8',
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy.mock.instances[0]).toMatchObject({
      download: 'generated-code.py',
      href: 'blob:generated-code',
    });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated-code');
  });

  it.each([
    ['html', 'generated-code.html', 'text/html;charset=utf-8'],
    ['javascript', 'generated-code.js', 'text/javascript;charset=utf-8'],
    ['tsx', 'generated-code.tsx', 'text/x-typescript;charset=utf-8'],
    ['json', 'generated-code.json', 'application/json;charset=utf-8'],
    ['unknown-language', 'generated-code.txt', 'text/plain;charset=utf-8'],
  ])('downloads %s code as %s', (lang, filename, mime) => {
    const BlobMock = jest.fn(() => ({ type: mime }));
    Object.defineProperty(global, 'Blob', { configurable: true, value: BlobMock });
    const code = document.createElement('code');
    code.textContent = 'content';

    render(<KnaufCodeExportActions lang={lang} codeRef={{ current: code }} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download' }));

    expect(BlobMock).toHaveBeenCalledWith(['content'], { type: mime });
    expect(clickSpy.mock.instances[0]).toMatchObject({ download: filename });
  });

  it('previews HTML in a sandboxed new-tab iframe with no opener or same-origin access', () => {
    const BlobMock = jest.fn(() => ({ type: 'text/html;charset=utf-8' }));
    Object.defineProperty(global, 'Blob', { configurable: true, value: BlobMock });
    const code = document.createElement('code');
    code.textContent = '<h1>Hello</h1><script>document.body.dataset.ready = "yes"</script>';
    const previewDocument = document.implementation.createHTMLDocument('');
    const previewWindow = { document: previewDocument, opener: window } as unknown as Window;
    window.open = jest.fn(() => previewWindow);

    render(<KnaufCodeExportActions lang="html" codeRef={{ current: code }} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_preview' }));

    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(previewWindow.opener).toBeNull();
    expect(BlobMock).toHaveBeenCalledWith([code.textContent], {
      type: 'text/html;charset=utf-8',
    });
    const iframe = previewDocument.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.getAttribute('src')).toBe('blob:generated-code');

    iframe?.dispatchEvent(new Event('load'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated-code');
  });

  it('is available from both the normal and floating code toolbars', () => {
    const code = document.createElement('code');
    code.textContent = '<h1>Hello</h1>';

    const normal = render(<CodeBar lang="html" codeRef={{ current: code }} />);
    expect(screen.getByRole('button', { name: 'com_ui_preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_download' })).toBeInTheDocument();
    normal.unmount();

    render(<FloatingCodeBar lang="html" codeRef={{ current: code }} isVisible={true} />);
    expect(screen.getByRole('button', { name: 'com_ui_preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_download' })).toBeInTheDocument();
  });
});

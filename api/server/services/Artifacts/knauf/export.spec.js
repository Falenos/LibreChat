const mockScreenshot = jest.fn();
const mockPdf = jest.fn();
const mockSetContent = jest.fn();
const mockGoto = jest.fn();
const mockWaitForTimeout = jest.fn();
const mockPreviewEvaluate = jest.fn();
const mockRoute = jest.fn();
const mockCloseContext = jest.fn();
const mockCloseBrowser = jest.fn();
const mockLaunch = jest.fn();

jest.mock('playwright-core', () => ({
  chromium: {
    launch: (...args) => mockLaunch(...args),
  },
}));
jest.mock('@librechat/api', () => ({ findAllArtifacts: jest.fn() }));

const { ArtifactExportError, getRenderSnapshot, renderArtifact } = require('./export');

const artifact = {
  title: 'Status',
  type: 'text/html',
  content: '<main>Ready</main>',
};

describe('artifact renderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScreenshot.mockResolvedValue(Buffer.from('png'));
    mockPdf.mockResolvedValue(Buffer.from('pdf'));
    mockPreviewEvaluate.mockImplementation(async (callback) => {
      const source = callback.toString();
      if (source.includes('scrollHeight')) {
        return 900;
      }
      if (source.includes("querySelectorAll('button')")) {
        return 1;
      }
      return undefined;
    });
    const previewFrame = {
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: mockPreviewEvaluate,
    };
    mockLaunch.mockResolvedValue({
      newContext: jest.fn().mockResolvedValue({
        route: mockRoute,
        setDefaultTimeout: jest.fn(),
        newPage: jest.fn().mockResolvedValue({
          goto: mockGoto,
          locator: jest.fn().mockReturnValue({
            waitFor: jest.fn().mockResolvedValue(undefined),
            elementHandle: jest.fn().mockResolvedValue({
              contentFrame: jest.fn().mockResolvedValue(previewFrame),
            }),
          }),
          waitForTimeout: mockWaitForTimeout.mockResolvedValue(undefined),
          setViewportSize: jest.fn().mockResolvedValue(undefined),
          setContent: mockSetContent.mockResolvedValue(undefined),
          screenshot: mockScreenshot,
          pdf: mockPdf,
        }),
        close: mockCloseContext,
      }),
      close: mockCloseBrowser,
    });
  });

  it('renders PNG through sandboxed Chromium and destroys the one-time snapshot', async () => {
    let token;
    let secret;
    mockGoto.mockImplementation(async (url) => {
      const parsed = new URL(url);
      token = parsed.pathname.split('/').pop();
      secret = parsed.hash.slice(1);
      expect(getRenderSnapshot(token, secret)).toEqual(artifact);
    });

    await expect(renderArtifact(artifact, 'png')).resolves.toEqual({
      buffer: Buffer.from('png'),
      mime: 'image/png',
      extension: 'png',
    });

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: expect.any(String) }),
    );
    expect(mockRoute).toHaveBeenCalled();
    expect(mockWaitForTimeout).toHaveBeenCalledWith(5000);
    expect(mockScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'png', fullPage: true }),
    );
    expect(() => getRenderSnapshot(token, secret)).toThrow(ArtifactExportError);
    expect(mockCloseContext).toHaveBeenCalled();
    expect(mockCloseBrowser).toHaveBeenCalled();
  });

  it('prints a static screen screenshot for PDF downloads', async () => {
    await expect(renderArtifact(artifact, 'pdf')).resolves.toEqual({
      buffer: Buffer.from('pdf'),
      mime: 'application/pdf',
      extension: 'pdf',
    });

    expect(mockScreenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
    expect(mockSetContent).toHaveBeenCalledWith(
      expect.stringContaining('data:image/png;base64,cG5n'),
      expect.objectContaining({ waitUntil: 'load' }),
    );
    expect(mockPdf).toHaveBeenCalledWith(expect.objectContaining({ printBackground: true }));
  });

  it('captures every navigable slide for PDF and PNG downloads', async () => {
    mockPreviewEvaluate.mockImplementation(async (callback) => {
      const source = callback.toString();
      if (source.includes('scrollHeight')) {
        return 900;
      }
      if (source.includes('button.click')) {
        return true;
      }
      if (source.includes("querySelectorAll('button')")) {
        return 3;
      }
      return undefined;
    });
    mockScreenshot
      .mockResolvedValueOnce(Buffer.from('slide-1'))
      .mockResolvedValueOnce(Buffer.from('slide-2'))
      .mockResolvedValueOnce(Buffer.from('slide-3'));

    await renderArtifact(artifact, 'pdf');

    const pdfMarkup = mockSetContent.mock.calls[0][0];
    expect(pdfMarkup.match(/data:image\/png;base64/g)).toHaveLength(3);
    expect(mockScreenshot).toHaveBeenCalledTimes(3);

    jest.clearAllMocks();
    mockPdf.mockResolvedValue(Buffer.from('pdf'));
    mockScreenshot
      .mockResolvedValueOnce(Buffer.from('slide-1'))
      .mockResolvedValueOnce(Buffer.from('slide-2'))
      .mockResolvedValueOnce(Buffer.from('slide-3'))
      .mockResolvedValueOnce(Buffer.from('stacked-png'));

    await expect(renderArtifact(artifact, 'png')).resolves.toEqual({
      buffer: Buffer.from('stacked-png'),
      mime: 'image/png',
      extension: 'png',
    });
    expect(mockSetContent.mock.calls[0][0].match(/data:image\/png;base64/g)).toHaveLength(3);
    expect(mockScreenshot).toHaveBeenCalledTimes(4);
  });

  it('removes legacy prose outside a compiled shared artifact fence', async () => {
    let renderedSnapshot;
    mockGoto.mockImplementation(async (url) => {
      const parsed = new URL(url);
      renderedSnapshot = getRenderSnapshot(parsed.pathname.split('/').pop(), parsed.hash.slice(1));
    });

    await renderArtifact(
      {
        ...artifact,
        type: 'application/vnd.react',
        content: '```tsx\nexport default () => <main>Ready</main>;\n```\nTrailing prose',
      },
      'png',
    );

    expect(renderedSnapshot.content).toBe('export default () => <main>Ready</main>;');
  });

  it('blocks artifact-initiated requests outside the renderer allowlist', async () => {
    await renderArtifact(artifact, 'png');
    const routeHandler = mockRoute.mock.calls[0][1];
    const blocked = {
      request: () => ({ url: () => 'http://169.254.169.254/latest/meta-data' }),
      continue: jest.fn(),
      abort: jest.fn(),
    };
    const allowed = {
      request: () => ({ url: () => 'https://sandpack-bundler.codesandbox.io/index.html' }),
      continue: jest.fn(),
      abort: jest.fn(),
    };
    const allowedPackageCdn = {
      request: () => ({ url: () => 'https://cdn.jsdelivr.net/npm/react/index.js' }),
      continue: jest.fn(),
      abort: jest.fn(),
    };

    routeHandler(blocked);
    routeHandler(allowed);
    routeHandler(allowedPackageCdn);

    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();
    expect(allowed.continue).toHaveBeenCalled();
    expect(allowedPackageCdn.continue).toHaveBeenCalled();
  });

  it.each([
    [{ ...artifact, type: 'application/x-unknown' }, 'png'],
    [{ ...artifact, content: 'x'.repeat(4 * 1024 * 1024 + 1) }, 'png'],
    [artifact, 'svg'],
  ])('rejects unsupported or oversized requests before browser launch', async (input, format) => {
    await expect(renderArtifact(input, format)).rejects.toBeInstanceOf(ArtifactExportError);
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});

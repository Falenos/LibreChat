const mockScreenshot = jest.fn();
const mockPdf = jest.fn();
const mockSetContent = jest.fn();
const mockGoto = jest.fn();
const mockPageWaitForFunction = jest.fn();
const mockPageEvaluate = jest.fn();
const mockPreviewWaitForFunction = jest.fn();
const mockPreviewEvaluate = jest.fn();
const mockSetViewportSize = jest.fn();
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
    delete process.env.ARTIFACT_EXPORT_BASE_URL;
    mockScreenshot.mockReset().mockResolvedValue(Buffer.from('png'));
    mockPdf.mockReset().mockResolvedValue(Buffer.from('pdf'));
    mockPreviewEvaluate.mockReset();
    mockPageEvaluate.mockReset().mockResolvedValue(undefined);
    mockPageWaitForFunction.mockReset().mockResolvedValue(undefined);
    mockPreviewWaitForFunction.mockReset().mockResolvedValue(undefined);
    mockGoto.mockReset().mockResolvedValue(undefined);
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
      waitForFunction: mockPreviewWaitForFunction,
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
          evaluate: mockPageEvaluate,
          waitForFunction: mockPageWaitForFunction,
          setViewportSize: mockSetViewportSize.mockResolvedValue(undefined),
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
      expect(parsed.hostname).toBe('localhost');
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
    expect(mockPageWaitForFunction).toHaveBeenCalled();
    expect(mockScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'png', fullPage: true }),
    );
    expect(() => getRenderSnapshot(token, secret)).toThrow(ArtifactExportError);
    expect(mockCloseContext).toHaveBeenCalled();
    expect(mockCloseBrowser).toHaveBeenCalled();
  });

  it('does not capture while Sandpack still shows startup progress outside the iframe', async () => {
    await renderArtifact(artifact, 'png');

    const readiness = mockPageWaitForFunction.mock.calls[0][0];
    let overlay = {};
    const root = {
      innerText: '[3/3] Starting',
      querySelector: jest.fn((selector) => (selector === 'iframe' ? {} : overlay)),
    };
    global.document = { querySelector: jest.fn().mockReturnValue(root) };
    try {
      expect(readiness()).toBe(false);
      root.innerText = '';
      expect(readiness()).toBe(false);
      overlay = null;
      expect(readiness()).toBe(true);
    } finally {
      delete global.document;
    }
  });

  it('expands the preview iframe to the measured artifact height before capture', async () => {
    const measuredHeights = [2400, 900];
    mockPreviewEvaluate.mockImplementation(async (callback) => {
      const source = callback.toString();
      if (source.includes('scrollHeight')) {
        return measuredHeights.shift();
      }
      if (source.includes("querySelectorAll('button')")) {
        return 1;
      }
      return undefined;
    });

    await renderArtifact(artifact, 'png');

    expect(mockSetViewportSize).toHaveBeenCalledWith({ width: 1440, height: 2400 });
    expect(mockPageWaitForFunction).toHaveBeenCalledTimes(2);
    expect(mockPageEvaluate).toHaveBeenCalledWith(expect.any(Function), 2400);
    expect(mockPageEvaluate.mock.calls[0][0].toString()).toContain(
      '[data-knauf-artifact-export] iframe',
    );
    const fitFrame = mockPageEvaluate.mock.calls[0][0];
    const style = { isConnected: false };
    const appendChild = jest.fn();
    global.document = {
      getElementById: jest.fn().mockReturnValue(null),
      createElement: jest.fn().mockReturnValue(style),
      head: { appendChild },
    };
    try {
      fitFrame(2400);
      expect(style).toEqual(
        expect.objectContaining({
          id: 'knauf-artifact-export-frame-fit',
          textContent:
            '[data-knauf-artifact-export]{height:2400px!important;min-height:2400px!important;overflow:visible!important}[data-knauf-artifact-export] iframe{height:2400px!important;max-height:none!important;flex:none!important}',
        }),
      );
      expect(appendChild).toHaveBeenCalledWith(style);
    } finally {
      delete global.document;
    }
    expect(mockPageEvaluate.mock.invocationCallOrder[0]).toBeLessThan(
      mockScreenshot.mock.invocationCallOrder[0],
    );
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
    const evaluatorSource = mockPreviewEvaluate.mock.calls
      .map(([callback]) => callback.toString())
      .join('\n');
    expect(evaluatorSource).toContain('[data-knauf-export-pages]');
    expect(evaluatorSource).toContain('[data-knauf-export-next]');

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

  it('rejects a slide export when the rendered preview has no slide contract', async () => {
    mockPreviewEvaluate.mockImplementation(async (callback, requiresContract) => {
      const source = callback.toString();
      if (source.includes('scrollHeight')) {
        return 900;
      }
      if (requiresContract === true) {
        return 0;
      }
      if (source.includes("querySelectorAll('button')")) {
        return 1;
      }
      return undefined;
    });
    const slideArtifact = {
      ...artifact,
      type: 'application/vnd.react',
      content: "import { KnaufSlideDeck } from '/knauf/slides';",
    };

    await expect(renderArtifact(slideArtifact, 'png')).rejects.toThrow(
      'Artifact preview did not become ready',
    );
    expect(mockPreviewWaitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      true,
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(mockScreenshot).not.toHaveBeenCalled();
  });

  it('accepts the disabled next button on the final slide as ready', async () => {
    await renderArtifact(
      {
        ...artifact,
        type: 'application/vnd.react',
        content: "import { KnaufSlideDeck } from '/knauf/slides';",
      },
      'png',
    );
    const readiness = mockPreviewWaitForFunction.mock.calls[0][0];
    const now = jest.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1601);
    global.window = {};
    global.document = {
      body: { childElementCount: 1, innerText: 'Slide 3 ready', innerHTML: '<main>Slide 3</main>' },
      querySelector: (selector) =>
        selector === '[data-knauf-export-pages]' ? { getAttribute: () => '3' } : { disabled: true },
    };

    expect(readiness(true)).toBe(false);
    expect(readiness(true)).toBe(true);

    now.mockRestore();
    delete global.window;
    delete global.document;
  });

  it('ART-DL-004 keeps [3/3] Starting loading until the slide DOM is stable', async () => {
    await renderArtifact(
      {
        ...artifact,
        type: 'application/vnd.react',
        content: "import { KnaufSlideDeck } from '/knauf/slides';",
      },
      'png',
    );
    const readiness = mockPreviewWaitForFunction.mock.calls[0][0];
    const now = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1701);
    const body = {
      childElementCount: 1,
      innerText: '[3/3] Starting',
      innerHTML: '<main>[3/3] Starting</main>',
    };
    global.window = {};
    global.document = {
      body,
      querySelector: (selector) =>
        selector === '[data-knauf-export-pages]' ? { getAttribute: () => '3' } : { disabled: true },
    };

    expect(readiness(true)).toBe(false);
    body.innerText = 'Slide 3 ready';
    body.innerHTML = '<main>Slide 3 ready</main>';
    expect(readiness(true)).toBe(false);
    expect(readiness(true)).toBe(true);

    now.mockRestore();
    delete global.window;
    delete global.document;
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

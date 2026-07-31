import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnaufMermaidExportActions, KnaufMermaidRepairButton } from './KnaufMermaidControls';

const mockAsk = jest.fn();
const mockShowToast = jest.fn();
const mockTriggerDownload = jest.fn();
let mockConversationId: string | undefined = 'conversation-1';
let mockIsSubmitting = false;

jest.mock('@librechat/client', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  return {
    TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
    ThemeContext: ReactModule.createContext({ theme: 'light' }),
    isDark: () => false,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ isSubmitting: mockIsSubmitting }),
  useOptionalMessagesConversation: () => ({ conversationId: mockConversationId }),
  useOptionalMessagesOperations: () => ({ ask: mockAsk }),
}));

jest.mock('~/utils/downloadFile', () => ({
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
}));

describe('[knauf] Mermaid controls', () => {
  const originalImage = global.Image;
  const originalFetch = global.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const drawImage = jest.fn();
  const fillRect = jest.fn();

  beforeEach(() => {
    mockConversationId = 'conversation-1';
    mockIsSubmitting = false;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:download'),
    });
    Object.defineProperty(global, 'Image', {
      configurable: true,
      value: class {
        naturalWidth = 400;
        naturalHeight = 200;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    });
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      drawImage,
      fillRect,
      fillStyle: '',
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = jest.fn((callback) => {
      callback(new Blob(['png'], { type: 'image/png' }));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Object.defineProperty(global, 'Image', { configurable: true, value: originalImage });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  });

  it('downloads the rendered SVG without changing the preview URL', async () => {
    const svgBlob = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ blob: jest.fn().mockResolvedValue(svgBlob) }) as unknown as typeof fetch;

    render(
      <KnaufMermaidExportActions blobUrl="blob:preview" dimensions={{ width: 400, height: 200 }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_mermaid_download_svg' }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:download', 'mermaid-diagram.svg');
    });
    expect(global.fetch).toHaveBeenCalledWith('blob:preview');
  });

  it('rasterizes the rendered SVG to a bounded 2x PNG', async () => {
    render(
      <KnaufMermaidExportActions blobUrl="blob:preview" dimensions={{ width: 400, height: 200 }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_mermaid_download_png' }));

    await waitFor(() => {
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:download', 'mermaid-diagram.png');
    });
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeNull();
    expect(drawImage).toHaveBeenCalled();
    expect(fillRect).toHaveBeenCalledWith(0, 0, 800, 400);
  });

  it('caps PNG canvas pixels for very large diagrams', async () => {
    render(
      <KnaufMermaidExportActions
        blobUrl="blob:preview"
        dimensions={{ width: 10_000, height: 5_000 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_mermaid_download_png' }));

    await waitFor(() => expect(fillRect).toHaveBeenCalled());
    const [, , width, height] = fillRect.mock.lastCall as [number, number, number, number];
    expect(width).toBeLessThanOrEqual(8192);
    expect(height).toBeLessThanOrEqual(8192);
    expect(width * height).toBeLessThanOrEqual(16_000_000);
  });

  it('submits one constrained repair request with the exact source and error', () => {
    const source = 'sequenceDiagram\nNote over System: CDN; calls';
    const error = new Error('Parse error on line 2');

    render(<KnaufMermaidRepairButton source={source} error={error} />);
    const button = screen.getByRole('button', { name: 'com_knauf_mermaid_ask_fix' });
    fireEvent.click(button);

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][0].text).toContain(source);
    expect(mockAsk.mock.calls[0][0].text).toContain(error.message);
    expect(mockAsk.mock.calls[0][0].text).toContain('Mermaid 11.15.0');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('com_knauf_mermaid_fix_requested');
    fireEvent.click(button);
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('does not offer model repair outside an active conversation', () => {
    mockConversationId = undefined;

    const { container } = render(
      <KnaufMermaidRepairButton source="sequenceDiagram" error={new Error('bad')} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

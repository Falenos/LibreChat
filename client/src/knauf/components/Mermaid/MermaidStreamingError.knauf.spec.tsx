import React from 'react';
import { render, screen } from '@testing-library/react';
import Mermaid from '~/components/Messages/Content/Mermaid/Mermaid';

let mockIsSubmitting = true;

jest.mock('@librechat/client', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ isSubmitting: mockIsSubmitting }),
}));

jest.mock('~/components/Messages/Content/Mermaid/useSvgProcessing', () => ({
  __esModule: true,
  default: () => ({
    blobUrl: '',
    svgDimensions: null,
    isLoading: false,
    error: new Error('Renderer failed'),
    lastValidSvgRef: { current: null },
    initialScale: 1,
    calculatedHeight: 200,
  }),
}));

jest.mock('~/components/Messages/Content/Mermaid/useMermaidZoom', () => ({
  __esModule: true,
  default: () => ({
    zoom: 1,
    pan: { x: 0, y: 0 },
    isPanning: false,
    handleZoomIn: jest.fn(),
    handleZoomOut: jest.fn(),
    handleResetZoom: jest.fn(),
    handleMouseDown: jest.fn(),
  }),
}));

jest.mock('~/components/Messages/Content/Mermaid/MermaidDialog', () => () => null);
jest.mock('~/components/Messages/Content/Mermaid/MermaidHeader', () => () => null);
jest.mock('~/components/Messages/Content/Mermaid/ZoomControls', () => () => null);
jest.mock('~/knauf/components/Mermaid/KnaufMermaidControls', () => ({
  KnaufMermaidCanvasExports: () => null,
  KnaufMermaidErrorAction: () => <span data-testid="repair-action" />,
}));

describe('[knauf] Mermaid streaming errors', () => {
  it('keeps a parser-valid but render-incomplete diagram in loading state while streaming', () => {
    mockIsSubmitting = true;

    render(<Mermaid>{'xychart-beta\ntitle "Annual total by region"'}</Mermaid>);

    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('repair-action')).not.toBeInTheDocument();
    expect(screen.queryByText('Renderer failed')).not.toBeInTheDocument();
  });

  it('shows repair after generation finishes with the same render error', () => {
    mockIsSubmitting = false;

    render(<Mermaid>{'xychart-beta\ntitle "Annual total by region"'}</Mermaid>);

    expect(screen.getByTestId('repair-action')).toBeInTheDocument();
    expect(screen.getByText('Renderer failed')).toBeInTheDocument();
  });
});

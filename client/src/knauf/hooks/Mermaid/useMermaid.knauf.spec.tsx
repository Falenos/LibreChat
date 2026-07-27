import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useMermaid } from '~/hooks/Mermaid/useMermaid';
import { useDebouncedMermaid } from '~/hooks/Mermaid/useDebouncedMermaid';
import { KnaufMermaidError, shouldRetryKnaufMermaidError } from '~/knauf/common/mermaid';

const mockParse = jest.fn();
const mockRender = jest.fn();

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    parse: (...args: unknown[]) => mockParse(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

jest.mock('@librechat/client', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  return {
    ThemeContext: ReactModule.createContext({ theme: 'light' }),
    isDark: () => false,
  };
});

jest.mock('~/utils/mermaid', () => ({
  inlineFlowchartConfig: {},
  sanitizeMermaidSvg: (svg: string) => svg,
}));

const wrapper = ({ children }: Readonly<{ children: React.ReactNode }>) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

describe('[knauf] useMermaid error handling', () => {
  it('retries only transient library-load failures', () => {
    expect(shouldRetryKnaufMermaidError(new KnaufMermaidError('load', 'chunk failed'))).toBe(true);
    expect(shouldRetryKnaufMermaidError(new KnaufMermaidError('syntax', 'bad source'))).toBe(false);
    expect(shouldRetryKnaufMermaidError(new KnaufMermaidError('render', 'bad render'))).toBe(false);
  });

  it('classifies syntax errors and does not retry deterministic source', async () => {
    mockParse.mockRejectedValue(new Error('Parse error'));

    const { result } = renderHook(
      () => useMermaid({ content: 'sequenceDiagram\nNote over A: one; two', id: 'syntax' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'syntax' }), {
      timeout: 5000,
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('classifies renderer failures and does not retry them', async () => {
    mockParse.mockResolvedValue({ diagramType: 'sequence' });
    mockRender.mockRejectedValue(new Error('Renderer failed'));

    const { result } = renderHook(
      () => useMermaid({ content: 'sequenceDiagram\nA->>B: hello', id: 'render' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'render' }), {
      timeout: 5000,
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it('surfaces a source error through the debounce layer after one attempt', async () => {
    mockParse.mockRejectedValue(new Error('Parse error'));

    const { result } = renderHook(
      () =>
        useDebouncedMermaid({
          content: 'sequenceDiagram\nA->>B: broken',
          id: 'debounced-syntax',
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'syntax' }));
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});

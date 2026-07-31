import { useContext, useMemo } from 'react';
import useSWR from 'swr';
import { Md5 } from 'ts-md5';
import { ThemeContext, isDark } from '@librechat/client';
import type { MermaidConfig } from 'mermaid';
import { inlineFlowchartConfig, sanitizeMermaidSvg } from '~/utils/mermaid';
// [knauf] Classify deterministic Mermaid failures so only transient library loads retry. (NO-TICKET)
import { KnaufMermaidError, shouldRetryKnaufMermaidError } from '~/knauf/common/mermaid';
// End [knauf]

// Constants
const MD5_LENGTH_THRESHOLD = 10_000;
const DEFAULT_ID_PREFIX = 'mermaid-diagram';

// [knauf] Reset a rejected lazy import so a transient chunk-load failure can recover. (NO-TICKET)
// Lazy load mermaid library (~2MB)
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

const loadMermaid = () => {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }

  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => mod.default)
      .catch((error) => {
        mermaidPromise = null;
        throw new KnaufMermaidError('load', error);
      });
  }

  return mermaidPromise;
};
// End [knauf]

interface UseMermaidOptions {
  /** Mermaid diagram content */
  content: string;
  /** Unique identifier for this diagram */
  id?: string;
  /** Custom mermaid theme */
  theme?: string;
  /** Custom mermaid configuration */
  config?: Partial<MermaidConfig>;
}

interface UseMermaidReturn {
  /** The rendered SVG string */
  svg: string | undefined;
  /** Loading state */
  isLoading: boolean;
  /** Error object if rendering failed */
  error: Error | undefined;
  /** Whether content is being validated */
  isValidating: boolean;
}

export const useMermaid = ({
  content,
  id = DEFAULT_ID_PREFIX,
  theme: customTheme,
  config,
}: UseMermaidOptions): UseMermaidReturn => {
  const { theme } = useContext(ThemeContext);
  const isDarkMode = isDark(theme);

  // Generate cache key based on content, theme, and ID
  const cacheKey = useMemo((): string => {
    // For large diagrams, use MD5 hash instead of full content
    const contentHash = content.length < MD5_LENGTH_THRESHOLD ? content : Md5.hashStr(content);

    // Include theme mode in cache key to handle theme switches
    const themeKey = customTheme || (isDarkMode ? 'd' : 'l');

    return [id, themeKey, contentHash].filter(Boolean).join('-');
  }, [content, id, isDarkMode, customTheme]);

  // Generate unique diagram ID (mermaid requires unique IDs in the DOM)
  // Include cacheKey to regenerate when content/theme changes, preventing mermaid internal conflicts
  const diagramId = useMemo(() => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${id}-${timestamp}-${random}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cacheKey]);

  // Build mermaid configuration
  const mermaidConfig = useMemo((): MermaidConfig => {
    const defaultTheme = isDarkMode ? 'dark' : 'neutral';

    return {
      startOnLoad: false,
      theme: (customTheme as MermaidConfig['theme']) || defaultTheme,
      ...config,
      flowchart: { ...inlineFlowchartConfig, ...config?.flowchart, htmlLabels: false },
      // [knauf] Prevent Mermaid's fallback error SVG from leaking into document.body. (NO-TICKET)
      suppressErrorRendering: true,
      // End [knauf]
      // Security hardening: MUST come after ...config spread to prevent override
      securityLevel: 'strict',
      maxTextSize: config?.maxTextSize ?? 50000,
      maxEdges: config?.maxEdges ?? 500,
    };
  }, [customTheme, isDarkMode, config]);

  // [knauf] Surface source errors exactly once; retrying unchanged invalid Mermaid cannot help. (NO-TICKET)
  // Fetch/render function
  const fetchSvg = async (): Promise<string> => {
    // SSR guard
    if (typeof window === 'undefined') {
      return '';
    }

    try {
      const mermaidInstance = await loadMermaid();

      if (!mermaidInstance) {
        throw new KnaufMermaidError('load', 'Failed to load mermaid library');
      }

      try {
        await mermaidInstance.parse(content);
      } catch (error) {
        throw new KnaufMermaidError('syntax', error);
      }

      mermaidInstance.initialize(mermaidConfig);
      const { svg } = await mermaidInstance.render(diagramId, content);
      return sanitizeMermaidSvg(svg);
    } catch (error) {
      if (error instanceof KnaufMermaidError) {
        throw error;
      }
      throw new KnaufMermaidError('render', error);
    }
  };

  // Use SWR for caching and revalidation
  const { data, error, isLoading, isValidating } = useSWR<string, Error>(cacheKey, fetchSvg, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 3000,
    errorRetryCount: 2,
    errorRetryInterval: 1000,
    shouldRetryOnError: shouldRetryKnaufMermaidError,
  });
  // End [knauf]

  return {
    svg: data,
    isLoading,
    error,
    isValidating,
  };
};

export default useMermaid;

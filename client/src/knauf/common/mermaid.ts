export type KnaufMermaidErrorKind = 'load' | 'syntax' | 'render';

export class KnaufMermaidError extends Error {
  readonly kind: KnaufMermaidErrorKind;

  constructor(kind: KnaufMermaidErrorKind, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'KnaufMermaidError';
    this.kind = kind;
  }
}

export const shouldRetryKnaufMermaidError = (error: Error): boolean =>
  error instanceof KnaufMermaidError && error.kind === 'load';

export const isKnaufMermaidSourceError = (error: Error): boolean =>
  error instanceof KnaufMermaidError && error.kind !== 'load';

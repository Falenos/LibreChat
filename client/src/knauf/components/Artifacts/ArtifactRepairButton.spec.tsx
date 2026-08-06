import { fireEvent, render, screen } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Artifact } from '~/common';
import { ArtifactPreview } from '~/components/Artifacts/ArtifactPreview';
import ArtifactRepairButton, {
  buildArtifactRepairPrompt,
  isRepairableArtifactError,
} from './ArtifactRepairButton';

const mockAsk = jest.fn();
const compilerError = {
  message: "Cannot read properties of undefined (reading 'cyanBlue')",
  path: '/App.tsx',
  line: 15,
  column: 76,
};
let mockError: typeof compilerError | null = compilerError;
let mockIsSubmitting = false;
let mockLatestMessageId = 'assistant-message-1';

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@codesandbox/sandpack-react/unstyled', () => ({
  SandpackProvider: ({
    children,
    files,
  }: {
    children: ReactNode;
    files: Record<string, unknown>;
  }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const [mountedFile] = React.useState(files['App.tsx']);
    const [mountedIndex] = React.useState(files['index.html']);
    return (
      <div
        data-testid="sandpack-provider"
        data-file={JSON.stringify(mountedFile)}
        data-index={JSON.stringify(mountedIndex)}
      >
        {children}
      </div>
    );
  },
  SandpackPreview: ({ children }: { children?: ReactNode }) => (
    <div data-testid="sandpack-preview">{children}</div>
  ),
  useSandpack: () => ({ sandpack: { error: mockError } }),
}));

jest.mock('~/Providers', () => ({
  useArtifactsContext: () => ({
    conversationId: 'conversation-1',
    isSubmitting: mockIsSubmitting,
    latestMessageId: mockLatestMessageId,
  }),
  useChatContext: () => ({ ask: mockAsk }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const artifact: Artifact = {
  id: 'artifact-1',
  identifier: 'rag-concept-slides',
  title: 'RAG Concept Slides',
  type: 'application/vnd.react',
  content: 'export default function Slides() {}',
  messageId: 'assistant-message-1',
  lastUpdateTime: 0,
};

const finishGeneration = (identifier: string) => {
  mockIsSubmitting = true;
  const repairArtifact = { ...artifact, id: identifier, identifier };
  const view = render(<ArtifactRepairButton artifact={repairArtifact} />);

  mockIsSubmitting = false;
  view.rerender(<ArtifactRepairButton artifact={repairArtifact} />);

  return view;
};

describe('ArtifactRepairButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockError = compilerError;
    mockIsSubmitting = false;
    mockLatestMessageId = 'assistant-message-1';
  });

  it('automatically sends the first repair request after artifact generation', () => {
    finishGeneration('auto-repair');

    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk).toHaveBeenLastCalledWith({
      text: expect.stringContaining(compilerError.message),
      parentMessageId: 'assistant-message-1',
    });
    expect(mockAsk.mock.calls[0][0].text).toContain('untrusted diagnostic data');
    expect(mockAsk.mock.calls[0][0].text).toContain('same identifier');
  });

  it('does not automatically submit when reopening an existing broken artifact', () => {
    render(
      <ArtifactRepairButton
        artifact={{ ...artifact, id: 'reopened-artifact', identifier: 'reopened-artifact' }}
      />,
    );

    expect(mockAsk).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'com_knauf_artifact_fix' });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('left-1/2', 'top-1/2');
  });

  it('does not repair an old artifact after an unrelated generation', () => {
    mockLatestMessageId = 'different-assistant-message';
    mockIsSubmitting = true;
    const view = render(<ArtifactRepairButton artifact={artifact} />);

    mockIsSubmitting = false;
    view.rerender(<ArtifactRepairButton artifact={artifact} />);

    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('automatically repairs only once per conversation and artifact identifier', () => {
    const firstRender = finishGeneration('one-shot-repair');
    firstRender.unmount();
    finishGeneration('one-shot-repair');

    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('keeps the manual repair action available after the automatic attempt', () => {
    finishGeneration('manual-fallback');

    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_artifact_fix' }));

    expect(mockAsk).toHaveBeenCalledTimes(2);
  });

  it('bounds runtime-controlled diagnostic text', () => {
    const prompt = buildArtifactRepairPrompt(artifact, { message: 'x'.repeat(3000) });

    expect(prompt).toContain('x'.repeat(2000));
    expect(prompt).not.toContain('x'.repeat(2001));
  });

  it('leaves infrastructure errors to Sandpack instead of asking the model to rewrite code', () => {
    expect(isRepairableArtifactError({ message: '[sandpack-client]: connection timeout' })).toBe(
      false,
    );
    expect(isRepairableArtifactError(compilerError)).toBe(true);
  });

  it('offers repair when a slide deck compiles but violates the runtime contract', () => {
    mockError = null;
    render(
      <ArtifactRepairButton
        artifact={artifact}
        sourceCode="export default () => <div data-knauf-export-pages><section style={{ display: 'none' }} /></div>;"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_knauf_artifact_fix' }));

    expect(mockAsk).toHaveBeenCalledWith({
      text: expect.stringContaining("from '/knauf/slides'"),
      parentMessageId: 'assistant-message-1',
    });
  });

  it('mounts the repair action in owned artifact previews', () => {
    render(
      <ArtifactPreview
        artifact={artifact}
        files={{ 'App.tsx': artifact.content }}
        fileKey="App.tsx"
        template="react-ts"
        sharedProps={{}}
        previewRef={{ current: undefined } as never}
        isSharedConvo={false}
      />,
    );

    expect(screen.getByTestId('sandpack-preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_knauf_artifact_fix' })).toBeInTheDocument();
  });

  it('does not offer repair from read-only shared previews', () => {
    render(
      <ArtifactPreview
        artifact={artifact}
        files={{ 'App.tsx': artifact.content }}
        fileKey="App.tsx"
        template="react-ts"
        sharedProps={{}}
        previewRef={{ current: undefined } as never}
        isSharedConvo
      />,
    );

    expect(
      screen.queryByRole('button', { name: 'com_knauf_artifact_fix' }),
    ).not.toBeInTheDocument();
  });

  // [knauf] NO-TICKET — native SVG edits also drive the static preview entrypoint.
  it('previews the current native SVG source through index.html', () => {
    const svgArtifact = {
      ...artifact,
      type: 'image/svg+xml',
      content: '<svg><text>OLD</text></svg>',
    };

    render(
      <ArtifactPreview
        artifact={svgArtifact}
        files={{
          'artwork.svg': svgArtifact.content,
          'index.html': svgArtifact.content,
        }}
        fileKey="artwork.svg"
        template="static"
        sharedProps={{}}
        previewRef={{ current: undefined } as never}
        currentCode="<svg><text>NEW</text></svg>"
        isSharedConvo
      />,
    );

    expect(screen.getByTestId('sandpack-provider')).toHaveAttribute(
      'data-index',
      expect.stringContaining('NEW'),
    );
  });
  // End [knauf]

  it('remounts Sandpack when selecting a different artifact version', () => {
    const view = render(
      <ArtifactPreview
        artifact={{ ...artifact, id: 'artifact-version-1', content: 'VERSION ONE' }}
        files={{ 'App.tsx': 'VERSION ONE' }}
        fileKey="App.tsx"
        template="react-ts"
        sharedProps={{}}
        previewRef={{ current: undefined } as never}
      />,
    );

    view.rerender(
      <ArtifactPreview
        artifact={{ ...artifact, id: 'artifact-version-2', content: 'VERSION TWO' }}
        files={{ 'App.tsx': 'VERSION TWO' }}
        fileKey="App.tsx"
        template="react-ts"
        sharedProps={{}}
        previewRef={{ current: undefined } as never}
      />,
    );

    expect(screen.getByTestId('sandpack-provider')).toHaveAttribute(
      'data-file',
      expect.stringContaining('VERSION TWO'),
    );
  });
});

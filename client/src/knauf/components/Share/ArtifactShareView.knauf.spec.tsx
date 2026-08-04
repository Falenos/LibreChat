import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Artifact } from '~/common';
import ArtifactShareView from './ArtifactShareView';

jest.mock('@radix-ui/react-tabs', () => ({
  Root: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
}));

jest.mock('@librechat/client', () => ({
  Radio: ({ options }: Readonly<{ options: Array<{ label: string; value: string }> }>) => (
    <div>
      {options.map((option) => (
        <button key={option.value}>{option.label}</button>
      ))}
    </div>
  ),
}));

jest.mock('~/components/Artifacts/ArtifactTabs', () => ({
  __esModule: true,
  default: function MockArtifactTabs({
    artifact,
    isSharedConvo,
  }: Readonly<{ artifact: Artifact; isSharedConvo?: boolean }>) {
    const { useArtifactsContext } = jest.requireMock('~/Providers') as {
      useArtifactsContext: () => { isSubmitting: boolean };
    };
    const { isSubmitting } = useArtifactsContext();

    return (
      <pre data-testid="compiled-source" data-read-only={isSharedConvo && !isSubmitting}>
        {artifact.content}
      </pre>
    );
  },
}));

jest.mock('~/knauf/components/Artifacts/ArtifactDownloadMenu', () => ({
  __esModule: true,
  default: ({ shareId }: Readonly<{ shareId?: string }>) => (
    <span data-testid="artifact-download-share-id">{shareId}</span>
  ),
}));

jest.mock('~/Providers', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const ArtifactsContext = React.createContext<{ isSubmitting: boolean } | undefined>(undefined);

  return {
    ArtifactsProvider: ({ children }: Readonly<{ children: ReactNode }>) => (
      <ArtifactsContext.Provider value={{ isSubmitting: false }}>
        {children}
      </ArtifactsContext.Provider>
    ),
    EditorProvider: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
    useArtifactsContext: () => {
      const context = React.useContext(ArtifactsContext);
      if (!context) {
        throw new Error('useArtifactsContext must be used within ArtifactsProvider');
      }
      return context;
    },
  };
});

jest.mock('~/utils/artifacts', () => ({
  isCodeOnlyArtifact: () => false,
  isPreviewOnlyArtifact: () => false,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('ArtifactShareView', () => {
  it('passes only source from an old fenced snapshot to the artifact renderer', () => {
    render(
      <ArtifactShareView
        shareId="share-1"
        artifact={{
          title: 'Status page',
          type: 'application/vnd.react',
          content: `\`\`\`tsx
export default function App() {
  return <div>Ready</div>;
}
\`\`\`
A clean, branded summary with citations that must not compile.`,
        }}
      />,
    );

    expect(screen.getByTestId('compiled-source')).toHaveTextContent(
      'export default function App() { return <div>Ready</div>; }',
    );
    expect(screen.getByTestId('compiled-source')).not.toHaveTextContent('```');
    expect(screen.getByTestId('compiled-source')).not.toHaveTextContent('branded summary');
    expect(screen.getByTestId('compiled-source')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByRole('button', { name: 'com_ui_code' })).toBeInTheDocument();
    expect(screen.getByTestId('artifact-download-share-id')).toHaveTextContent('share-1');
  });
});

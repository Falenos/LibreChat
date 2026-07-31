import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Artifact } from '~/common';
import ArtifactShareView from './ArtifactShareView';

jest.mock('@radix-ui/react-tabs', () => ({
  Root: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
}));

jest.mock('@librechat/client', () => ({
  Radio: () => null,
}));

jest.mock('~/components/Artifacts/ArtifactTabs', () => ({
  __esModule: true,
  default: ({ artifact }: Readonly<{ artifact: Artifact }>) => (
    <pre data-testid="compiled-source">{artifact.content}</pre>
  ),
}));

jest.mock('~/components/Artifacts/DownloadArtifact', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/Providers', () => ({
  EditorProvider: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
}));

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
  });
});

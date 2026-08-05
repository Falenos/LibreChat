import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Artifact } from '~/components/Artifacts/Artifact';
import store from '~/store';

const mockGetArtifactRevision = jest.fn();

jest.mock('~/knauf/data-provider/data-service', () => ({
  getArtifactRevision: (...args: unknown[]) => mockGetArtifactRevision(...args),
}));

jest.mock('~/knauf/utils/artifactBody', () => ({
  extractArtifactBody: () => 'EDITED VERSION TWO',
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ messageId: 'message-1' }),
  useArtifactContext: () => ({ getNextIndex: () => 0, resetCounter: jest.fn() }),
}));

jest.mock('~/utils', () => ({
  isArtifactRoute: () => true,
  logger: { log: jest.fn() },
}));

jest.mock('~/components/Artifacts/ArtifactButton', () => ({
  __esModule: true,
  default: ({ artifact }: { artifact: { content?: string } | null }) =>
    artifact ? <div data-testid="root-artifact">{artifact.content}</div> : null,
}));

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/c/conversation-1' }),
}));

function Registry() {
  const artifacts = useRecoilValue(store.artifactsState);
  return <pre data-testid="artifact-registry">{JSON.stringify(artifacts)}</pre>;
}

describe('Artifact root revision binding', () => {
  it('keeps the root card on version 1 after the persisted source advances to version 2', async () => {
    mockGetArtifactRevision.mockResolvedValue({
      title: 'Versioning Probe',
      type: 'application/vnd.react',
      content: 'ROOT VERSION ONE',
      version: 1,
    });
    const props = {
      node: {},
      id: 'ignored',
      lastUpdateTime: 0,
      identifier: 'versioning-probe',
      title: 'Versioning Probe',
      type: 'application/vnd.react',
      version: '2',
      children: <code>{'EDITED VERSION TWO'}</code>,
    } as ComponentProps<typeof Artifact> & { version: string };

    render(
      <RecoilRoot>
        <Artifact {...props} />
        <Registry />
      </RecoilRoot>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('root-artifact')).toHaveTextContent('ROOT VERSION ONE'),
    );
    expect(mockGetArtifactRevision).toHaveBeenCalledWith({
      messageId: 'message-1',
      identifier: 'versioning-probe',
      version: 1,
    });
    expect(screen.getByTestId('artifact-registry')).toHaveTextContent(
      'artifact-revision:message-1:versioning-probe:version:2',
    );
    expect(screen.getByTestId('artifact-registry')).toHaveTextContent('EDITED VERSION TWO');
  });
});

import { RecoilRoot, useRecoilValue } from 'recoil';
import { render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Artifact } from '~/components/Artifacts/Artifact';
import store from '~/store';

const mockGetArtifactRevisionHistory = jest.fn();
const mockGetArtifactRevision = jest.fn();
let mockArtifactBody = 'EDITED VERSION TWO';

jest.mock('~/knauf/data-provider/data-service', () => ({
  getArtifactRevision: (...args: unknown[]) => mockGetArtifactRevision(...args),
  getArtifactRevisionHistory: (...args: unknown[]) => mockGetArtifactRevisionHistory(...args),
}));

jest.mock('~/knauf/utils/artifactBody', () => ({
  extractArtifactBody: () => mockArtifactBody,
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
  const visibleArtifacts = useRecoilValue(store.visibleArtifacts);
  const orderedContent = Object.values(artifacts ?? {})
    .sort((left, right) => (left?.lastUpdateTime ?? 0) - (right?.lastUpdateTime ?? 0))
    .map((artifact) => artifact?.content);
  return (
    <>
      <pre data-testid="artifact-registry">{JSON.stringify(artifacts)}</pre>
      <pre data-testid="visible-artifact-registry">{JSON.stringify(visibleArtifacts)}</pre>
      <pre data-testid="artifact-order">{JSON.stringify(orderedContent)}</pre>
    </>
  );
}

describe('Artifact root revision binding', () => {
  beforeEach(() => {
    mockGetArtifactRevisionHistory.mockReset();
    mockGetArtifactRevision.mockReset();
    mockArtifactBody = 'EDITED VERSION TWO';
  });

  it('keeps the root card on version 1 after the persisted source advances to version 2', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          content: 'ROOT VERSION ONE',
          version: 1,
        },
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          content: 'EDITED VERSION TWO',
          version: 2,
        },
      ],
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
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledWith({
      messageId: 'message-1',
      identifier: 'versioning-probe',
    });
    expect(screen.getByTestId('artifact-registry')).toHaveTextContent(
      'artifact-revision:message-1:versioning-probe:version:2',
    );
    expect(screen.getByTestId('artifact-registry')).toHaveTextContent('EDITED VERSION TWO');
    expect(screen.getByTestId('visible-artifact-registry')).toHaveTextContent(
      'artifact-revision:message-1:versioning-probe:version:2',
    );
    const registry = JSON.parse(screen.getByTestId('artifact-registry').textContent ?? '{}');
    expect(
      Object.values(registry).find(
        (registered) => (registered as { content?: string }).content === 'ROOT VERSION ONE',
      ),
    ).toMatchObject({
      knaufRevision: { identifier: 'versioning-probe', version: 1 },
    });
  });

  it('keeps Version 1 before all later immutable revisions', async () => {
    mockGetArtifactRevisionHistory
      .mockResolvedValueOnce({
        currentVersion: 2,
        revisions: [
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            content: 'ROOT VERSION ONE',
            version: 1,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            content: 'EDITED VERSION TWO',
            version: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        currentVersion: 3,
        revisions: [
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            content: 'ROOT VERSION ONE',
            version: 1,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            content: 'EDITED VERSION TWO',
            version: 2,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            content: 'EDITED VERSION THREE',
            version: 3,
          },
        ],
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

    const { rerender } = render(
      <RecoilRoot>
        <Artifact {...props} />
        <Registry />
      </RecoilRoot>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('artifact-order')).toHaveTextContent(
        '["ROOT VERSION ONE","EDITED VERSION TWO"]',
      ),
    );

    mockArtifactBody = 'EDITED VERSION THREE';
    rerender(
      <RecoilRoot>
        <Artifact {...props} version="3" />
        <Registry />
      </RecoilRoot>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('artifact-order')).toHaveTextContent('EDITED VERSION THREE'),
    );
    expect(screen.getByTestId('artifact-order')).toHaveTextContent(
      '["ROOT VERSION ONE","EDITED VERSION TWO","EDITED VERSION THREE"]',
    );
  });

  it('keeps the root card on Version 1 when an older API pod lacks the history route', async () => {
    mockGetArtifactRevisionHistory.mockRejectedValue({ response: { status: 404 } });
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
  });
});

import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Artifact } from '~/components/Artifacts/Artifact';
import store from '~/store';

const mockGetArtifactRevisionHistory = jest.fn();
const mockGetArtifactRevision = jest.fn();
let mockArtifactBody = 'EDITED VERSION TWO';
let mockMessageId = 'message-1';

jest.mock('~/knauf/data-provider/data-service', () => ({
  getArtifactRevision: (...args: unknown[]) => mockGetArtifactRevision(...args),
  getArtifactRevisionHistory: (...args: unknown[]) => mockGetArtifactRevisionHistory(...args),
}));

jest.mock('~/knauf/utils/artifactBody', () => ({
  extractArtifactBody: () => mockArtifactBody,
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ messageId: mockMessageId }),
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
    mockGetArtifactRevision.mockResolvedValue({
      title: 'Versioning Probe',
      type: 'application/vnd.react',
      content: 'ROOT VERSION ONE',
      version: 1,
    });
    mockArtifactBody = 'EDITED VERSION TWO';
    mockMessageId = 'message-1';
  });

  it('keeps the root card on version 1 after the persisted source advances to version 2', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 2,
          available: true,
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

  it('normalizes a model-authored directive version to the server history version', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 1,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
      ],
    });
    mockArtifactBody = 'UNTRUSTED VERSION ATTRIBUTE';
    const props = {
      node: {},
      id: 'ignored',
      lastUpdateTime: 0,
      identifier: 'versioning-probe',
      title: 'Versioning Probe',
      type: 'application/vnd.react',
      version: '10000',
      children: <code>{'UNTRUSTED VERSION ATTRIBUTE'}</code>,
    } as ComponentProps<typeof Artifact> & { version: string };

    render(
      <RecoilRoot>
        <Artifact {...props} />
        <Registry />
      </RecoilRoot>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('root-artifact')).toHaveTextContent('UNTRUSTED VERSION ATTRIBUTE'),
    );
    const registry = screen.getByTestId('artifact-registry');
    expect(registry).toHaveTextContent('"version":1');
    expect(registry).not.toHaveTextContent('version:10000');
    expect(mockGetArtifactRevision).not.toHaveBeenCalled();
  });

  it('keeps Version 1 before all later immutable revisions', async () => {
    mockGetArtifactRevisionHistory
      .mockResolvedValueOnce({
        currentVersion: 2,
        revisions: [
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 1,
            available: true,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 2,
            available: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        currentVersion: 3,
        revisions: [
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 1,
            available: true,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 2,
            available: true,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 3,
            available: true,
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

  it('anchors revision timestamps at the latest source time', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 100,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 100,
          available: true,
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
      version: '100',
      children: <code>{'EDITED VERSION ONE HUNDRED'}</code>,
    } as ComponentProps<typeof Artifact> & { version: string };
    mockArtifactBody = 'EDITED VERSION ONE HUNDRED';

    render(
      <RecoilRoot>
        <Artifact {...props} />
        <Registry />
      </RecoilRoot>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('root-artifact')).toHaveTextContent('ROOT VERSION ONE'),
    );
    const registry = JSON.parse(screen.getByTestId('artifact-registry').textContent ?? '{}');
    const registered = Object.values(registry) as Array<{
      lastUpdateTime: number;
      knaufRevision?: { version: number };
    }>;
    expect(
      registered.find(({ knaufRevision }) => knaufRevision?.version === 1)?.lastUpdateTime,
    ).toBe(9901);
    expect(
      registered.find(({ knaufRevision }) => knaufRevision?.version === 100)?.lastUpdateTime,
    ).toBe(10_000);
    now.mockRestore();
  });

  it('preserves loaded revision metadata across same-version source rerenders', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 2,
          available: true,
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
      expect(screen.getByTestId('artifact-registry')).toHaveTextContent('knaufRevisionHistory'),
    );

    rerender(
      <RecoilRoot>
        <Artifact {...props}>
          <code>{'EDITED VERSION TWO'}</code>
        </Artifact>
        <Registry />
      </RecoilRoot>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('artifact-registry')).toHaveTextContent('knaufRevisionHistory'),
    );
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(1);
  });

  it('ignores history responses from a previous message scope', async () => {
    let resolveFirstHistory!: (value: {
      currentVersion: number;
      revisions: Array<{
        title: string;
        type: string;
        version: number;
        available: boolean;
      }>;
    }) => void;
    const firstHistory = new Promise<{
      currentVersion: number;
      revisions: Array<{
        title: string;
        type: string;
        version: number;
        available: boolean;
      }>;
    }>((resolve) => {
      resolveFirstHistory = resolve;
    });
    mockGetArtifactRevisionHistory.mockImplementation(({ messageId }: { messageId: string }) =>
      messageId === 'message-1'
        ? firstHistory
        : Promise.resolve({
            currentVersion: 1,
            revisions: [
              {
                title: 'Versioning Probe',
                type: 'application/vnd.react',
                version: 1,
                available: true,
              },
            ],
          }),
    );
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
      expect(mockGetArtifactRevisionHistory).toHaveBeenCalledWith({
        messageId: 'message-1',
        identifier: 'versioning-probe',
      }),
    );

    mockMessageId = 'message-2';
    mockArtifactBody = 'CONVERSATION TWO';
    rerender(
      <RecoilRoot>
        <Artifact {...props} />
        <Registry />
      </RecoilRoot>,
    );
    await waitFor(() =>
      expect(mockGetArtifactRevisionHistory).toHaveBeenCalledWith({
        messageId: 'message-2',
        identifier: 'versioning-probe',
      }),
    );

    await act(async () => {
      resolveFirstHistory({
        currentVersion: 2,
        revisions: [
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 1,
            available: true,
          },
          {
            title: 'Versioning Probe',
            type: 'application/vnd.react',
            version: 2,
            available: true,
          },
        ],
      });
      await firstHistory;
    });

    expect(screen.getByTestId('artifact-registry')).toHaveTextContent('message-2');
    expect(screen.getByTestId('artifact-registry')).not.toHaveTextContent('message-1');
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

  it('does not retry an exact Version 1 failure as a rolling-deployment fallback', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Versioning Probe',
          type: 'application/vnd.react',
          version: 2,
          available: true,
        },
      ],
    });
    mockGetArtifactRevision.mockRejectedValue({ response: { status: 404 } });
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
      expect(screen.getByTestId('root-artifact')).toHaveTextContent('EDITED VERSION TWO'),
    );
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(1);
    expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1);
  });
});

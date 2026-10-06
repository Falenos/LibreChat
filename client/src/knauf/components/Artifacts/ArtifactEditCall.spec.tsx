import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import type { Artifact, ArtifactRevisionEntry } from '~/common';
import store from '~/store';
import {
  cancelArtifactRevisionOpen,
  mergeArtifactRevisionRegistry,
} from '~/knauf/utils/artifactRevisions';
import ArtifactEditCall, { parseArtifactEditResult } from './ArtifactEditCall';

const mockGetArtifactRevisionHistory = jest.fn();
const mockGetArtifactRevision = jest.fn();

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

jest.mock('~/knauf/data-provider/data-service', () => ({
  getArtifactRevision: (...args: unknown[]) => mockGetArtifactRevision(...args),
  getArtifactRevisionHistory: (...args: unknown[]) => mockGetArtifactRevisionHistory(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    values?.[0] ? `${key}:${values[0]}` : key,
}));

const output = JSON.stringify({
  status: 'updated',
  identifier: 'dashboard',
  messageId: 'message-1',
  title: 'Sales dashboard',
  version: 2,
  replacements: 1,
});

function Selection() {
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const visible = useRecoilValue(store.artifactsVisibility);
  const artifacts = useRecoilValue(store.artifactsState);
  return (
    <div data-testid="selection">
      {`${currentArtifactId}:${visible}:${artifacts?.[currentArtifactId ?? '']?.content ?? ''}`}
    </div>
  );
}

function CloseArtifact() {
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setVisible = useSetRecoilState(store.artifactsVisibility);

  return (
    <button
      type="button"
      data-testid="close-artifact"
      onClick={() => {
        cancelArtifactRevisionOpen();
        setArtifacts(null);
        setCurrentArtifactId(null);
        setVisible(false);
      }}
    />
  );
}

describe('ArtifactEditCall', () => {
  beforeEach(() => {
    mockGetArtifactRevisionHistory.mockReset();
    mockGetArtifactRevision.mockReset();
    mockGetArtifactRevision.mockResolvedValue({
      title: 'Sales dashboard',
      type: 'application/vnd.react',
      content: 'export default function App() {}',
      version: 2,
    });
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 2,
          available: true,
        },
      ],
    });
  });

  it('parses only completed artifact update payloads', () => {
    expect(parseArtifactEditResult(output)).toEqual(
      expect.objectContaining({ identifier: 'dashboard', version: 2 }),
    );
    expect(parseArtifactEditResult('{"status":"error"}')).toBeNull();
    expect(parseArtifactEditResult('not-json')).toBeNull();
  });

  it('uses the original artifact card presentation for edited versions', () => {
    render(
      <RecoilRoot>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
      </RecoilRoot>,
    );

    const card = screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' });
    expect(card).toHaveClass(
      'relative',
      'overflow-hidden',
      'rounded-xl',
      'hover:shadow-lg',
      'active:scale-[0.98]',
    );
    expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
    expect(screen.getByText('com_ui_version_var:2')).toBeInTheDocument();
  });

  it('rehydrates the artifact after the preview is closed', async () => {
    const artifact = {
      id: 'artifact',
      identifier: 'dashboard',
      messageId: 'message-1',
      title: 'Sales dashboard',
      type: 'application/vnd.react',
      content: 'export default function App() {}',
      lastUpdateTime: 2,
    };

    render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.artifactsVisibility, false);
          set(store.artifactsState, { artifact });
          set(store.visibleArtifacts, { artifact });
        }}
      >
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <CloseArtifact />
        <Selection />
      </RecoilRoot>,
    );

    const versionCard = screen.getByRole('button', {
      name: 'com_ui_updated_file:Sales dashboard',
    });
    fireEvent.click(versionCard);
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent(':true:'));
    fireEvent.click(screen.getByTestId('close-artifact'));

    expect(versionCard).toBeEnabled();
    fireEvent.click(versionCard);
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent(
        'artifact-revision:message-1:dashboard:version:2:true',
      ),
    );
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(2);
  });

  it('does not reopen Preview when a pending revision finishes after close', async () => {
    const pending = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    mockGetArtifactRevision.mockReturnValue(pending.promise);

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, true)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <CloseArtifact />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('close-artifact'));

    await act(async () => {
      pending.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: 'late snapshot',
        version: 2,
      });
    });
    expect(screen.getByTestId('selection')).toHaveTextContent('null:false:');
  });

  it('does not reopen an artifact after its conversation card unmounts', async () => {
    const pending = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    mockGetArtifactRevision.mockReturnValue(pending.promise);
    const view = render(
      <RecoilRoot>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1));

    view.rerender(
      <RecoilRoot>
        <Selection />
      </RecoilRoot>,
    );
    await act(async () => {
      pending.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: 'departed conversation snapshot',
        version: 2,
      });
    });

    expect(screen.getByTestId('selection')).toHaveTextContent('null:true:');
  });

  it('keeps the last clicked version when earlier snapshot requests finish later', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 3,
      revisions: [
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 1,
          available: true,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 2,
          available: true,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 3,
          available: true,
        },
      ],
    });
    const versionTwo = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    const versionThree = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    mockGetArtifactRevision.mockImplementation(({ version }: { version: number }) =>
      version === 2 ? versionTwo.promise : versionThree.promise,
    );

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <ArtifactEditCall
          result={parseArtifactEditResult(JSON.stringify({ ...JSON.parse(output), version: 3 }))!}
        />
        <Selection />
      </RecoilRoot>,
    );

    const cards = screen.getAllByRole('button', {
      name: 'com_ui_updated_file:Sales dashboard',
    });
    fireEvent.click(cards[0]);
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1));
    fireEvent.click(cards[1]);
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(2));

    await act(async () => {
      versionThree.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: 'pink snapshot',
        version: 3,
      });
    });
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('pink snapshot'));

    await act(async () => {
      versionTwo.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: 'green snapshot',
        version: 2,
      });
    });
    expect(screen.getByTestId('selection')).toHaveTextContent('version:3:true:pink snapshot');
  });

  it('keeps the last clicked artifact when requests from different lineages finish out of order', async () => {
    const dashboard = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    const report = deferred<{
      title: string;
      type: string;
      content: string;
      version: number;
    }>();
    mockGetArtifactRevisionHistory.mockImplementation(({ identifier }: { identifier: string }) =>
      Promise.resolve({
        currentVersion: 2,
        revisions: [
          {
            title: identifier === 'dashboard' ? 'Sales dashboard' : 'Quarterly report',
            type: 'application/vnd.react',
            version: 1,
            available: true,
          },
          {
            title: identifier === 'dashboard' ? 'Sales dashboard' : 'Quarterly report',
            type: 'application/vnd.react',
            version: 2,
            available: true,
          },
        ],
      }),
    );
    mockGetArtifactRevision.mockImplementation(({ identifier }: { identifier: string }) =>
      identifier === 'dashboard' ? dashboard.promise : report.promise,
    );
    const reportOutput = JSON.stringify({
      ...JSON.parse(output),
      identifier: 'report',
      messageId: 'message-2',
      title: 'Quarterly report',
    });

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <ArtifactEditCall result={parseArtifactEditResult(reportOutput)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Quarterly report' }));
    await waitFor(() => expect(mockGetArtifactRevision).toHaveBeenCalledTimes(2));

    await act(async () => {
      report.resolve({
        title: 'Quarterly report',
        type: 'application/vnd.react',
        content: 'report snapshot',
        version: 2,
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('report snapshot'),
    );

    await act(async () => {
      dashboard.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: 'dashboard snapshot',
        version: 2,
      });
    });
    expect(screen.getByTestId('selection')).toHaveTextContent(
      'artifact-revision:message-2:report:version:2:true:report snapshot',
    );
  });

  it('reports an unavailable historical version instead of substituting another snapshot', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 3,
      revisions: [
        { version: 1, available: false },
        { version: 2, available: false },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          version: 3,
          available: true,
        },
      ],
    });

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('com_ui_error'));
    expect(screen.getByTestId('selection')).toHaveTextContent('null:false:');
  });

  it('surfaces an unavailable history endpoint without calling the exact endpoint', async () => {
    mockGetArtifactRevisionHistory.mockRejectedValue({ response: { status: 404 } });

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('com_ui_error'));
    expect(mockGetArtifactRevision).not.toHaveBeenCalled();
  });

  it('surfaces an exact snapshot 404 after history succeeds', async () => {
    mockGetArtifactRevision.mockRejectedValue({ response: { status: 404 } });

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('com_ui_error'));
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(1);
    expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1);
    expect(mockGetArtifactRevision).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'dashboard', version: 2 }),
    );
  });

  it('does not let a stale open downgrade newer hydrated history', () => {
    const olderHistory: ArtifactRevisionEntry[] = [
      { id: 'dashboard-v1', version: 1, available: true },
      { id: 'dashboard-v2', version: 2, available: true },
    ];
    const newerHistory: ArtifactRevisionEntry[] = [
      ...olderHistory,
      { id: 'dashboard-v3', version: 3, available: true },
    ];
    const artifact = (id: string, version: number, history: ArtifactRevisionEntry[]): Artifact => ({
      id,
      messageId: 'message-1',
      identifier: 'dashboard',
      content: `version ${version}`,
      lastUpdateTime: version,
      knaufRevision: { identifier: 'dashboard', version },
      knaufRevisionHistory: history,
    });

    const merged = mergeArtifactRevisionRegistry({
      current: { 'dashboard-v3': artifact('dashboard-v3', 3, newerHistory) },
      additions: [artifact('dashboard-v2', 2, olderHistory)],
      messageId: 'message-1',
      identifier: 'dashboard',
      history: olderHistory,
    });

    expect(merged['dashboard-v3']).toBeDefined();
    expect(merged['dashboard-v2']?.knaufRevisionHistory).toEqual(newerHistory);

    const upgraded = mergeArtifactRevisionRegistry({
      current: { 'dashboard-v2': artifact('dashboard-v2', 2, olderHistory) },
      additions: [artifact('dashboard-v3', 3, newerHistory)],
      messageId: 'message-1',
      identifier: 'dashboard',
      history: newerHistory,
    });
    expect(upgraded['dashboard-v3']?.knaufRevisionHistory).toEqual(newerHistory);

    const sparseHistory: ArtifactRevisionEntry[] = [
      { id: null, version: 1, available: false },
      ...newerHistory.slice(1),
    ];
    const availabilityPreserved = mergeArtifactRevisionRegistry({
      current: { 'dashboard-v3': artifact('dashboard-v3', 3, newerHistory) },
      additions: [],
      messageId: 'message-1',
      identifier: 'dashboard',
      history: sparseHistory,
    });
    expect(availabilityPreserved['dashboard-v3']?.knaufRevisionHistory).toEqual(newerHistory);
  });
});

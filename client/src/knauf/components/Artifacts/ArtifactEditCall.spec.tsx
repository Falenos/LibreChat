import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import store from '~/store';
import ArtifactEditCall, { parseArtifactEditResult } from './ArtifactEditCall';

const mockGetArtifactRevisionHistory = jest.fn();
const mockGetArtifactRevision = jest.fn();

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
      content: 'legacy exact snapshot',
      version: 2,
    });
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 2,
      revisions: [
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          content: 'root snapshot',
          version: 1,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          content: 'export default function App() {}',
          version: 2,
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

  it('opens an immutable artifact revision from its compact version card', async () => {
    render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.artifactsVisibility, false);
          set(store.artifactsState, {
            artifact: {
              id: 'artifact',
              identifier: 'dashboard',
              messageId: 'message-1',
              title: 'Sales dashboard',
              type: 'application/vnd.react',
              content: 'export default function App() {}',
              lastUpdateTime: 2,
            },
          });
        }}
      >
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));

    expect(screen.getByText('com_ui_version_var:2')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent(
        'artifact-revision:message-1:dashboard:version:2:true',
      ),
    );
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
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(1);
  });

  it('opens distinct immutable snapshots for historical version cards', async () => {
    mockGetArtifactRevisionHistory.mockResolvedValue({
      currentVersion: 3,
      revisions: [
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          content: 'root snapshot',
          version: 1,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          content: 'green snapshot',
          version: 2,
        },
        {
          title: 'Sales dashboard',
          type: 'application/vnd.react',
          content: 'pink snapshot',
          version: 3,
        },
      ],
    });

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
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('green snapshot'),
    );

    fireEvent.click(cards[1]);
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('pink snapshot'));
    expect(screen.getByTestId('selection')).toHaveTextContent('version:3');
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledTimes(1);
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
          content: 'pink snapshot',
          version: 3,
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

  it('falls back to the exact revision endpoint during a rolling API deployment', async () => {
    mockGetArtifactRevisionHistory.mockRejectedValue({ response: { status: 404 } });

    render(
      <RecoilRoot initializeState={({ set }) => set(store.artifactsVisibility, false)}>
        <ArtifactEditCall result={parseArtifactEditResult(output)!} />
        <Selection />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_updated_file:Sales dashboard' }));

    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('legacy exact snapshot'),
    );
    expect(mockGetArtifactRevision).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'dashboard', version: 2 }),
    );
  });

  it('does not mask history service failures with the legacy endpoint', async () => {
    mockGetArtifactRevisionHistory.mockRejectedValue({ response: { status: 500 } });

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
});

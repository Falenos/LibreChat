import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import store from '~/store';
import ArtifactEditCall, { parseArtifactEditResult } from './ArtifactEditCall';

const mockGetArtifactRevision = jest.fn();

jest.mock('~/knauf/data-provider/data-service', () => ({
  getArtifactRevision: (...args: unknown[]) => mockGetArtifactRevision(...args),
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
      onClick={() => {
        setArtifacts(null);
        setCurrentArtifactId(null);
        setVisible(false);
      }}
    >
      Close artifact
    </button>
  );
}

describe('ArtifactEditCall', () => {
  beforeEach(() => {
    mockGetArtifactRevision.mockReset();
    mockGetArtifactRevision.mockResolvedValue({
      title: 'Sales dashboard',
      type: 'application/vnd.react',
      content: 'export default function App() {}',
      version: 2,
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
    fireEvent.click(screen.getByRole('button', { name: 'Close artifact' }));

    expect(versionCard).toBeEnabled();
    fireEvent.click(versionCard);
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent(
        'artifact-revision:message-1:dashboard:version:2:true',
      ),
    );
    expect(mockGetArtifactRevision).toHaveBeenCalledTimes(1);
  });

  it('opens distinct immutable snapshots for historical version cards', async () => {
    mockGetArtifactRevision.mockImplementation(({ version }: { version: number }) =>
      Promise.resolve({
        title: 'Sales dashboard',
        type: 'application/vnd.react',
        content: version === 2 ? 'green snapshot' : 'pink snapshot',
        version,
      }),
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
    await waitFor(() =>
      expect(screen.getByTestId('selection')).toHaveTextContent('green snapshot'),
    );

    fireEvent.click(cards[1]);
    await waitFor(() => expect(screen.getByTestId('selection')).toHaveTextContent('pink snapshot'));
    expect(screen.getByTestId('selection')).toHaveTextContent('version:3');
  });
});

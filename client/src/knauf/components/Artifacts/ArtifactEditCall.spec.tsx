import { fireEvent, render, screen } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, useSetRecoilState } from 'recoil';
import store from '~/store';
import ArtifactEditCall, { parseArtifactEditResult } from './ArtifactEditCall';

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
  return <div data-testid="selection">{`${currentArtifactId}:${visible}`}</div>;
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
  it('parses only completed artifact update payloads', () => {
    expect(parseArtifactEditResult(output)).toEqual(
      expect.objectContaining({ identifier: 'dashboard', version: 2 }),
    );
    expect(parseArtifactEditResult('{"status":"error"}')).toBeNull();
    expect(parseArtifactEditResult('not-json')).toBeNull();
  });

  it('opens the same logical artifact from its compact version card', () => {
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
    expect(screen.getByTestId('selection')).toHaveTextContent('artifact:true');
  });

  it('rehydrates the artifact after the preview is closed', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Close artifact' }));

    expect(versionCard).toBeEnabled();
    fireEvent.click(versionCard);
    expect(screen.getByTestId('selection')).toHaveTextContent('artifact:true');
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import ArtifactButton from '~/components/Artifacts/ArtifactButton';
import store from '~/store';

const mockCancelArtifactRevisionOpen = jest.fn();

jest.mock('~/knauf/utils/artifactRevisions', () => ({
  cancelArtifactRevisionOpen: () => mockCancelArtifactRevisionOpen(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  getFileType: () => 'artifact',
  isArtifactRoute: () => false,
  logger: { log: jest.fn() },
}));

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/c/conversation-1' }),
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => null,
}));

const artifact = {
  id: 'artifact-2',
  title: 'Second artifact',
  type: 'text/html',
  content: '<h1>Second</h1>',
  lastUpdateTime: 2,
};

function SelectionState() {
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const isVisible = useRecoilValue(store.artifactsVisibility);
  return <div data-testid="selection">{`${currentArtifactId}:${isVisible}`}</div>;
}

describe('ArtifactButton revision cancellation seam', () => {
  beforeEach(() => {
    mockCancelArtifactRevisionOpen.mockReset();
  });

  it('cancels an older revision request before opening an unselected artifact card', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.currentArtifactId, 'artifact-1');
          set(store.artifactsVisibility, true);
          set(store.artifactsState, { [artifact.id]: artifact });
        }}
      >
        <ArtifactButton artifact={artifact} />
        <SelectionState />
      </RecoilRoot>,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(mockCancelArtifactRevisionOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('selection')).toHaveTextContent('artifact-2:true');
  });
});

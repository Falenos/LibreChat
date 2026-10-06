import { act, render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import Artifacts from '~/components/Artifacts/Artifacts';

const mockCancelArtifactRevisionOpen = jest.fn();

const sharedArtifact = {
  id: 'artifact-1',
  title: 'Status page',
  type: 'text/html',
  content: '<h1>Ready</h1>',
  messageId: 'message-1',
  index: 0,
  lastUpdateTime: 1,
};

jest.mock('~/hooks/Artifacts/useArtifacts', () => ({
  __esModule: true,
  default: () => ({
    activeTab: 'preview',
    setActiveTab: jest.fn(),
    currentIndex: 0,
    currentArtifact: sharedArtifact,
    artifactVersions: [],
    artifactVersionError: false,
    isArtifactVersionLoading: false,
    selectArtifactVersion: jest.fn(),
    orderedArtifactIds: ['artifact-1'],
    setCurrentArtifactId: jest.fn(),
  }),
}));

jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers'),
  useMutationState: () => ({ isMutating: false }),
  useShareContext: () => ({ isSharedConvo: false }),
  useArtifactsContext: () => ({ conversationId: 'conversation-1' }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useMediaQuery: () => false,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/knauf/utils/artifactRevisions', () => ({
  cancelArtifactRevisionOpen: () => mockCancelArtifactRevisionOpen(),
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/knauf/components/Artifacts/ArtifactDownloadMenu', () => ({
  __esModule: true,
  default: () => <button data-testid="artifact-download" />,
}));

jest.mock('~/components/Artifacts/ArtifactTabs', () => ({
  __esModule: true,
  default: () => <div data-testid="artifact-tabs" />,
}));

jest.mock('~/knauf/components/Artifacts/ShareArtifactButton', () => ({
  __esModule: true,
  default: () => <button data-testid="share-artifact" />,
}));

describe('Artifacts artifact-only share seam', () => {
  beforeEach(() => {
    mockCancelArtifactRevisionOpen.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mounts the artifact share action for an owned conversation artifact', () => {
    render(
      <RecoilRoot>
        <Artifacts />
      </RecoilRoot>,
    );

    act(() => {
      jest.advanceTimersByTime(50);
    });

    expect(screen.getByTestId('share-artifact')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-download')).toBeInTheDocument();
  });

  it('cancels pending revision opens when Preview closes', () => {
    render(
      <RecoilRoot>
        <Artifacts />
      </RecoilRoot>,
    );

    act(() => {
      jest.advanceTimersByTime(50);
    });
    screen.getByRole('button', { name: 'com_ui_close' }).click();

    expect(mockCancelArtifactRevisionOpen).toHaveBeenCalledTimes(1);
  });
});

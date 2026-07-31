import { render, screen } from '@testing-library/react';
import ShareView from '~/components/Share/ShareView';

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ shareId: 'share-1' }),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilState: () => ['en', jest.fn()],
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetSharedMessages: () => ({
    isLoading: false,
    data: {
      kind: 'artifact',
      shareId: 'share-1',
      title: 'Shared artifact',
      conversationId: 'anonymous-conversation',
      messages: [],
      artifact: {
        title: 'Shared artifact',
        type: 'text/markdown',
        content: '# Snapshot',
      },
    },
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetSharedStartupConfig: () => ({ data: { appTitle: 'KARL' } }),
}));

jest.mock('~/hooks', () => ({
  useDocumentTitle: jest.fn(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/knauf/components/Share/ArtifactShareView', () => ({
  __esModule: true,
  default: ({ artifact }: { artifact: { title: string } }) => (
    <div data-testid="artifact-share-view">{artifact.title}</div>
  ),
}));

jest.mock('~/components/Share/MessagesView', () => ({
  __esModule: true,
  default: () => <div data-testid="messages-view" />,
}));

describe('ShareView artifact-only projection', () => {
  it('renders the artifact landing page without mounting conversation messages', () => {
    render(<ShareView />);

    expect(screen.getByTestId('artifact-share-view')).toHaveTextContent('Shared artifact');
    expect(screen.queryByTestId('messages-view')).not.toBeInTheDocument();
  });
});

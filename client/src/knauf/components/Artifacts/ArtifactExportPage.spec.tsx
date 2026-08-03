import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Artifact } from '~/common';
import ArtifactExportPage from './ArtifactExportPage';

jest.mock('~/hooks/Artifacts/useArtifactProps', () => ({
  __esModule: true,
  default: () => ({
    files: { 'App.tsx': 'source' },
    fileKey: 'App.tsx',
    template: 'react-ts',
    sharedProps: {},
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Artifacts/ArtifactPreview', () => ({
  ArtifactPreview: ({ artifact }: Readonly<{ artifact: Artifact }>) => (
    <div data-testid="rendered-artifact">{artifact.content}</div>
  ),
}));

jest.mock('~/knauf/data-provider/api-endpoints', () => ({
  artifactExportSnapshot: (token: string) => `/api/snapshot/${token}`,
}));

describe('ArtifactExportPage', () => {
  beforeEach(() => {
    window.location.hash = '#one-time-secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          artifact: {
            title: 'Status',
            type: 'text/html',
            content: '<main>Ready</main>',
          },
        }),
    }) as unknown as typeof fetch;
  });

  it('loads the one-time snapshot and mounts only the artifact preview', async () => {
    render(
      <MemoryRouter initialEntries={['/artifact-export/token-1']}>
        <Routes>
          <Route path="artifact-export/:token" element={<ArtifactExportPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('rendered-artifact')).toHaveTextContent('<main>Ready</main>');
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/snapshot/token-1',
        expect.objectContaining({
          headers: { 'X-Knauf-Export-Secret': 'one-time-secret' },
        }),
      ),
    );
    expect(screen.getByTestId('artifact-export-root')).toHaveAttribute(
      'data-knauf-artifact-export',
      'rendering',
    );
  });
});

import axios from 'axios';
import { postArtifactExport } from './data-service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    isAxiosError: (error: unknown) =>
      error != null && typeof error === 'object' && 'isAxiosError' in error,
    post: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  request: {
    delete: jest.fn(),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

describe('postArtifactExport', () => {
  it('parses structured JSON errors returned as blobs', async () => {
    const data = new Blob([], { type: 'application/json; charset=utf-8' });
    Object.defineProperty(data, 'text', {
      value: async () =>
        JSON.stringify({
          message: 'Artifact has too many pages to export',
          code: 'artifact_page_limit',
          details: { actualPages: 26, maxPages: 25 },
        }),
    });
    (axios.post as jest.Mock).mockRejectedValue({ isAxiosError: true, response: { data } });

    await expect(
      postArtifactExport(
        { title: 'Deck', type: 'application/vnd.react', content: 'export default 1' },
        'pdf',
      ),
    ).rejects.toMatchObject({
      name: 'ArtifactExportRequestError',
      message: 'Artifact has too many pages to export',
      code: 'artifact_page_limit',
      details: { actualPages: 26, maxPages: 25 },
    });
  });
});

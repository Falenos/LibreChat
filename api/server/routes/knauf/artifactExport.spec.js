const express = require('express');
const request = require('supertest');
const { logger } = require('@librechat/data-schemas');

const mockGetSharedMessages = jest.fn();
const mockRenderArtifact = jest.fn();

jest.mock('~/models', () => ({
  getSharedMessages: (...args) => mockGetSharedMessages(...args),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('~/server/middleware/optionalJwtAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware/canAccessSharedLink', () => (req, _res, next) => {
  req.shareResourceId = 'share-resource-1';
  next();
});

jest.mock('~/server/services/Artifacts/knauf/export', () => ({
  ArtifactExportError: class ArtifactExportError extends Error {
    constructor(message, status = 400, options = {}) {
      super(message);
      this.status = status;
      this.code = options.code;
      this.details = options.details;
    }
  },
  getRenderSnapshot: jest.fn(),
  renderArtifact: (...args) => mockRenderArtifact(...args),
}));

const artifactExportRouter = require('./artifactExport');

const artifact = {
  title: 'Quarterly status',
  type: 'application/vnd.react',
  content: 'export default () => <main>Ready</main>;',
};

const createApp = () => {
  const app = express();
  app.use(express.json(), artifactExportRouter);
  return app;
};

describe('artifact PNG/PDF export routes', () => {
  beforeEach(() => {
    mockGetSharedMessages.mockReset();
    mockRenderArtifact.mockReset().mockResolvedValue({
      buffer: Buffer.from('rendered'),
      mime: 'image/png',
      extension: 'png',
    });
  });

  it('returns an authenticated artifact as an attachment', async () => {
    const response = await request(createApp())
      .post('/')
      .send({ artifact, format: 'png' })
      .expect(200);

    expect(mockRenderArtifact).toHaveBeenCalledWith(artifact, 'png');
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toContain('Quarterly status.png');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('exports only the immutable snapshot behind an accessible shared link', async () => {
    mockGetSharedMessages.mockResolvedValue({ kind: 'artifact', artifact });
    mockRenderArtifact.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      mime: 'application/pdf',
      extension: 'pdf',
    });

    const response = await request(createApp())
      .post('/shared/share-1')
      .send({ format: 'pdf' })
      .expect(200);

    expect(mockGetSharedMessages).toHaveBeenCalledWith('share-1', 'share-resource-1', {
      snapshotFiles: false,
    });
    expect(mockRenderArtifact).toHaveBeenCalledWith(artifact, 'pdf');
    expect(response.headers['content-type']).toContain('application/pdf');
  });

  it('does not export a conversation share as an artifact', async () => {
    mockGetSharedMessages.mockResolvedValue({ kind: 'conversation', messages: [] });

    await request(createApp()).post('/shared/share-1').send({ format: 'png' }).expect(404);

    expect(mockRenderArtifact).not.toHaveBeenCalled();
  });

  it('does not write renderer internals to logs or the response', async () => {
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    mockRenderArtifact.mockRejectedValue(
      Object.assign(new Error('secret renderer detail'), {
        code: 'SECRET_PROVIDER_CODE',
        details: { path: '/secret/path' },
      }),
    );

    const response = await request(createApp()).post('/').send({ artifact, format: 'png' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Artifact export failed' });
    expect(errorLog).toHaveBeenCalledWith('[artifactExport] Export failed', { status: 500 });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret renderer detail');
  });

  it('returns safe structured details for a known export limit', async () => {
    mockRenderArtifact.mockRejectedValue(
      new (jest.requireMock('~/server/services/Artifacts/knauf/export').ArtifactExportError)(
        'Artifact has too many pages to export',
        413,
        {
          code: 'artifact_page_limit',
          details: { format: 'pdf', actualPages: 26, maxPages: 25 },
        },
      ),
    );

    const response = await request(createApp()).post('/').send({ artifact, format: 'pdf' });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      message: 'Artifact has too many pages to export',
      code: 'artifact_page_limit',
      details: { format: 'pdf', actualPages: 26, maxPages: 25 },
    });
  });
});

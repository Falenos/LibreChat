const express = require('express');
const request = require('supertest');

const mockGetMessages = jest.fn();
const mockGetArtifactRevisionHistory = jest.fn();
const mockGetArtifactRevisionSnapshot = jest.fn();
const mockLean = jest.fn();
const mockSelect = jest.fn(() => ({ lean: mockLean }));
const mockFindOne = jest.fn(() => ({ select: mockSelect }));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('mongoose', () => ({
  models: { Message: { findOne: (...args) => mockFindOne(...args) } },
}));

jest.mock('~/models', () => ({
  getMessages: (...args) => mockGetMessages(...args),
}));

jest.mock('~/server/services/Artifacts/knauf/edit', () => ({
  ArtifactEditError: class ArtifactEditError extends Error {},
  getArtifactRevisionHistory: (...args) => mockGetArtifactRevisionHistory(...args),
  getArtifactRevisionSnapshot: (...args) => mockGetArtifactRevisionSnapshot(...args),
}));

jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));

const artifactRevisions = require('./artifactRevisions');

describe('artifact revision route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLean.mockResolvedValue({ conversationId: 'conversation-1' });
    mockGetMessages.mockResolvedValue([{ messageId: 'message-1' }]);
    mockGetArtifactRevisionSnapshot.mockReturnValue({
      title: 'Dashboard',
      type: 'text/html',
      content: '<main>green</main>',
      version: 2,
    });
    mockGetArtifactRevisionHistory.mockReturnValue({
      currentVersion: 2,
      revisions: [
        { title: 'Dashboard', type: 'text/html', content: '<main>blue</main>', version: 1 },
        { title: 'Dashboard', type: 'text/html', content: '<main>green</main>', version: 2 },
      ],
    });
  });

  it('returns only a revision from the authenticated user conversation', async () => {
    const app = express();
    app.use(artifactRevisions);

    const response = await request(app).get('/?messageId=message-1&identifier=dashboard&version=2');

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({ user: 'user-1', messageId: 'message-1' });
    expect(mockGetMessages).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
    });
    expect(mockGetArtifactRevisionSnapshot).toHaveBeenCalledWith([{ messageId: 'message-1' }], {
      messageId: 'message-1',
      identifier: 'dashboard',
      version: 2,
    });
    expect(response.body.content).toBe('<main>green</main>');
  });

  it('rejects an invalid version before loading the owned conversation', async () => {
    const app = express();
    app.use(artifactRevisions);

    const response = await request(app).get('/?messageId=message-1&identifier=dashboard&version=0');

    expect(response.status).toBe(400);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  it('returns the complete authenticated revision history', async () => {
    const app = express();
    app.use(artifactRevisions);

    const response = await request(app).get('/history?messageId=message-1&identifier=dashboard');

    expect(response.status).toBe(200);
    expect(mockGetArtifactRevisionHistory).toHaveBeenCalledWith([{ messageId: 'message-1' }], {
      messageId: 'message-1',
      identifier: 'dashboard',
    });
    expect(response.body.revisions).toHaveLength(2);
  });
});

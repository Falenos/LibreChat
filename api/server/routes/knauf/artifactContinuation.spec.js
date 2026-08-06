const express = require('express');
const request = require('supertest');
const { findAllArtifacts } = require('@librechat/api');

const mockGetSharedMessages = jest.fn();
const mockCreateImportBatchBuilder = jest.fn();

jest.mock('~/models', () => ({
  getSharedMessages: (...args) => mockGetSharedMessages(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'recipient-1' };
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = { interfaceConfig: { retentionMode: 'all' } };
    next();
  },
}));

jest.mock('~/server/middleware/canAccessSharedLink', () => (req, _res, next) => {
  req.shareResourceId = 'share-resource-1';
  next();
});

jest.mock('~/server/utils/import/importBatchBuilder', () => ({
  createImportBatchBuilder: (...args) => mockCreateImportBatchBuilder(...args),
}));

const artifactContinuationRouter = require('./artifactContinuation');
const { buildArtifactDirective } = require('./artifactContinuation');

const conversation = {
  conversationId: 'new',
  endpoint: 'agents',
  agent_id: 'recipient-agent',
  title: 'New Chat',
  createdAt: '',
  updatedAt: '',
};

function createApp() {
  const app = express();
  app.use(express.json(), artifactContinuationRouter);
  return app;
}

describe('shared artifact continuation', () => {
  let builder;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = {
      startConversation: jest.fn(),
      addGptMessage: jest.fn().mockReturnValue({ messageId: 'artifact-message-1' }),
      finishConversation: jest.fn().mockReturnValue({
        conversation: { conversationId: 'recipient-conversation-1', title: 'Shared deck' },
        messages: [{ messageId: 'artifact-message-1' }],
      }),
      saveBatch: jest.fn().mockResolvedValue(undefined),
    };
    mockCreateImportBatchBuilder.mockReturnValue(builder);
    mockGetSharedMessages.mockResolvedValue({
      kind: 'artifact',
      artifact: {
        title: 'Shared deck',
        type: 'application/vnd.react',
        content: 'export default function App() { return <main>Exact snapshot</main>; }',
      },
    });
  });

  it('creates a recipient-owned conversation containing only the shared artifact snapshot', async () => {
    const response = await request(createApp())
      .post('/share-1')
      .send({ conversation, artifact: { content: 'client-controlled replacement' } })
      .expect(201);

    expect(mockGetSharedMessages).toHaveBeenCalledWith('share-1', 'share-resource-1', {
      snapshotFiles: false,
    });
    expect(mockCreateImportBatchBuilder).toHaveBeenCalledWith('recipient-1', {
      retentionMode: 'all',
    });
    expect(builder.startConversation).toHaveBeenCalledWith('agents');
    const importedText = builder.addGptMessage.mock.calls[0][0];
    expect(importedText).toContain('Exact snapshot');
    expect(importedText).not.toContain('client-controlled replacement');
    expect(builder.finishConversation).toHaveBeenCalledWith(
      'Shared deck',
      expect.any(Date),
      expect.objectContaining({ endpoint: 'agents', agent_id: 'recipient-agent', tags: [] }),
      undefined,
      expect.any(Date),
    );
    expect(builder.saveBatch).toHaveBeenCalled();
    expect(response.body).toMatchObject({
      conversation: { conversationId: 'recipient-conversation-1' },
      messages: [{ messageId: 'artifact-message-1' }],
      artifactId: 'shared-artifact_application/vnd.react_shared_deck_artifact-message-1',
    });
  });

  it('rejects conversation shares and invalid recipient conversation setup', async () => {
    mockGetSharedMessages.mockResolvedValue({ kind: 'conversation', messages: [] });

    await request(createApp()).post('/share-1').send({ conversation }).expect(404);
    await request(createApp())
      .post('/share-1')
      .send({ conversation: { ...conversation, endpoint: null } })
      .expect(400);

    expect(builder.saveBatch).not.toHaveBeenCalled();
  });

  it('uses a collision-free code fence without changing the artifact source', () => {
    const source = 'const example = ```nested```;\nexport default example;';
    const serialized = buildArtifactDirective({
      title: 'Fence test',
      type: 'application/vnd.react',
      language: 'tsx`\n:::',
      content: source,
    });

    expect(serialized.text).toContain('````tsx');
    expect(serialized.text).toContain(source);
    expect(findAllArtifacts({ text: serialized.text })).toHaveLength(1);
  });
});

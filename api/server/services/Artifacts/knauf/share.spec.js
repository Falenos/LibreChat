const { createArtifactShare, MAX_ARTIFACT_BYTES } = require('./share');

const buildMongoose = (message) => {
  const create = jest.fn().mockResolvedValue({ _id: { toString: () => 'share-object-id' } });
  return {
    mongoose: {
      models: {
        Message: {
          findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(message) })),
        },
        SharedLink: { create },
      },
    },
    create,
  };
};

describe('artifact-only shared links', () => {
  test('snapshots one inline artifact from the owned source message', async () => {
    const message = {
      _id: 'message-object-id',
      messageId: 'message-1',
      text: `Before
:::artifact{identifier="page" type="text/html" title="Status page"}
<h1>Ready</h1>
:::
After`,
    };
    const { mongoose, create } = buildMongoose(message);

    const result = await createArtifactShare({
      mongoose,
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      locator: { kind: 'directive', index: 0 },
    });

    expect(result).toEqual({
      _id: 'share-object-id',
      shareId: expect.any(String),
      conversationId: 'conversation-1',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        messages: [],
        snapshotFiles: false,
        knauf_artifact: {
          title: 'Status page',
          type: 'text/html',
          content: '<h1>Ready</h1>',
        },
      }),
    );
  });

  test('uses stored file text instead of accepting artifact content from the client', async () => {
    const message = {
      _id: 'message-object-id',
      messageId: 'message-1',
      attachments: [
        {
          file_id: 'file-1',
          filename: 'notes.md',
          text: '# Server-owned snapshot',
        },
      ],
    };
    const { mongoose, create } = buildMongoose(message);

    await createArtifactShare({
      mongoose,
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      locator: { kind: 'file', fileId: 'file-1', type: 'text/markdown' },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        knauf_artifact: {
          title: 'notes.md',
          type: 'text/markdown',
          content: '# Server-owned snapshot',
        },
      }),
    );
  });

  test('rejects unsupported artifact types and oversized content before persistence', async () => {
    const unsupported = buildMongoose({
      _id: 'message-object-id',
      text: ':::artifact{type="image/svg+xml" title="SVG"}\n<svg />\n:::',
    });
    await expect(
      createArtifactShare({
        mongoose: unsupported.mongoose,
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        locator: { kind: 'directive', index: 0 },
      }),
    ).rejects.toMatchObject({ status: 400, message: 'Unsupported artifact type' });
    expect(unsupported.create).not.toHaveBeenCalled();

    const oversized = buildMongoose({
      _id: 'message-object-id',
      attachments: [
        {
          file_id: 'file-1',
          filename: 'large.txt',
          text: 'x'.repeat(MAX_ARTIFACT_BYTES + 1),
        },
      ],
    });
    await expect(
      createArtifactShare({
        mongoose: oversized.mongoose,
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        locator: { kind: 'file', fileId: 'file-1', type: 'text/plain' },
      }),
    ).rejects.toMatchObject({ status: 413, message: 'Artifact is too large to share' });
    expect(oversized.create).not.toHaveBeenCalled();
  });
});

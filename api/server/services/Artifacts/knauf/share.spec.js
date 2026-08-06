const { createArtifactShare, MAX_ARTIFACT_BYTES } = require('./share');
const { sha256 } = require('./edit');

const buildMongoose = (message, messages = [message]) => {
  const create = jest.fn().mockResolvedValue({ _id: { toString: () => 'share-object-id' } });
  return {
    mongoose: {
      models: {
        Message: {
          findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(message) })),
          find: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(messages) })),
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

  test('stores only fenced source for a compiled inline artifact', async () => {
    const message = {
      _id: 'message-object-id',
      messageId: 'message-1',
      text: `:::artifact{identifier="page" type="application/vnd.react" title="Status page"}
\`\`\`tsx
export default function App() {
  return <div>Ready</div>;
}
\`\`\`
A clean, branded summary with citations that must not compile.
:::`,
    };
    const { mongoose, create } = buildMongoose(message);

    await createArtifactShare({
      mongoose,
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      locator: { kind: 'directive', index: 0 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        knauf_artifact: expect.objectContaining({
          content: `export default function App() {
  return <div>Ready</div>;
}`,
        }),
      }),
    );
  });

  test('shares only the exact fenced Unicode source for a native SVG artifact', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Grüße</text></svg>';
    const message = {
      _id: 'message-object-id',
      messageId: 'message-1',
      text: `:::artifact{identifier="mark" type="image/svg+xml" title="Brand mark"}
\`\`\`svg
${svg}
\`\`\`
This prose is not part of the vector.
:::`,
    };
    const { mongoose, create } = buildMongoose(message);

    await createArtifactShare({
      mongoose,
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      locator: { kind: 'directive', index: 0 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        knauf_artifact: {
          title: 'Brand mark',
          type: 'image/svg+xml',
          content: svg,
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

  test('shares the exact immutable artifact revision selected by the user', async () => {
    const colourStart = 'The theme colour is '.length;
    const source = {
      messageId: 'message-1',
      text: `:::artifact{identifier="page" type="text/html" title="Status page" version="3"}
The theme colour is pink.
:::`,
    };
    const edit = {
      messageId: 'message-2',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            name: 'edit_artifact',
            output: JSON.stringify({
              status: 'updated',
              identifier: 'page',
              messageId: 'message-1',
              version: 3,
              base_sha256: sha256('The theme colour is green.'),
              content_sha256: sha256('The theme colour is pink.'),
              inverse_patches: [{ start: colourStart, old: 'green', new_length: 'pink'.length }],
            }),
          },
        },
      ],
    };
    const { mongoose, create } = buildMongoose(source, [source, edit]);

    await createArtifactShare({
      mongoose,
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      locator: { kind: 'revision', identifier: 'page', version: 2 },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        knauf_artifact: expect.objectContaining({ content: 'The theme colour is green.' }),
      }),
    );
  });

  test('rejects unsupported artifact types and oversized content before persistence', async () => {
    const unsupported = buildMongoose({
      _id: 'message-object-id',
      text: ':::artifact{type="application/json" title="JSON"}\n{}\n:::',
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

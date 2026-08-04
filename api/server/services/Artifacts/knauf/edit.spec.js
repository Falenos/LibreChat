const {
  applyArtifactEdit,
  buildArtifactEditContext,
  compareAndSwapMessage,
  createEditArtifactTool,
  getArtifactRevisionSnapshot,
  sha256,
} = require('./edit');

const artifact = (
  identifier,
  source,
) => `:::artifact{identifier="${identifier}" type="application/vnd.react" title="Demo"}
\`\`\`tsx
${source}
\`\`\`
:::`;

describe('edit_artifact', () => {
  test('atomically applies exact replacements to the latest owned artifact', async () => {
    const older = {
      messageId: 'assistant-1',
      conversationId: 'conversation-1',
      user: 'user-1',
      text: artifact('dashboard', 'const colour = "red";'),
    };
    const latest = {
      messageId: 'assistant-2',
      conversationId: 'conversation-1',
      user: 'user-1',
      content: [{ type: 'text', text: artifact('dashboard', 'const colour = "blue";') }],
    };
    const getMessages = jest.fn().mockResolvedValue([older, latest]);
    const compareAndSwap = jest.fn().mockResolvedValue(true);

    const result = await applyArtifactEdit(
      {
        userId: 'user-1',
        conversationId: 'conversation-1',
        identifier: 'dashboard',
        expectedSha256: sha256('const colour = "blue";'),
        replacements: [{ old: '"blue"', new: '"cyan"' }],
      },
      { getMessages, compareAndSwap },
    );

    expect(getMessages).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
    });
    expect(compareAndSwap).toHaveBeenCalledTimes(1);
    expect(compareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'assistant-2',
        source: 'content',
        partIndex: 0,
        original: latest.content[0].text,
        updated: expect.stringContaining(
          ':::artifact{identifier="dashboard" type="application/vnd.react" title="Demo" version="2"}',
        ),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'updated',
        identifier: 'dashboard',
        messageId: 'assistant-2',
        replacements: 1,
        title: 'Demo',
        version: 2,
        baseSha256: sha256('const colour = "blue";'),
        contentSha256: sha256('const colour = "cyan";'),
        inversePatches: [{ start: 15, old: '"blue"', newLength: 6 }],
      }),
    );
  });

  test('reconstructs each historical artifact version from compact inverse patches', () => {
    const source = 'The theme colour is orange.';
    const colourStart = 'The theme colour is '.length;
    const messages = [
      {
        messageId: 'assistant-1',
        text: artifact('dashboard', source).replace('title="Demo"', 'title="Demo" version="4"'),
      },
      {
        messageId: 'assistant-3',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              name: 'edit_artifact',
              output: JSON.stringify({
                status: 'updated',
                identifier: 'dashboard',
                messageId: 'assistant-1',
                version: 3,
                base_sha256: sha256('The theme colour is green.'),
                content_sha256: sha256('The theme colour is pink.'),
                inverse_patches: [{ start: colourStart, old: 'green', new_length: 'pink'.length }],
              }),
            },
          },
        ],
      },
      {
        messageId: 'assistant-4',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              name: 'edit_artifact',
              output: JSON.stringify({
                status: 'updated',
                identifier: 'dashboard',
                messageId: 'assistant-1',
                version: 4,
                base_sha256: sha256('The theme colour is pink.'),
                content_sha256: sha256(source),
                inverse_patches: [{ start: colourStart, old: 'pink', new_length: 'orange'.length }],
              }),
            },
          },
        ],
      },
    ];

    expect(
      getArtifactRevisionSnapshot(messages, {
        messageId: 'assistant-1',
        identifier: 'dashboard',
        version: 2,
      }),
    ).toEqual({
      title: 'Demo',
      type: 'application/vnd.react',
      content: 'The theme colour is green.',
      version: 2,
    });
  });

  test('never substitutes the latest content when a historical patch is unavailable', () => {
    const messages = [
      {
        messageId: 'assistant-1',
        text: artifact('dashboard', 'orange').replace('title="Demo"', 'title="Demo" version="3"'),
      },
    ];

    expect(() =>
      getArtifactRevisionSnapshot(messages, {
        messageId: 'assistant-1',
        identifier: 'dashboard',
        version: 2,
      }),
    ).toThrow(expect.objectContaining({ code: 'revision_unavailable', status: 409 }));
  });

  test('rejects stale revisions and non-unique matches without writing', async () => {
    const message = {
      messageId: 'assistant-1',
      conversationId: 'conversation-1',
      text: artifact('dashboard', 'const blue = "blue"; const other = "blue";'),
    };
    const getMessages = jest.fn().mockResolvedValue([message]);
    const compareAndSwap = jest.fn();

    await expect(
      applyArtifactEdit(
        {
          userId: 'user-1',
          conversationId: 'conversation-1',
          identifier: 'dashboard',
          expectedSha256: '0'.repeat(64),
          replacements: [{ old: 'blue', new: 'cyan' }],
        },
        { getMessages, compareAndSwap },
      ),
    ).rejects.toMatchObject({ code: 'stale_revision', status: 409 });

    await expect(
      applyArtifactEdit(
        {
          userId: 'user-1',
          conversationId: 'conversation-1',
          identifier: 'dashboard',
          expectedSha256: sha256('const blue = "blue"; const other = "blue";'),
          replacements: [{ old: 'blue', new: 'cyan' }],
        },
        { getMessages, compareAndSwap },
      ),
    ).rejects.toMatchObject({ code: 'non_unique_match', status: 409 });

    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  test('publishes bounded revision tokens for the latest artifact per identifier', async () => {
    const getMessages = jest.fn().mockResolvedValue([
      { messageId: 'a', text: artifact('dashboard', 'old') },
      {
        messageId: 'b',
        text: `${artifact('dashboard', 'new')}\n${artifact('report', '# Report')}`,
      },
    ]);

    await expect(
      buildArtifactEditContext(
        { userId: 'user-1', conversationId: 'conversation-1' },
        { getMessages },
      ),
    ).resolves.toBe(
      `Current editable artifact revisions (pass the token unchanged to edit_artifact):\n- identifier="report" expected_sha256="${sha256('# Report')}"\n- identifier="dashboard" expected_sha256="${sha256('new')}"`,
    );
  });

  test('binds tool execution to the authenticated request conversation', async () => {
    const source = 'const colour = "blue";';
    const message = {
      messageId: 'assistant-1',
      conversationId: 'conversation-1',
      text: artifact('dashboard', source),
    };
    const compareAndSwap = jest.fn().mockResolvedValue(true);
    const tool = createEditArtifactTool({
      req: { user: { id: 'user-1' }, body: { conversationId: 'conversation-1' } },
      getMessages: jest.fn().mockResolvedValue([message]),
      compareAndSwap,
    });

    expect(tool.returnDirect).toBe(true);

    const output = JSON.parse(
      await tool.invoke({
        identifier: 'dashboard',
        expected_sha256: sha256(source),
        replacements: [{ old: '"blue"', new: '"cyan"' }],
      }),
    );

    expect(output).toEqual(expect.objectContaining({ status: 'updated', identifier: 'dashboard' }));
    expect(compareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conversation-1',
      }),
    );
  });

  test('does not wait for Mongoose search-index middleware after the atomic write', async () => {
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const modelUpdateOne = jest.fn();

    await expect(
      compareAndSwapMessage(
        {
          userId: 'user-1',
          conversationId: 'conversation-1',
          messageId: 'assistant-1',
          source: 'text',
          original: 'before',
          updated: 'after',
        },
        { collection: { updateOne }, updateOne: modelUpdateOne },
      ),
    ).resolves.toBe(true);

    expect(updateOne).toHaveBeenCalledWith(
      {
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'assistant-1',
        text: 'before',
      },
      { $set: { text: 'after', updatedAt: expect.any(Date), _meiliIndex: false } },
    );
    expect(modelUpdateOne).not.toHaveBeenCalled();
  });
});

const {
  applyArtifactEdit,
  buildArtifactEditContext,
  createEditArtifactTool,
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
        updated: expect.stringContaining('const colour = "cyan";'),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'updated',
        identifier: 'dashboard',
        messageId: 'assistant-2',
        replacements: 1,
        contentSha256: sha256('const colour = "cyan";'),
      }),
    );
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
});

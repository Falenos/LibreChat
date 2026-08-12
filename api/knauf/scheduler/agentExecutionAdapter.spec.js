'use strict';

const { ReadableStream } = require('node:stream/web');
const {
  createAgentExecutionAdapter,
  createRunResult,
  parseSseEvent,
} = require('./agentExecutionAdapter');
const { verifySchedulerRequest } = require('./internalRequest');

const agentSnapshot = {
  id: 'agent-1',
  author: 'user-1',
  version: 2,
  provider: 'openAI',
  model: 'gpt-4.1',
  instructions: 'Pinned instructions',
};
const resolveAgent = jest.fn().mockResolvedValue({ snapshot: agentSnapshot });

const streamResponse = (events) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(events));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

describe('scheduled agent HTTP adapter', () => {
  test('parses named SSE events', () => {
    expect(parseSseEvent('event: message\ndata: {"final":true}')).toEqual({
      eventName: 'message',
      data: { final: true },
    });
  });

  test.each([
    [
      'structured top-level errors',
      { error: { message: 'provider unavailable' }, responseMessage: { text: '' } },
      'provider unavailable',
    ],
    [
      'response message errors',
      { responseMessage: { error: true, text: 'model failed' } },
      'model failed',
    ],
    [
      'the agents error-controller final event',
      { conversation: { conversationId: 'conversation-1' } },
      'scheduled agent request failed',
    ],
  ])('classifies %s as failures', (_name, event, message) => {
    expect(() => createRunResult(event, 'fallback')).toThrow(message);
  });

  test('keeps a successful empty response as success', () => {
    expect(
      createRunResult(
        {
          conversation: { conversationId: 'conversation-1' },
          responseMessage: { messageId: 'message-1', text: '' },
        },
        'fallback',
      ),
    ).toEqual({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      responsePreview: '',
    });
  });

  test('classifies unfinished responses as interrupted rather than failed', () => {
    expect(
      createRunResult(
        {
          conversation: { conversationId: 'conversation-1' },
          responseMessage: { unfinished: true },
        },
        'fallback',
      ),
    ).toEqual({ status: 'interrupted', conversationId: 'conversation-1' });
  });

  test('starts an authenticated agent run and returns a bounded final result', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 'conversation-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse(
          'event: message\ndata: {"final":true,"title":"Daily result","conversation":{"conversationId":"conversation-1"},"responseMessage":{"messageId":"message-1","text":"Finished"}}\n\n',
        ),
      );
    const getProject = jest.fn().mockResolvedValue({ id: 'project-1' });
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal/',
      getUserById: jest
        .fn()
        .mockResolvedValue({ _id: 'user-1', name: 'Ada', tenantId: 'tenant-1' }),
      generateToken: jest.fn().mockResolvedValue('jwt-token'),
      getProject,
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    const result = await execute({
      run: {
        ownerId: 'user-1',
        agentId: 'agent-1',
        prompt: 'Prepare the daily report',
        timezone: 'Europe/Berlin',
        conversationId: 'conversation-preallocated',
        chatProjectId: 'project-1',
      },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      title: 'Daily result',
      responsePreview: 'Finished',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://api.internal/api/agents/chat/agents',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'User-Agent': expect.stringContaining('Mozilla/5.0'),
          'x-knauf-scheduler-signature': expect.any(String),
          'x-knauf-scheduler-timestamp': expect.any(String),
          'x-knauf-scheduler-trigger': 'automatic',
        }),
      }),
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      text: 'Prepare the daily report',
      agent_id: 'agent-1',
      conversationId: 'conversation-preallocated',
      timezone: 'Europe/Berlin',
      chatProjectId: 'project-1',
      knaufAgentSnapshot: agentSnapshot,
    });
    expect(getProject).toHaveBeenCalledWith('user-1', 'project-1');
  });

  test('surfaces stream errors', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 'conversation-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        streamResponse('event: error\ndata: {"error":"provider unavailable"}\n\n'),
      );
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn().mockResolvedValue('jwt-token'),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('provider unavailable');
  });

  test('resumes a recovered agent job without starting a second generation', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        streamResponse(
          'event: message\ndata: {"final":true,"conversation":{"conversationId":"conversation-1"},"responseMessage":{"messageId":"message-1","text":"Recovered"}}\n\n',
        ),
      );
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn().mockResolvedValue('resume-token'),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
          conversationId: 'conversation-1',
          recovered: true,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      responsePreview: 'Recovered',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api.internal/api/agents/chat/stream/conversation-1?resume=true',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer resume-token' }),
      }),
    );
    const streamHeaders = fetchImpl.mock.calls[0][1].headers;
    expect(
      verifySchedulerRequest(
        {
          get: (name) => streamHeaders[name] ?? streamHeaders[name.toLowerCase()],
          method: 'GET',
          originalUrl: '/api/agents/chat/stream/conversation-1?resume=true',
          user: { id: 'user-1' },
        },
        { secret: 'test-secret' },
      ),
    ).toEqual({ trigger: 'automatic' });
  });

  test('does not replace a recovered agent job that is no longer resumable', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Stream not found' }), { status: 404 }),
      );
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn().mockResolvedValue('resume-token'),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
          conversationId: 'conversation-1',
          recovered: true,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: 'interrupted',
      conversationId: 'conversation-1',
      interruptionReason: 'agent_job_unavailable_after_recovery',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('treats a stream ending without a final event as interrupted', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 'conversation-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(streamResponse('event: message\ndata: {"final":false}\n\n'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn().mockResolvedValue('jwt-token'),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: 'interrupted',
      conversationId: 'conversation-1',
      interruptionReason: 'agent_stream_incomplete',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://api.internal/api/agents/chat/abort',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ streamId: 'conversation-1' }),
      }),
    );
  });

  test('aborts the generation job when its execution lease is lost', async () => {
    const controller = new AbortController();
    const leaseError = new Error('execution lease lost');
    const generateToken = jest
      .fn()
      .mockResolvedValueOnce('start-token')
      .mockResolvedValueOnce('stream-token')
      .mockResolvedValueOnce('abort-token');
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 'conversation-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementationOnce(async () => {
        controller.abort(leaseError);
        throw leaseError;
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken,
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow('execution lease lost');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'http://api.internal/api/agents/chat/abort',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ streamId: 'conversation-1' }),
      }),
    );
    expect(fetchImpl.mock.calls[2][1].headers).toMatchObject({
      Authorization: 'Bearer abort-token',
      'User-Agent': expect.stringContaining('Mozilla/5.0'),
    });
    expect(generateToken).toHaveBeenCalledTimes(3);
  });

  test('bounds abort cleanup so an unresponsive API cannot block execution shutdown', async () => {
    const logger = { warn: jest.fn() };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ streamId: 'conversation-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(streamResponse('event: message\ndata: {"final":false}\n\n'))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
      );
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn().mockResolvedValue('jwt-token'),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1' }),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
      abortCleanupTimeoutMs: 10,
      logger,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: 'interrupted',
      interruptionReason: 'agent_stream_incomplete',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('abort cleanup failed for conversation-1'),
    );
  });

  test('requires an internal scheduler signing secret', () => {
    expect(() =>
      createAgentExecutionAdapter({
        apiBaseUrl: 'http://api.internal',
        getUserById: jest.fn(),
        generateToken: jest.fn(),
        getProject: jest.fn(),
        resolveAgent,
      }),
    ).toThrow('internalSecret');
  });

  test('does not start a conversation when the selected project no longer exists', async () => {
    const fetchImpl = jest.fn();
    const execute = createAgentExecutionAdapter({
      apiBaseUrl: 'http://api.internal',
      getUserById: jest.fn().mockResolvedValue({ _id: 'user-1' }),
      generateToken: jest.fn(),
      getProject: jest.fn().mockResolvedValue(null),
      resolveAgent,
      internalSecret: 'test-secret',
      fetchImpl,
    });

    await expect(
      execute({
        run: {
          ownerId: 'user-1',
          agentId: 'agent-1',
          prompt: 'Run',
          chatProjectId: 'project-1',
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Scheduled chat project no longer exists');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const { EventEmitter } = require('events');

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  createJob: jest.fn(),
  emitError: jest.fn(),
  completeJob: jest.fn(),
  getResumeState: jest.fn(),
  updateMetadata: jest.fn(),
  // [knauf] Preserve the captured generation context in controller tests.
  runWithGeneration: jest.fn((_streamId, _generationId, callback) => callback()),
  // End [knauf]
};

const mockCheckAndIncrementPendingRequest = jest.fn();
const mockDecrementPendingRequest = jest.fn();
const mockFilterPersistableAbortContent = jest.fn((content) =>
  content.filter((part) => part?.type !== 'tool_call'),
);
const mockGetConvo = jest.fn();
const mockGetMessages = jest.fn();
const mockSaveMessage = jest.fn();
let mockMCPContexts = new WeakMap();

const mockCreateMCPRequestContext = jest.fn(() => ({
  connections: new Map(),
  pending: new Map(),
  cleanupStarted: false,
  cleanupOnResponse: false,
  responseCleanupAttached: false,
}));
const mockGetMCPRequestContext = jest.fn((req) => {
  if (!req) {
    return undefined;
  }

  let context = mockMCPContexts.get(req);
  if (!context) {
    context = mockCreateMCPRequestContext();
    mockMCPContexts.set(req, context);
  }

  return context.cleanupStarted ? undefined : context;
});
const mockCleanupMCPRequestContext = jest.fn(async (context) => {
  if (!context || context.cleanupStarted) {
    return;
  }

  context.cleanupStarted = true;
  const connections = new Set(context.connections.values());
  const settled = await Promise.allSettled(context.pending.values());
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      connections.add(result.value);
    }
  }

  await Promise.allSettled(Array.from(connections).map((connection) => connection.disconnect?.()));
  context.connections.clear();
  context.pending.clear();
});
const mockCleanupMCPRequestContextForReq = jest.fn(async (req) => {
  const context = mockMCPContexts.get(req);
  if (!context) {
    return;
  }

  try {
    await mockCleanupMCPRequestContext(context);
  } finally {
    mockMCPContexts.delete(req);
  }
});

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  // [knauf] Exercise the stable conflict response without loading the real package.
  GENERATION_CONFLICT_CODE: 'generation_already_running',
  // End [knauf]
  sendEvent: jest.fn(),
  getViolationInfo: jest.fn(),
  buildMessageFiles: jest.fn(() => []),
  resolveTitleTiming: jest.fn(() => 'immediate'),
  GenerationJobManager: mockGenerationJobManager,
  getReferencedQuotes: jest.fn((quotes) => {
    if (!Array.isArray(quotes)) {
      return null;
    }
    const normalized = quotes
      .filter((quote) => typeof quote === 'string' && quote.trim().length > 0)
      .map((quote) => quote.trim());
    return normalized.length > 0 ? normalized : null;
  }),
  cleanupMCPRequestContext: (...args) => mockCleanupMCPRequestContext(...args),
  createMCPRequestContext: (...args) => mockCreateMCPRequestContext(...args),
  getMCPRequestContext: (...args) => mockGetMCPRequestContext(...args),
  filterPersistableAbortContent: (...args) => mockFilterPersistableAbortContent(...args),
  cleanupMCPRequestContextForReq: (...args) => mockCleanupMCPRequestContextForReq(...args),
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeMessageForTransmit: jest.fn((message) => message),
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  isUnpersistedPreliminaryParent: async ({
    userId,
    conversationId,
    parentMessageId,
    getMessages,
  }) => {
    if (typeof parentMessageId !== 'string' || !parentMessageId.endsWith('_')) {
      return false;
    }

    const filter = { user: userId, messageId: parentMessageId };
    if (conversationId && conversationId !== 'new') {
      filter.conversationId = conversationId;
    }

    const messages = await getMessages(filter, '_id');
    return messages.length === 0;
  },
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: {
    set: jest.fn(),
  },
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(() => Promise.resolve()),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: (...args) => mockGetConvo(...args),
}));

const AgentController = require('../request');
const { getMCPRequestContext } = require('~/server/services/MCPRequestContext');

function createResumableResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.finished = false;
  res.destroyed = false;
  res.json = jest.fn(() => {
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    res.emit('finish');
    return res;
  });
  res.status = jest.fn(() => res);
  return res;
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ResumableAgentController resume metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMCPContexts = new WeakMap();
    mockCheckAndIncrementPendingRequest.mockResolvedValue({ allowed: true });
    mockDecrementPendingRequest.mockResolvedValue(undefined);
    mockGetConvo.mockResolvedValue({ createdAt: '2026-06-07T00:00:00.000Z' });
    mockGetMessages.mockImplementation((filter) => {
      if (filter?.$or) {
        const parentMessageId = filter.$or[0]?.messageId;
        return Promise.resolve([
          {
            messageId: parentMessageId,
            parentMessageId: 'parent-user',
            isCreatedByUser: false,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    mockGenerationJobManager.createJob.mockResolvedValue({
      generationId: 'generation-1',
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: { on: jest.fn() },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue(null);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.emitError.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue({});
  });

  it('rejects an underscore-suffixed parent that is not persisted', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up too early.',
        messageId: 'follow-up-user',
        parentMessageId: 'pending-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'pending-response_', conversationId },
      '_id',
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('selected parent response is still being saved'),
      }),
    );
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('allows an underscore-suffixed parent when it is already persisted', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockImplementation((filter) => {
      if (filter?.$or) {
        return Promise.resolve([
          {
            messageId: 'persisted-response_',
            parentMessageId: 'parent-user',
            isCreatedByUser: false,
          },
        ]);
      }
      return Promise.resolve([{ _id: 'persisted-parent' }]);
    });
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Follow up to persisted underscore id.',
        messageId: 'follow-up-user',
        parentMessageId: 'persisted-response_',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: 'user-123', messageId: 'persisted-response_', conversationId },
      '_id',
    );
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
    );
  });

  // [knauf] Reject accidental second roots while allowing an idempotent root retry.
  it('rejects a new root for a conversation that already has a different root', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'existing-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
      },
    ]);
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Accidental second root',
        messageId: 'new-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      {
        user: 'user-123',
        conversationId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      },
      'messageId isCreatedByUser',
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'conversation_root_conflict',
      error: 'Conversation history changed. Reload the conversation and try again.',
    });
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('allows retrying the existing root with the same message ID', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'existing-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
      },
    ]);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after root guard'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry existing root',
        messageId: 'existing-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
    );
  });

  it('allows an explicit edit to replace an existing root', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'existing-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        isCreatedByUser: true,
      },
    ]);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after history guard'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Edited root',
        messageId: 'replacement-root',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        conversationId,
        isEdited: true,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
    );
  });

  it('rejects an ordinary send from a parent that already has a different child', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'existing-response',
        parentMessageId: 'existing-user',
        isCreatedByUser: false,
      },
      {
        messageId: 'existing-child',
        parentMessageId: 'existing-response',
        isCreatedByUser: true,
      },
    ]);
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Stale sibling',
        messageId: 'new-child',
        parentMessageId: 'existing-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGetMessages).toHaveBeenCalledWith(
      {
        user: 'user-123',
        conversationId,
        $or: [{ messageId: 'existing-response' }, { parentMessageId: 'existing-response' }],
      },
      'messageId parentMessageId isCreatedByUser',
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'conversation_history_conflict',
      error: 'Conversation history changed. Reload the conversation and try again.',
    });
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });

  it('allows an idempotent retry of the existing child message', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'existing-response',
        parentMessageId: 'existing-user',
        isCreatedByUser: false,
      },
      {
        messageId: 'retry-child',
        parentMessageId: 'existing-response',
        isCreatedByUser: true,
      },
    ]);
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after history guard'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Retry child',
        messageId: 'retry-child',
        parentMessageId: 'existing-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockCheckAndIncrementPendingRequest).toHaveBeenCalledWith('user-123');
    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      conversationId,
      'user-123',
      conversationId,
    );
  });

  it('rejects an ordinary send when its selected parent is missing', async () => {
    const conversationId = 'conversation-123';
    mockGetMessages.mockResolvedValue([]);
    const initializeClient = jest.fn();
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Missing parent',
        messageId: 'new-child',
        parentMessageId: 'missing-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'conversation_history_conflict',
      error: 'Conversation history changed. Reload the conversation and try again.',
    });
    expect(mockCheckAndIncrementPendingRequest).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });
  // End [knauf]

  it('stores the in-flight turn before MCP initialization can emit OAuth', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Check Google Workspace availability.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/spec-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        conversationId,
        endpoint: 'agents',
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-3.5-turbo',
        responseMessageId: 'follow-up-user_',
        userMessage: {
          messageId: 'follow-up-user',
          parentMessageId: 'original-response',
          conversationId,
          text: 'Check Google Workspace availability.',
        },
      }),
      'generation-1',
    );
    expect(mockGenerationJobManager.updateMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      initializeClient.mock.invocationCallOrder[0],
    );
    // [knauf] KK20-338 — client.js's chatCompletion() reads this to join Model Router
    // telemetry to the same logical generation as GenerationJobManager/SSE telemetry.
    expect(req._resumableStreamId).toBe(conversationId);
    expect(req._resumableGenerationId).toBe('generation-1');
    // End [knauf]
  });

  // [knauf] A rejected overlapping request must not terminate the existing owner.
  it('returns 409 without completing the generation that already owns the conversation', async () => {
    const conflict = Object.assign(new Error('A generation is already running'), {
      code: 'generation_already_running',
    });
    mockGenerationJobManager.createJob.mockRejectedValue(conflict);
    const initializeClient = jest.fn();
    const conversationId = 'conversation-123';
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Overlapping turn',
        messageId: 'overlapping-user-message',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: { endpoint: 'agents' },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'generation_already_running',
      error: 'A generation is already running',
    });
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(initializeClient).not.toHaveBeenCalled();
  });
  // End [knauf]

  it('keeps request-scoped MCP connections until resumable initialization finishes', async () => {
    const conversationId = 'conversation-123';
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const initializeClient = jest.fn(async ({ req, res }) => {
      const context = getMCPRequestContext(req, res);
      context.connections.set('mcp-server', { disconnect });

      await nextTick();
      expect(disconnect).not.toHaveBeenCalled();

      throw new Error('stop after request-scoped MCP connection');
    });
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use a BODY-scoped MCP server.',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          modelOptions: { model: 'gpt-4.1' },
        },
      },
      config: {},
    };
    const res = createResumableResponse();

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(res.json).toHaveBeenCalledWith({
      streamId: conversationId,
      conversationId,
      status: 'started',
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockDecrementPendingRequest.mock.invocationCallOrder[0],
    );
  });

  it('stores model spec icon fallbacks and agent ids in early resume metadata', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the resume spec.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        iconURL: 'https://example.com/preset-icon.png',
        model: 'agent_resume_spec',
      }),
      'generation-1',
    );
  });

  it('falls back to the model spec preset endpoint when no icon URL is configured', async () => {
    const conversationId = 'conversation-123';
    const initializeClient = jest.fn().mockRejectedValue(new Error('stop before tool loading'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use the endpoint icon.',
        messageId: 'follow-up-user',
        parentMessageId: 'original-response',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'endpoint-icon-spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'endpoint-icon-spec',
              preset: {
                endpoint: 'anthropic',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);

    expect(mockGenerationJobManager.updateMetadata).toHaveBeenCalledWith(
      conversationId,
      expect.objectContaining({
        iconURL: 'anthropic',
        model: 'gpt-4.1',
      }),
      'generation-1',
    );
  });

  // [knauf] Partial-response persistence. The cross-replica transport test proves the departure
  // notification reaches the generating replica; these prove what that notification is worth,
  // and that a provider failure can no longer win the race against it. The provider fails inside
  // the running generation, never at initialization, because the generation catch is the path
  // that clears the job's content.

  /**
   * A generation that is really running: initializeClient resolves a client whose sendMessage
   * stays pending until the test fails it, so the failure takes the provider-error path inside
   * the generation. The captured departure handler is what the transport delivers to the
   * generating replica, whichever replica served the SSE.
   */
  function armRunningGeneration() {
    const captured = {};
    mockGenerationJobManager.createJob.mockResolvedValue({
      generationId: 'generation-1',
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            captured.allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    let failProvider;
    const providerGate = new Promise((_resolve, reject) => {
      failProvider = reject;
    });
    const client = { sender: 'AI', options: {}, sendMessage: jest.fn(() => providerGate) };
    const initializeClient = jest.fn().mockResolvedValue({ client });
    return { captured, client, failProvider, initializeClient };
  }

  function buildGenerationRequest(conversationId, text) {
    return {
      user: { id: 'user-123' },
      body: {
        text,
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: { endpoint: 'agents', modelOptions: { model: 'gpt-4.1' } },
      },
      config: {},
    };
  }

  function buildSentResponse() {
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };
    return res;
  }

  function resumeStateFor(conversationId, text, aggregatedContent) {
    return {
      conversationId,
      responseMessageId: 'response-message',
      model: 'gpt-4.1',
      aggregatedContent,
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text,
      },
    };
  }

  async function waitFor(condition, description) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) {
        return;
      }
      await nextTick();
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  function partialSavesSince(savesBefore) {
    return mockSaveMessage.mock.calls
      .slice(savesBefore)
      .filter(([, payload]) => payload?.messageId === 'response-message');
  }

  /** invocationCallOrder of the one partial save, for ordering against completeJob. */
  function partialSaveOrder() {
    const index = mockSaveMessage.mock.calls.findIndex(
      ([, payload]) => payload?.messageId === 'response-message',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return mockSaveMessage.mock.invocationCallOrder[index];
  }

  it('filters OAuth prompts before saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      generationId: 'generation-1',
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      iconURL: 'https://example.com/spec-icon.png',
      model: 'gpt-4.1',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use Google Workspace',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use Google Workspace',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          iconURL: 'https://example.com/fallback-icon.png',
          modelOptions: { model: 'gpt-3.5-turbo' },
        },
      },
      config: {},
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    const oauthPart = {
      type: 'tool_call',
      tool_call: {
        name: 'oauth_mcp_Google-Workspace',
        auth: 'https://auth.example.com/oauth',
      },
    };
    const textPart = { type: 'text', text: 'Partial response...' };

    await allSubscribersLeftHandler([oauthPart, textPart]);

    expect(mockFilterPersistableAbortContent).toHaveBeenCalledWith([oauthPart, textPart]);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/spec-icon.png',
        model: 'gpt-4.1',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
  });

  it('persists the partial response exactly once when the generation fails after a disconnect', async () => {
    const conversationId = 'conversation-456';
    const { captured, client, failProvider, initializeClient } = armRunningGeneration();
    const textPart = { type: 'text', text: 'Partial answer the user watched stream in.' };
    mockGenerationJobManager.getResumeState.mockResolvedValue(
      resumeStateFor(conversationId, 'Summarise this', [textPart]),
    );

    await AgentController(
      buildGenerationRequest(conversationId, 'Summarise this'),
      buildSentResponse(),
      jest.fn(),
      initializeClient,
      null,
    );
    await waitFor(() => client.sendMessage.mock.calls.length === 1, 'the provider call');
    expect(captured.allSubscribersLeftHandler).toEqual(expect.any(Function));
    const savesBefore = mockSaveMessage.mock.calls.length;

    // 1. The last viewer leaves mid-generation and the departure is fully verified and saved.
    await captured.allSubscribersLeftHandler([textPart]);
    expect(partialSavesSince(savesBefore)).toHaveLength(1);

    // 2. Only now does the provider fail. The error path finds the row written and writes nothing.
    failProvider(new Error('provider unavailable'));
    await waitFor(
      () => mockGenerationJobManager.completeJob.mock.calls.length === 1,
      'completeJob after the provider failure',
    );

    const partialSaves = partialSavesSince(savesBefore);
    expect(partialSaves).toHaveLength(1);
    expect(partialSaves[0][1]).toEqual(
      expect.objectContaining({
        content: [textPart],
        messageId: 'response-message',
        parentMessageId: 'user-message',
        conversationId,
        unfinished: true,
      }),
    );

    // A second notification (a retry, or a duplicate departure) must not write again.
    await captured.allSubscribersLeftHandler([textPart]);
    expect(partialSavesSince(savesBefore)).toHaveLength(1);
  });

  it('uses model spec and agent fallbacks when saving partial responses on disconnect', async () => {
    const conversationId = 'conversation-123';
    let allSubscribersLeftHandler;
    mockGenerationJobManager.createJob.mockResolvedValue({
      generationId: 'generation-1',
      createdAt: 1000,
      readyPromise: Promise.resolve(),
      abortController: new AbortController(),
      emitter: {
        on: jest.fn((event, handler) => {
          if (event === 'allSubscribersLeft') {
            allSubscribersLeftHandler = handler;
          }
        }),
      },
    });
    mockGenerationJobManager.getResumeState.mockResolvedValue({
      conversationId,
      responseMessageId: 'response-message',
      userMessage: {
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        text: 'Use fallback metadata',
      },
    });

    const initializeClient = jest.fn().mockRejectedValue(new Error('stop after setup'));
    const req = {
      user: { id: 'user-123' },
      body: {
        text: 'Use fallback metadata',
        messageId: 'user-message',
        parentMessageId: 'parent-message',
        conversationId,
        endpointOption: {
          endpoint: 'agents',
          spec: 'agent-spec',
          agent_id: 'agent_resume_spec',
          model_parameters: { model: 'gpt-4.1' },
        },
      },
      config: {
        modelSpecs: {
          list: [
            {
              name: 'agent-spec',
              preset: {
                endpoint: 'openAI',
                iconURL: 'https://example.com/preset-icon.png',
              },
            },
          ],
        },
      },
    };
    const res = {
      headersSent: true,
      json: jest.fn(() => {
        res.headersSent = true;
      }),
      status: jest.fn(() => res),
    };

    await AgentController(req, res, jest.fn(), initializeClient, null);
    expect(allSubscribersLeftHandler).toEqual(expect.any(Function));

    const textPart = { type: 'text', text: 'Partial response...' };
    await allSubscribersLeftHandler([textPart]);

    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.objectContaining({
        content: [textPart],
        iconURL: 'https://example.com/preset-icon.png',
        model: 'agent_resume_spec',
        messageId: 'response-message',
        parentMessageId: 'user-message',
      }),
      expect.any(Object),
    );
  });
  it('persists exactly once when the provider fails while a remote departure is still verifying', async () => {
    const conversationId = 'conversation-789';
    const { captured, client, failProvider, initializeClient } = armRunningGeneration();
    const textPart = { type: 'text', text: 'Partial answer the user watched stream in.' };
    const resumeState = resumeStateFor(conversationId, 'Summarise this', [textPart]);

    // The departure's lookup is held open: it stands for the Redis verification a remote
    // unsubscribe starts (LEAVE, the hint, the owner's CHECK) while the provider is still running.
    let releaseDeparture;
    const heldLookup = new Promise((resolve) => {
      releaseDeparture = () => resolve(resumeState);
    });
    mockGenerationJobManager.getResumeState
      .mockImplementationOnce(() => heldLookup)
      .mockResolvedValue(resumeState);

    await AgentController(
      buildGenerationRequest(conversationId, 'Summarise this'),
      buildSentResponse(),
      jest.fn(),
      initializeClient,
      null,
    );
    await waitFor(() => client.sendMessage.mock.calls.length === 1, 'the provider call');
    const savesBefore = mockSaveMessage.mock.calls.length;

    // 1. The remote viewer leaves. The owner's departure handler starts and parks on its lookup.
    const departure = captured.allSubscribersLeftHandler([textPart]);
    await waitFor(
      () => mockGenerationJobManager.getResumeState.mock.calls.length === 1,
      'the departure lookup',
    );

    // 2. The provider fails while that verification is still in flight. The error path must not
    //    complete the job, which clears the content, while a save attempt is unresolved.
    failProvider(new Error('provider unavailable'));
    for (let tick = 0; tick < 5; tick += 1) {
      await nextTick();
    }
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
    expect(partialSavesSince(savesBefore)).toHaveLength(0);

    // 3. The departure's verification resolves. One write, then the job completes.
    releaseDeparture();
    await departure;
    await waitFor(
      () => mockGenerationJobManager.completeJob.mock.calls.length === 1,
      'completeJob after the release',
    );

    const partialSaves = partialSavesSince(savesBefore);
    expect(partialSaves).toHaveLength(1);
    expect(partialSaves[0][1]).toEqual(
      expect.objectContaining({ content: [textPart], unfinished: true }),
    );
    expect(partialSaveOrder()).toBeLessThan(
      mockGenerationJobManager.completeJob.mock.invocationCallOrder[0],
    );
  });

  it('persists the error-path partial before completing the job, and a late departure does not write again', async () => {
    const conversationId = 'conversation-987';
    const { captured, client, failProvider, initializeClient } = armRunningGeneration();
    const jobPart = { type: 'text', text: 'Everything streamed before the provider failed.' };
    mockGenerationJobManager.getResumeState.mockResolvedValue(
      resumeStateFor(conversationId, 'Summarise this', [jobPart]),
    );

    await AgentController(
      buildGenerationRequest(conversationId, 'Summarise this'),
      buildSentResponse(),
      jest.fn(),
      initializeClient,
      null,
    );
    await waitFor(() => client.sendMessage.mock.calls.length === 1, 'the provider call');
    const savesBefore = mockSaveMessage.mock.calls.length;

    // The viewer is still attached when the provider fails: no departure has happened at all.
    failProvider(new Error('provider unavailable'));
    await waitFor(
      () => mockGenerationJobManager.completeJob.mock.calls.length === 1,
      'completeJob after the provider failure',
    );

    // The error path itself wrote the job's current parts, before completeJob cleared them.
    const partialSaves = partialSavesSince(savesBefore);
    expect(partialSaves).toHaveLength(1);
    expect(partialSaves[0][1]).toEqual(
      expect.objectContaining({
        content: [jobPart],
        messageId: 'response-message',
        parentMessageId: 'user-message',
        conversationId,
        unfinished: true,
        error: false,
      }),
    );
    expect(partialSaves[0][2]).toEqual(
      expect.objectContaining({ context: expect.stringContaining('provider error') }),
    );
    expect(partialSaveOrder()).toBeLessThan(
      mockGenerationJobManager.completeJob.mock.invocationCallOrder[0],
    );

    // A departure hint that lands after completion must not write again.
    await captured.allSubscribersLeftHandler([jobPart]);
    expect(partialSavesSince(savesBefore)).toHaveLength(1);
  });
  // End [knauf]
});

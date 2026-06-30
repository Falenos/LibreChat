const {
  aggregateConversationCosts,
  calculateTransactionCost,
  COST_LOOKUP_INDEX,
  COST_LOOKUP_INDEX_NAME,
  getConversationCosts,
  normalizeModel,
} = require('./costs');

function chain(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

function createCache(initialValue) {
  return {
    get: jest.fn().mockResolvedValue(initialValue),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

describe('knauf costs', () => {
  it('normalizes AGK gpt-54 deployment names to gpt-5.4', () => {
    expect(normalizeModel('gpt-54')).toBe('gpt-5.4');
    expect(normalizeModel('azure/gpt-5.4')).toBe('gpt-5.4');
  });

  it('calculates gpt-5.4 input and output cost from negative transaction tokens', () => {
    const input = calculateTransactionCost({
      model: 'gpt-54',
      tokenType: 'prompt',
      rawAmount: -1_000_000,
    });
    const output = calculateTransactionCost({
      model: 'gpt-54',
      tokenType: 'completion',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(1.9567367651485807);
    expect(output.cost).toBeCloseTo(11.740420590891492);
  });

  it('uses discounted cached input rate for read tokens', () => {
    const result = calculateTransactionCost({
      model: 'gpt-54',
      tokenType: 'prompt',
      inputTokens: -1_000_000,
      readTokens: -1_000_000,
    });

    expect(result.inputTokens).toBe(1_000_000);
    expect(result.cachedInputTokens).toBe(1_000_000);
    expect(result.cost).toBeCloseTo(2.152410441663439);
  });

  it('aggregates per conversation and per message', () => {
    const result = aggregateConversationCosts([
      {
        model: 'gpt-54',
        tokenType: 'prompt',
        rawAmount: -1_000_000,
        messageId: 'm1',
      },
      {
        model: 'gpt-54',
        tokenType: 'completion',
        rawAmount: -1_000_000,
        messageId: 'm1',
      },
    ]);

    expect(result.currency).toBe('EUR');
    expect(result.conversation.cost).toBeCloseTo(13.697157356040073);
    expect(result.messages.m1.cost).toBeCloseTo(13.697157356040073);
  });

  it('tracks unsupported image tokens without assigning an unverified EUR cost', () => {
    const result = calculateTransactionCost({
      model: 'gpt-image-1',
      tokenType: 'completion',
      rawAmount: -4000,
    });

    expect(result.cost).toBe(0);
    expect(result.imageOutputTokens).toBe(4000);
    expect(result.hasUnsupported).toBe(true);
  });

  it('returns cached aggregate when the transaction fingerprint is unchanged', async () => {
    const summary = aggregateConversationCosts([]);
    const Transaction = {
      collection: { createIndex: jest.fn().mockResolvedValue(COST_LOOKUP_INDEX_NAME) },
      countDocuments: jest.fn(),
      findOne: jest.fn(() =>
        chain({ _id: 'tx-latest', updatedAt: new Date('2026-06-26T10:00:00.000Z') }),
      ),
      find: jest.fn(),
    };
    const cache = createCache({
      fingerprint: {
        latestTransactionId: 'tx-latest',
        latestUpdatedAt: '2026-06-26T10:00:00.000Z',
      },
      summary,
    });

    const result = await getConversationCosts({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction,
      cache,
    });

    expect(result).toBe(summary);
    expect(Transaction.collection.createIndex).toHaveBeenCalledWith(COST_LOOKUP_INDEX, {
      name: COST_LOOKUP_INDEX_NAME,
    });
    expect(Transaction.countDocuments).not.toHaveBeenCalled();
    expect(Transaction.find).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('refreshes and caches aggregate when the transaction fingerprint changes', async () => {
    const Transaction = {
      countDocuments: jest.fn(),
      findOne: jest.fn(() =>
        chain({ _id: 'tx-new', updatedAt: new Date('2026-06-26T10:00:00.000Z') }),
      ),
      find: jest.fn(() =>
        chain([
          {
            model: 'gpt-54',
            tokenType: 'prompt',
            rawAmount: -1_000_000,
            messageId: 'message-1',
          },
        ]),
      ),
    };
    const cache = createCache({
      fingerprint: { latestTransactionId: 'tx-old', latestUpdatedAt: null },
      summary: aggregateConversationCosts([]),
    });

    const result = await getConversationCosts({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction,
      cache,
    });

    expect(Transaction.countDocuments).not.toHaveBeenCalled();
    expect(Transaction.find).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
    });
    expect(result.conversation.cost).toBeCloseTo(1.9567367651485807);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('conversation-1'),
      expect.objectContaining({
        fingerprint: {
          latestTransactionId: 'tx-new',
          latestUpdatedAt: '2026-06-26T10:00:00.000Z',
        },
        summary: result,
      }),
      expect.any(Number),
    );
  });
});

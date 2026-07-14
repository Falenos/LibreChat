const {
  aggregateConversationCosts,
  calculateTransactionCost,
  COST_LOOKUP_INDEX,
  COST_LOOKUP_INDEX_NAME,
  EUR_RATES,
  getConversationCosts,
  normalizeModel,
  RATE_SOURCE,
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
  it.each([
    ['gpt-5-mini-2025-08-07', 'gpt-5-mini'],
    ['azure/gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'],
    ['gpt-54', 'gpt-5.4'],
    ['gpt-55-2026-04-24', 'gpt-5.5'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeModel(input)).toBe(expected);
  });

  it.each([
    ['gpt-5-mini', 0.2194, 1.7552],
    ['gpt-5.4-mini', 0.6582, 3.9491],
    ['gpt-5.4', 2.1939, 13.1637],
    ['gpt-5.5', 4.3879, 26.3273],
  ])('calculates %s input and output prices', (model, inputPrice, outputPrice) => {
    const input = calculateTransactionCost({
      model,
      tokenType: 'prompt',
      rawAmount: -1_000_000,
    });
    const output = calculateTransactionCost({
      model,
      tokenType: 'completion',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(inputPrice);
    expect(output.cost).toBeCloseTo(outputPrice);
  });

  it('stores effective model versions with the static retail rates', () => {
    expect(RATE_SOURCE).toBe('azure-retail-eur-swedencentral-global-2026-07-14');
    expect(EUR_RATES['gpt-5.5']).toMatchObject({
      modelVersion: '2026-04-24',
      effectiveFrom: '2026-05-01',
    });
  });

  it('counts cache reads at the standard input rate', () => {
    const result = calculateTransactionCost({
      model: 'gpt-54',
      tokenType: 'prompt',
      inputTokens: -1_000_000,
      readTokens: -1_000_000,
    });

    expect(result.inputTokens).toBe(1_000_000);
    expect(result.cachedInputTokens).toBe(1_000_000);
    expect(result.cost).toBeCloseTo(4.3878);
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
    expect(result.conversation.cost).toBeCloseTo(15.3576);
    expect(result.messages.m1.cost).toBeCloseTo(15.3576);
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
    expect(result.conversation.cost).toBeCloseTo(2.1939);
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
